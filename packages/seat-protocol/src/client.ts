import { parseSSE, SSELimitError, type ParseSSEOptions } from "./sse.js";
import type { ActResponse, Capabilities, StreamControl, StreamEnvelope } from "./types.generated.js";
import type { StreamItem } from "./kinds.js";

export class SeatClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "SeatClientError";
  }
}

export interface SeatClientOptions {
  /** Server root, for example http://127.0.0.1:8088. Paths are /capabilities, /stream and /act. */
  baseUrl: string;
  /** Bearer token. Sent as an Authorization header only; never logged or put in a URL. */
  token?: string;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** First reconnect delay in ms (doubles up to maxDelayMs). Default 250. */
  minDelayMs?: number;
  /** Default 10000. */
  maxDelayMs?: number;
  /** Consecutive failed connection attempts before stream() throws. Default: unlimited. */
  maxAttempts?: number;
  /** Retries of act() after a network error or 5xx, with the same idempotency key. Default 2. */
  actRetries?: number;
  /** Test hook. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface StreamOptions extends Pick<ParseSSEOptions, "maxLineBytes" | "maxEventBytes"> {
  /** Resume after this cursor. */
  cursor?: string;
  signal?: AbortSignal;
  /** Called with each cursor once its envelope has been handed to the consumer. */
  onCursor?: (cursor: string) => void;
  /** Called on a dropped connection before the reconnect delay. */
  onReconnect?: (info: { attempt: number; cursor: string | undefined; error?: unknown }) => void;
  /**
   * Called when the server could not honour the cursor and sends `reset`: everything held is stale.
   * The reset is also yielded (feed it to Mirror.apply, which clears), and the cursor is dropped so a
   * reconnect during the replay starts clean.
   */
  onReset?: (control: StreamControl) => void;
  /** Called for a message that is not a valid envelope (it is skipped). */
  onSkipped?: (reason: string, raw: string) => void;
}

export interface ActInput {
  /** Kind of the item the action was declared on. */
  kind: string;
  id: string;
  /** Declared action id. */
  action: string;
  /** Value matching the action's declared input schema. */
  input?: unknown;
  /** Generated (UUID) when absent. Pass your own to make a retry from a new process idempotent. */
  idempotencyKey?: string;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

function isEnvelope(v: unknown): v is StreamEnvelope {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.cursor === "string" && e.cursor.length > 0 &&
    typeof e.kind === "string" && typeof e.id === "string" &&
    (e.op === "upsert" || e.op === "delete")
  );
}

export class SeatClient {
  private readonly f: typeof fetch;
  private readonly base: string;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly opts: SeatClientOptions) {
    this.f = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}), ...extra };
  }

  async capabilities(signal?: AbortSignal): Promise<Capabilities> {
    const res = await this.f(`${this.base}/capabilities`, { headers: this.headers({ accept: "application/json" }), signal });
    return (await this.readJson(res)) as Capabilities;
  }

  /** POST /act. The idempotency key is generated once and reused by every retry. */
  async act(input: ActInput, signal?: AbortSignal): Promise<ActResponse> {
    const body = { ...input, idempotencyKey: input.idempotencyKey ?? globalThis.crypto.randomUUID() };
    const retries = this.opts.actRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.f(`${this.base}/act`, {
          method: "POST",
          headers: this.headers({ "content-type": "application/json", accept: "application/json" }),
          body: JSON.stringify(body),
          signal,
        });
        if (res.status >= 500 && attempt < retries) {
          await this.sleep(this.backoff(attempt), signal);
          continue;
        }
        return (await this.readJson(res, true)) as ActResponse;
      } catch (err) {
        if (err instanceof SeatClientError || signal?.aborted || attempt >= retries) throw err;
        await this.sleep(this.backoff(attempt), signal);
      }
    }
  }

  /**
   * GET /stream as an async iterator of envelopes (and control messages, see onReset). Reconnects with the last delivered cursor
   * (Last-Event-ID header and `cursor` query), so the consumer sees no gap; an envelope whose cursor
   * equals the last delivered one is dropped. Ends when `signal` aborts; throws on 401/403/404 and
   * after `maxAttempts` consecutive failures.
   */
  async *stream(options: StreamOptions = {}): AsyncGenerator<StreamItem> {
    const { signal } = options;
    let cursor = options.cursor;
    let failures = 0;
    let serverRetryMs: number | undefined;
    while (!signal?.aborted) {
      let ended: unknown;
      // One controller per connection: aborted when the caller aborts, or when iteration ends early.
      const conn = new AbortController();
      const onAbort = () => conn.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const url = `${this.base}/stream${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`;
        const res = await this.f(url, {
          headers: this.headers({ accept: "text/event-stream", "cache-control": "no-cache", ...(cursor ? { "last-event-id": cursor } : {}) }),
          signal: conn.signal,
        });
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          await res.body?.cancel().catch(() => {});
          throw new SeatClientError(`stream refused: HTTP ${res.status}`, res.status);
        }
        if (!res.ok || !res.body) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`stream failed: HTTP ${res.status}`);
        }
        for await (const msg of parseSSE(res.body, { maxLineBytes: options.maxLineBytes, maxEventBytes: options.maxEventBytes, onRetry: (ms) => (serverRetryMs = ms) })) {
          failures = 0;
          if (msg.event === "control") {
            let control: unknown;
            try {
              control = JSON.parse(msg.data);
            } catch {
              options.onSkipped?.("invalid JSON", msg.data);
              continue;
            }
            if (typeof control === "object" && control !== null && (control as { type?: unknown }).type === "reset") {
              cursor = undefined;
              options.onReset?.(control as StreamControl);
              yield control as StreamControl;
            }
            continue; // control types this version does not know are ignored
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(msg.data);
          } catch {
            options.onSkipped?.("invalid JSON", msg.data);
            continue;
          }
          if (!isEnvelope(parsed)) {
            options.onSkipped?.("not an envelope", msg.data);
            continue;
          }
          if (parsed.cursor === cursor) continue;
          // Advance before handing over: a consumer that processes this envelope and stops never sees it again.
          cursor = parsed.cursor;
          options.onCursor?.(cursor);
          yield parsed;
        }
      } catch (err) {
        if (signal?.aborted) return;
        if (err instanceof SeatClientError || err instanceof SSELimitError) throw err;
        ended = err;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        conn.abort(); // no connection outlives the iteration
      }
      if (signal?.aborted) return;
      failures++;
      if (this.opts.maxAttempts !== undefined && failures >= this.opts.maxAttempts) {
        throw new SeatClientError(`stream gave up after ${failures} attempts`, undefined, ended);
      }
      options.onReconnect?.({ attempt: failures, cursor, error: ended });
      await this.sleep(this.backoff(failures - 1, serverRetryMs), signal);
    }
  }

  /**
   * Reconnect delay. A server `retry:` value is the base (floored at 50 ms, capped at maxDelayMs);
   * without one the base is minDelayMs. It doubles with each consecutive failure, up to maxDelayMs.
   */
  private backoff(attempt: number, serverRetryMs?: number): number {
    const max = this.opts.maxDelayMs ?? 10_000;
    const base = serverRetryMs !== undefined ? Math.min(max, Math.max(50, serverRetryMs)) : this.opts.minDelayMs ?? 250;
    return Math.min(max, base * 2 ** attempt);
  }

  private async readJson(res: Response, allowErrorBody = false): Promise<unknown> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    // /act reports rejected and failed outcomes in the body with a non-2xx status: hand them to the caller.
    if (!res.ok && !(allowErrorBody && body !== undefined && typeof body === "object" && body !== null && "status" in body && res.status < 500)) {
      throw new SeatClientError(`HTTP ${res.status}`, res.status, body);
    }
    if (body === undefined) throw new SeatClientError("response is not JSON", res.status);
    return body;
  }
}

export function createSeatClient(options: SeatClientOptions): SeatClient {
  return new SeatClient(options);
}
