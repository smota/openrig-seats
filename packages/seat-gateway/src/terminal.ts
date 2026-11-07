import { createRequire } from "node:module";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { openTerminal, terminalUiEnabled, type DaemonClient, type TerminalSocket } from "@openrig-seats/seat-source-openrig";

/** Validate after WHATWG normalization so dot segments and backslashes cannot reach another route. */
export function terminalUpgradeUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw, "http://127.0.0.1");
    return /^\/terminal\/[^/]+$/.test(url.pathname) ? url : undefined;
  } catch { return; }
}

export interface TerminalConfig {
  enabled: boolean;
  /** Fixed non-seat principal, sent as x-openrig-session. Never copied from a client. */
  principal?: string;
  maxViewers: number;
  maxFrameBytes: number;
}

/** Explicit input allowlist. Reconstruct instead of forwarding an object containing extra input fields. */
export const MAX_SCROLL_OFFSET = 10_000;
export const SCROLL_MIN_GAP_MS = 100;
export const SCROLL_INFLIGHT_TIMEOUT_MS = 2000;
/** A scroll slot is released by output no sooner than this after the scroll was sent. */
export const SCROLL_MIN_RELEASE_MS = 150;
/** Forwarded scrolls across all viewers per sliding second. */
export const SCROLL_GLOBAL_PER_SECOND = 20;

/** Offsets above MAX_SCROLL_OFFSET are clamped: the daemon only paints one window of rows, but capture-pane reads offset+rows lines. */
export function scrollFrame(raw: string): string | undefined {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return;
    const msg = v as Record<string, unknown>;
    if (msg.type !== "scroll" || typeof msg.offset !== "number" || !Number.isInteger(msg.offset) || msg.offset < 0) return;
    return JSON.stringify({ type: "scroll", offset: Math.min(msg.offset, MAX_SCROLL_OFFSET) });
  } catch { return; }
}

export interface TerminalSocketServer {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, callback: (socket: TerminalSocket) => void): void;
  close(): void;
}
const { WebSocketServer } = createRequire(import.meta.url)("ws") as {
  WebSocketServer: new (opts: { noServer: true; maxPayload: number; perMessageDeflate: false; clientTracking: false; autoPong: false }) => TerminalSocketServer;
};
type Seat = Record<string, unknown>;
const extension = (seat: Seat): Record<string, unknown> => typeof seat["x-openrig"] === "object" && seat["x-openrig"] !== null ? seat["x-openrig"] as Record<string, unknown> : {};

/** One bounded upstream subscription per viewer, including pending handshakes in the viewer budget. */
export class TerminalBridge {
  private readonly viewers = new Set<() => void>();
  private readonly server: TerminalSocketServer;
  private stopped = false;
  private readonly scrollTimes: number[] = [];
  constructor(private readonly opts: { config: TerminalConfig; daemon: DaemonClient; daemonUrl: string; daemonToken?: string; seats: () => Seat[]; /** True once the seat store has synced at least once. */ synced: () => boolean; socketServer?: TerminalSocketServer; connect?: typeof openTerminal }) {
    this.server = opts.socketServer ?? new WebSocketServer({ noServer: true, maxPayload: opts.config.maxFrameBytes, perMessageDeflate: false, clientTracking: false, autoPong: false });
  }

  async enabled(signal?: AbortSignal): Promise<boolean> { return this.opts.config.enabled && await terminalUiEnabled(this.opts.daemon, signal); }
  private seat(id: string): Seat | undefined { return this.opts.seats().find((s) => s.id === id); }
  async authorize(id: string, signal?: AbortSignal): Promise<{ status: number; session?: string }> {
    if (!await this.enabled(signal)) return { status: 404 };
    const principal = this.opts.config.principal;
    if (!principal || !this.opts.synced() || this.opts.seats().some((s) => s.name === principal || extension(s).sessionName === principal)) return { status: 403 };
    const seat = this.seat(id);
    const session = seat && extension(seat).sessionName;
    return typeof session === "string" && session ? { status: 204, session } : { status: 404 };
  }

  /** `authenticate` runs the same Hono middleware used by all ordinary gateway routes. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, authenticate: (signal: AbortSignal) => Promise<Response>): void {
    let refused = false;
    const refuse = (status: number) => { refused = true; socket.once("error", () => socket.destroy()); if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy()); };
    if (this.stopped || this.viewers.size >= this.opts.config.maxViewers) { refuse(503); return; }
    const abort = new AbortController();
    let closed = false;
    let downstream: TerminalSocket | undefined;
    let upstream: TerminalSocket | undefined;
    const scrollTimers = new Set<NodeJS.Timeout>();
    const finish = () => {
      if (closed) return;
      closed = true;
      for (const t of scrollTimers) clearTimeout(t);
      scrollTimers.clear();
      abort.abort();
      clearTimeout(timer);
      this.viewers.delete(finish);
      downstream?.terminate();
      upstream?.terminate();
      socket.destroy();
    };
    const timer = setTimeout(finish, 10_000);
    this.viewers.add(finish);
    socket.once("close", finish);
    socket.once("error", finish);
    void (async () => {
      try {
        const response = await authenticate(abort.signal);
        if (closed) return;
        if (response.status !== 204) { await response.body?.cancel().catch(() => {}); refuse(response.status); return; }
        // The authenticated route supplies a gateway-resolved session, never a client query/header.
        const session = response.headers.get("x-seat-terminal-session");
        if (!session) { refuse(404); return; }
        this.server.handleUpgrade(req, socket, head, (client) => {
          downstream = client;
          if (closed) { client.terminate(); return; }
          const max = this.opts.config.maxFrameBytes;
          const send = (peer: TerminalSocket, text: string) => {
            if (peer.readyState !== 1 || Buffer.byteLength(text) > max || peer.bufferedAmount + Buffer.byteLength(text) > max) { finish(); return; }
            peer.send(text, (error) => { if (error) finish(); });
          };
          upstream = (this.opts.connect ?? openTerminal)({ baseUrl: this.opts.daemonUrl, ...(this.opts.daemonToken ? { token: this.opts.daemonToken } : {}), principal: this.opts.config.principal!, session, maxFrameBytes: max });
          const daemon = upstream;
          // Scroll flood control: only the latest offset is kept, one scroll is in flight to the daemon
          // (released by its next output frame or a timeout) and forwarded scrolls are spaced apart.
          let pending: string | undefined;
          let inFlight = false;
          let lastSentAt = -Infinity;
          let gapTimer: NodeJS.Timeout | undefined;
          let releaseTimer: NodeJS.Timeout | undefined;
          const later = (fn: () => void, ms: number) => { const t = setTimeout(() => { scrollTimers.delete(t); fn(); }, ms); scrollTimers.add(t); return t; };
          const pump = () => {
            if (closed || pending === undefined || inFlight || daemon.readyState !== 1 || gapTimer) return;
            const now = Date.now();
            while (this.scrollTimes.length && this.scrollTimes[0]! <= now - 1000) this.scrollTimes.shift();
            const globalWait = this.scrollTimes.length >= SCROLL_GLOBAL_PER_SECOND ? this.scrollTimes[0]! + 1000 - now : 0;
            const wait = Math.max(lastSentAt + SCROLL_MIN_GAP_MS - now, globalWait);
            if (wait > 0) { gapTimer = later(() => { gapTimer = undefined; pump(); }, wait); return; }
            this.scrollTimes.push(now);
            const frame = pending;
            pending = undefined;
            inFlight = true;
            lastSentAt = Date.now();
            releaseTimer = later(() => { releaseTimer = undefined; inFlight = false; pump(); }, SCROLL_INFLIGHT_TIMEOUT_MS);
            send(daemon, frame);
          };
          const release = () => {
            inFlight = false;
            if (releaseTimer) { clearTimeout(releaseTimer); scrollTimers.delete(releaseTimer); releaseTimer = undefined; }
          };
          // Only an output frame arriving at least SCROLL_MIN_RELEASE_MS after the send releases the slot (earlier output
          // is ignored), so a busy pane cannot turn every output frame into another capture. Otherwise the 2 s timeout.
          const onOutput = () => {
            if (inFlight && Date.now() - lastSentAt >= SCROLL_MIN_RELEASE_MS) { release(); pump(); }
          };
          daemon.on("open", () => {
            clearTimeout(timer);
            if (closed) { daemon.terminate(); return; }
            pump();
          });
          client.on("message", (data: Buffer, binary: boolean) => {
            if (closed || binary) return;
            if (data.byteLength > max) { finish(); return; }
            const frame = scrollFrame(data.toString("utf8"));
            if (!frame) return;
            pending = frame;
            pump();
          });
          daemon.on("message", (data: Buffer, binary: boolean) => {
            if (binary || data.byteLength > max) { finish(); return; }
            send(client, data.toString("utf8"));
            onOutput();
          });
          for (const peer of [client, daemon]) {
            peer.on("ping", (data: Buffer) => {
              if (peer.readyState !== 1 || peer.bufferedAmount + data.byteLength + 14 > max) { finish(); return; }
              peer.pong(data, peer === daemon, (error) => { if (error) finish(); });
            });
            peer.on("close", finish);
            peer.on("error", finish);
          }
        });
      } catch { finish(); }
    })().finally(() => { if (!downstream && !closed && !refused) finish(); });
  }

  activeViewers(): number { return this.viewers.size; }
  stop(): void { this.stopped = true; for (const close of this.viewers) close(); this.server.close(); }
}
