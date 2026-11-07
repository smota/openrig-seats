import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type Capabilities } from "@openrig-seats/seat-protocol";
import { envelope, type Store } from "./store.js";

export interface AppOptions {
  store: Store;
  /** Bearer token clients must present. */
  token: string;
  /** Async so it may probe the daemon; failures fall back to the last answer. */
  capabilities: () => Promise<Capabilities>;
  /** Kinds the daemon currently supports; a disabled kind answers 404 on /snapshot. */
  enabledKinds: () => string[];
  allowedOrigins?: string[];
  allowedHosts?: string[];
  /** Present only when the write side is enabled: serves POST /act. */
  act?: (body: unknown) => Promise<{ httpStatus: number; response: unknown }>;
  /** Secret known only to the in-process upgrade path; without it /terminal/:id never yields the session header. */
  terminalKey?: string;
  terminal?: (id: string, signal?: AbortSignal) => Promise<{ status: number; session?: string }>;
  /** SSE comment interval. Default 15000. */
  heartbeatMs?: number;
  /** A client that accepts no bytes for this long is dropped. Default 30000. */
  writeTimeoutMs?: number;
  onStream?: (event: "open" | "close", info: { reset?: boolean; reason?: string }) => void;
}

export const TERMINAL_KEY_HEADER = "x-seat-internal-upgrade";
const digest = (s: string) => createHash("sha256").update(s).digest();
const LOOPBACK_HOST = /^(127(\.\d{1,3}){3}|localhost|\[::1\])(:\d+)?$/i;

/** Builds the HTTP surface. GET only, plus POST /act when `act` is provided. */
export function createApp(opts: AppOptions): Hono {
  const app = new Hono();
  const expected = digest(opts.token);
  const origins = new Set(opts.allowedOrigins ?? []);
  const hosts = new Set((opts.allowedHosts ?? []).map((h) => h.toLowerCase()));
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const writeTimeoutMs = opts.writeTimeoutMs ?? 30_000;

  // A browser page on another origin is refused, whatever it sends; so is a Host that is not loopback or configured
  // (DNS rebinding). Both run before authentication so nothing is learned from them.
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !origins.has(origin)) return c.json({ error: "origin_refused" }, 403);
    const host = c.req.header("host");
    if (host !== undefined && !LOOPBACK_HOST.test(host) && !hosts.has(host.toLowerCase())) return c.json({ error: "host_refused" }, 403);
    c.header("cache-control", "no-store");
    c.header("x-content-type-options", "nosniff");
    await next();
  });

  app.use("*", async (c, next) => {
    const m = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "");
    if (!m || !timingSafeEqual(digest(m[1]!.trim()), expected)) {
      c.header("www-authenticate", 'Bearer realm="seat-gateway"');
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.use("*", async (c, next) => {
    if (c.req.method === "POST" && opts.act && c.req.path === "/act") return next();
    if (c.req.method !== "GET") return c.json({ error: "method_not_allowed", message: "this gateway is read-only" }, 405, { allow: "GET" });
    await next();
  });

  if (opts.act) {
    const act = opts.act;
    app.post("/act", async (c) => {
      if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) return c.json({ error: "invalid_request", message: "content-type must be application/json" }, 415);
      const len = Number(c.req.header("content-length") ?? 0);
      if (len > 256 * 1024) return c.json({ error: "invalid_request", message: "body too large" }, 413);
      let body: unknown;
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        return c.json({ error: "invalid_request", message: "body is not JSON" }, 400);
      }
      const r = await act(body);
      return c.json(r.response, r.httpStatus as 200);
    });
  }

  if (opts.terminal) app.get("/terminal/:seatId", async (c) => {
    const given = c.req.header(TERMINAL_KEY_HEADER);
    const internal = opts.terminalKey !== undefined && given !== undefined && timingSafeEqual(digest(given), digest(opts.terminalKey));
    if (!internal || c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "websocket_required" }, 426);
    const result = await opts.terminal!(c.req.param("seatId"), c.req.raw.signal);
    if (result.status !== 204 || !result.session) return c.json({ error: "terminal_unavailable" }, result.status as 404);
    return new Response(null, { status: 204, headers: { "x-seat-terminal-session": result.session } });
  });

  app.get("/capabilities", async (c) => c.json(await opts.capabilities()));

  const snapshotOf = (kind: string) => ({ cursor: opts.store.cursor(opts.store.head()), kind, items: opts.store.items(kind) });
  const snapshot = (kind: string | undefined, c: { json: (b: unknown, s?: 404) => Response }) => {
    if (kind === undefined) {
      const head = opts.store.cursor(opts.store.head());
      const kinds: Record<string, unknown[]> = {};
      for (const k of opts.enabledKinds()) kinds[k] = opts.store.items(k);
      return c.json({ cursor: head, kinds });
    }
    if (!opts.enabledKinds().includes(kind)) return c.json({ error: "unknown_kind", message: `kind ${kind} is not served here` }, 404);
    return c.json(snapshotOf(kind));
  };
  app.get("/snapshot", (c) => snapshot(c.req.query("kind"), c));
  app.get("/snapshot/:kind", (c) => snapshot(c.req.param("kind"), c));

  app.get("/stream", (c) => {
    const store = opts.store;
    const cursor = c.req.header("last-event-id") ?? c.req.query("cursor");
    const resolved = store.resolve(cursor);
    c.header("x-accel-buffering", "no");
    return streamSSE(c, async (stream) => {
      const gone = new AbortController();
      stream.onAbort(() => gone.abort());
      opts.onStream?.("open", { reset: resolved.reset, ...(resolved.reason ? { reason: resolved.reason } : {}) });
      // A client that accepts no bytes for writeTimeoutMs is dropped: the pending write is abandoned and the
      // socket destroyed, so a stalled reader costs nothing but its own connection.
      const stalled = new Promise<never>((_, reject) => gone.signal.addEventListener("abort", () => reject(new Error("client gone")), { once: true }));
      stalled.catch(() => {});
      const write = async (msg: Parameters<typeof stream.writeSSE>[0] | string) => {
        const timer = setTimeout(() => {
          gone.abort();
          (c.env as { outgoing?: { destroy?: () => void } } | undefined)?.outgoing?.destroy?.();
        }, writeTimeoutMs);
        try {
          await Promise.race([typeof msg === "string" ? stream.write(msg) : stream.writeSSE(msg), stalled]);
        } finally {
          clearTimeout(timer);
        }
      };
      const reset = (reason: string) => write({ event: "control", data: JSON.stringify({ type: "reset", reason }) });
      try {
        await write("retry: 1000\n\n");
        if (resolved.reset) await reset(resolved.reason ?? "cursor-unknown");
        // `sent` is the highest sequence number fully processed (the head at the time of the last batch).
        let sent = resolved.from;
        while (!gone.signal.aborted && !stream.aborted) {
          // A tombstone newer than `sent` was pruned: a delete this client never received is gone, so what it
          // holds cannot be repaired by entries alone. Reset it and replay the full state.
          // (sent === 0 means nothing is held yet: a fresh or just-reset client needs no reset.)
          if (sent > 0 && store.floorSeq() > sent) {
            await reset("cursor-pruned");
            sent = 0;
          }
          const head = store.head();
          for (const e of store.since(sent)) {
            if (gone.signal.aborted) break;
            if (e.seq > head) break;
            await write({ id: store.cursor(e.seq), data: JSON.stringify(envelope(store, e)) });
          }
          sent = head;
          if (store.head() === head) {
            // Waits for the head to move past what was processed; never resolves at once for an old head.
            await store.waitAfter(head, gone.signal, heartbeatMs);
            if (!gone.signal.aborted && store.head() === head) await write(": ping\n\n");
          }
        }
      } catch {
        /* the client went away or stalled */
      } finally {
        opts.onStream?.("close", {});
      }
    });
  });

  app.all("*", (c) => c.json({ error: "not_found" }, 404));
  return app;
}
