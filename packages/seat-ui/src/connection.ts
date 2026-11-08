import { createSeatClient, parseSSE, type ActInput, type Capabilities, type StreamItem } from "@openrig-seats/seat-protocol";
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
/** Header-only auth, atomic full snapshot then cursor-resumed stream. */
export async function connectSeat(options: ConnectionOptions): Promise<void> {
  const f: typeof fetch = (url, init) => (options.fetch ?? globalThis.fetch)(url, { ...init, redirect: "error", credentials: "omit", cache: "no-store" });
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
  for await (const item of client.stream({ cursor: snapshot.cursor, signal: options.signal, onReconnect: () => options.status?.("Reconnecting…") })) {
    if (options.signal.aborted) return;
    options.item(item); options.status?.("Connected");
  }
}

/** Adapter only for the bundled standalone server; the declared upstream path stays unchanged. */
export async function terminalStream(base: string, path: string, token: string, seatId: string, offset: number, output: (value: string) => void, signal: AbortSignal, f: typeof fetch = globalThis.fetch): Promise<void> {
  const res = await f(base.replace(/\/$/, "") + path.replace("{seatId}", encodeURIComponent(seatId)), {
    headers: { authorization: `Bearer ${token}`, accept: "application/x-seat-terminal", "x-seat-ui-scroll-offset": String(offset) },
    redirect: "error", credentials: "omit", cache: "no-store", signal,
  });
  if (!res.ok || !res.body) throw new Error("Terminal unavailable");
  for await (const event of parseSSE(res.body)) {
    const value: unknown = JSON.parse(event.data);
    if (typeof value === "string") output(value);
  }
  if (!signal.aborted) throw new Error("Terminal disconnected");
}
