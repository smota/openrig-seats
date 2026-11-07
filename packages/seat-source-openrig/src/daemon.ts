import { readFileSync, statSync } from "node:fs";
import { parseSSE } from "@openrig-seats/seat-protocol";
import { ROUTES } from "./routes.js";

export class DaemonError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "DaemonError";
  }
}

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

/** The daemon token only ever travels to a literal loopback IP, never to a name that could resolve elsewhere. */
export function assertLoopbackUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new DaemonError("daemon URL is not a valid URL");
  }
  if (u.protocol !== "http:") throw new DaemonError("daemon URL must be http (loopback only)");
  const host = u.hostname;
  if (!(LOOPBACK_V4.test(host) || host === "[::1]")) throw new DaemonError("daemon URL must use a literal loopback IP (127.x.x.x or [::1])");
  return u;
}

/** Reads a secret from a file that only its owner may read (mode 0600 or stricter). Never logs the value. */
export function readSecretFile(path: string, label = "token"): string {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new Error(`${label} file is not readable`);
  }
  if (!st.isFile()) throw new Error(`${label} file is not a regular file`);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) throw new Error(`${label} file must not be accessible by group or others (chmod 600)`);
  const value = readFileSync(path, "utf8").trim();
  if (!value) throw new Error(`${label} file is empty`);
  return value;
}

export interface DaemonClientOptions {
  baseUrl: string;
  /** Sent as a bearer header to the loopback daemon only. Never put in a URL or logged. */
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface DaemonEvent {
  seq: number;
  event: { type?: string; rigId?: string; nodeId?: string; [k: string]: unknown };
}

/** Thin GET-only client for the daemon. */
export class DaemonClient {
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;

  constructor(opts: DaemonClientOptions) {
    this.base = assertLoopbackUrl(opts.baseUrl).origin;
    this.f = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...extra };
  }

  /** GET and parse JSON. Throws DaemonError with the HTTP status on a non-2xx answer. */
  async getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await this.f(this.base + path, {
      method: "GET",
      redirect: "error", // a loopback endpoint must not bounce the request (and its token) elsewhere
      headers: this.headers({ accept: "application/json" }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new DaemonError(`daemon answered HTTP ${res.status} for ${path.split("?")[0]}`, res.status);
    }
    try {
      return await res.json();
    } catch {
      throw new DaemonError(`daemon answer for ${path.split("?")[0]} is not JSON`, res.status);
    }
  }

  /** Status of a GET without parsing: used by feature probes. */
  async status(path: string, signal?: AbortSignal): Promise<number> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const res = await this.f(this.base + path, { method: "GET", redirect: "error", headers: this.headers(), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    await res.body?.cancel().catch(() => {});
    return res.status;
  }

  /**
   * Opens the events stream. Always `replay=0`; with `lastSeq` it also sends Last-Event-ID so the daemon
   * replays what was missed. Yields until the connection ends; the caller decides what a gap means.
   */
  async *events(opts: { lastSeq?: number | null; signal?: AbortSignal; onOpen?: () => void } = {}): AsyncGenerator<DaemonEvent> {
    const res = await this.f(this.base + ROUTES.events, {
      method: "GET",
      redirect: "error",
      headers: this.headers({
        accept: "text/event-stream",
        "cache-control": "no-cache",
        ...(opts.lastSeq !== null && opts.lastSeq !== undefined ? { "last-event-id": String(opts.lastSeq) } : {}),
      }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw new DaemonError(`events stream refused: HTTP ${res.status}`, res.status);
    }
    opts.onOpen?.();
    for await (const msg of parseSSE(res.body)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.data);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      const rec = parsed as Record<string, unknown>;
      const seq = typeof rec.seq === "number" ? rec.seq : Number(msg.lastEventId);
      if (!Number.isFinite(seq)) continue;
      yield { seq, event: rec as DaemonEvent["event"] };
    }
  }
}
