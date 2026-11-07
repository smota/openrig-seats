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
export function scrollFrame(raw: string): string | undefined {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return;
    const msg = v as Record<string, unknown>;
    if (msg.type !== "scroll" || typeof msg.offset !== "number" || !Number.isInteger(msg.offset) || msg.offset < 0 || msg.offset > 100_000) return;
    return JSON.stringify({ type: "scroll", offset: msg.offset });
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
  constructor(private readonly opts: { config: TerminalConfig; daemon: DaemonClient; daemonUrl: string; daemonToken?: string; seats: () => Seat[]; socketServer?: TerminalSocketServer; connect?: typeof openTerminal }) {
    this.server = opts.socketServer ?? new WebSocketServer({ noServer: true, maxPayload: opts.config.maxFrameBytes, perMessageDeflate: false, clientTracking: false, autoPong: false });
  }

  async enabled(signal?: AbortSignal): Promise<boolean> { return this.opts.config.enabled && await terminalUiEnabled(this.opts.daemon, signal); }
  private seat(id: string): Seat | undefined { return this.opts.seats().find((s) => s.id === id); }
  async authorize(id: string, signal?: AbortSignal): Promise<{ status: number; session?: string }> {
    if (!await this.enabled(signal)) return { status: 404 };
    const principal = this.opts.config.principal;
    if (!principal || this.opts.seats().some((s) => s.name === principal || extension(s).sessionName === principal)) return { status: 403 };
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
    const finish = () => {
      if (closed) return;
      closed = true;
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
          let earlyScroll: string | undefined;
          const max = this.opts.config.maxFrameBytes;
          const send = (peer: TerminalSocket, text: string) => {
            if (peer.readyState !== 1 || Buffer.byteLength(text) > max || peer.bufferedAmount + Buffer.byteLength(text) > max) { finish(); return; }
            peer.send(text, (error) => { if (error) finish(); });
          };
          upstream = (this.opts.connect ?? openTerminal)({ baseUrl: this.opts.daemonUrl, ...(this.opts.daemonToken ? { token: this.opts.daemonToken } : {}), principal: this.opts.config.principal!, session, maxFrameBytes: max });
          const daemon = upstream;
          daemon.on("open", () => {
            clearTimeout(timer);
            if (closed) { daemon.terminate(); return; }
            if (earlyScroll) send(daemon, earlyScroll);
            earlyScroll = undefined;
          });
          client.on("message", (data: Buffer, binary: boolean) => {
            if (closed || binary) return;
            if (data.byteLength > max) { finish(); return; }
            const frame = scrollFrame(data.toString("utf8"));
            if (!frame) return;
            if (daemon.readyState === 0) earlyScroll = frame; // one conflated, bounded scroll before upstream opens
            else send(daemon, frame);
          });
          daemon.on("message", (data: Buffer, binary: boolean) => {
            if (binary || data.byteLength > max) { finish(); return; }
            send(client, data.toString("utf8"));
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
