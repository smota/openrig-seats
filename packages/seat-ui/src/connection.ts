import { createSeatClient, parseSSE, SSELimitError, type ActInput, type Capabilities, type StreamItem } from "@openrig-seats/seat-protocol";
import type { Snapshot } from "./ui.js";

export interface ConnectionOptions {
  baseUrl: string;
  token: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
  ready: (capabilities: Capabilities, snapshot: Snapshot, act: (input: ActInput) => Promise<unknown>) => void;
  item: (item: StreamItem) => void;
  status?: (value: string) => void;
}
export const OVERSIZE_NOTICE = "The source sent too much data. Connection closed.";
const MAX_JSON_BYTES = 4 * 1024 * 1024;
export function gatewayURL(value: string): URL {
  const url = new URL(value, globalThis.location?.href ?? "http://localhost");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Enter an HTTP(S) gateway URL without credentials, query parameters or a fragment.");
  if (url.protocol === "http:" && !/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname)) throw new Error("Use HTTPS for gateways outside the loopback interface.");
  return url;
}
export async function limitedJSONResponse(res: Response, maxBytes = MAX_JSON_BYTES): Promise<Response> {
  if (!res.body) return res;
  const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new RangeError(OVERSIZE_NOTICE);
      chunks.push(value);
    }
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new Response([204, 205, 304].includes(res.status) ? null : bytes, { status: res.status, statusText: res.statusText, headers: res.headers });
}
/** Header-only auth, atomic full snapshot then cursor-resumed stream. */
export async function connectSeat(options: ConnectionOptions): Promise<void> {
  gatewayURL(options.baseUrl);
  const f: typeof fetch = async (url, init) => {
    const res = await (options.fetch ?? globalThis.fetch)(url, { ...init, redirect: "error", credentials: "omit", cache: "no-store" });
    return /\/(capabilities|snapshot|act)$/.test(String(url)) ? limitedJSONResponse(res, String(url).endsWith("/act") ? 1024 * 1024 : MAX_JSON_BYTES) : res;
  };
  const base = options.baseUrl.replace(/\/+$/, "");
  const client = createSeatClient({ baseUrl: base, token: options.token, fetch: f });
  const capabilities = await client.capabilities(options.signal);
  if (!capabilities.protocol.version.startsWith("1.")) throw new Error("Unsupported protocol version");
  const res = await f(`${base}/snapshot`, { headers: { authorization: `Bearer ${options.token}`, accept: "application/json" }, signal: options.signal });
  if (!res.ok) throw new Error(`Snapshot refused: HTTP ${res.status}`);
  const snapshot = await res.json() as Snapshot;
  if (typeof snapshot.cursor !== "string" || !snapshot.kinds || typeof snapshot.kinds !== "object") throw new Error("Invalid snapshot");
  if (options.signal.aborted) return;
  options.ready(capabilities, snapshot, (input) => client.act(input, options.signal));
  options.status?.("Connected");
  try { for await (const item of client.stream({ cursor: snapshot.cursor, maxLineBytes: 1024 * 1024, maxEventBytes: 4 * 1024 * 1024, signal: options.signal, onReconnect: () => options.status?.("Reconnecting…") })) {
    if (options.signal.aborted) return;
    options.item(item); options.status?.("Connected");
  } } catch (error) {
    if (error instanceof SSELimitError) { options.status?.(OVERSIZE_NOTICE); throw new RangeError(OVERSIZE_NOTICE); }
    throw error;
  }
}

/** Adapter only for the bundled standalone server; the declared upstream path stays unchanged. */
export async function terminalStream(base: string, path: string, token: string, seatId: string, offset: number, output: (value: string) => void, signal: AbortSignal, f: typeof fetch = globalThis.fetch, maxFrameBytes = 1024 * 1024): Promise<void> {
  gatewayURL(base);
  const res = await f(base.replace(/\/$/, "") + path.replace("{seatId}", encodeURIComponent(seatId)), {
    headers: { authorization: `Bearer ${token}`, accept: "application/x-seat-terminal", "x-seat-ui-scroll-offset": String(offset) },
    redirect: "error", credentials: "omit", cache: "no-store", signal,
  });
  if (!res.ok || !res.body) throw new Error("Terminal unavailable");
  // JSON escaping can expand each raw frame byte to six ASCII bytes; allow SSE framing too.
  const maxEncodedBytes = Math.min(maxFrameBytes, 1024 * 1024) * 6 + 64;
  try { for await (const event of parseSSE(res.body, { maxLineBytes: maxEncodedBytes, maxEventBytes: maxEncodedBytes })) {
    const value: unknown = JSON.parse(event.data);
    if (typeof value === "string") output(value);
  } } catch (error) {
    if (error instanceof SSELimitError) throw new RangeError(OVERSIZE_NOTICE);
    throw error;
  }
  if (!signal.aborted) throw new Error("Terminal disconnected");
}
