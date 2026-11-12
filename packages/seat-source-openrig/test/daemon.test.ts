import { describe, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/daemon.js";

function clientWithEvent(data: string): DaemonClient {
  return new DaemonClient({
    baseUrl: "http://127.0.0.1:7433",
    fetch: async () => new Response(`id: 7\ndata: ${JSON.stringify({ seq: 7, type: "large", data })}\n\n`),
  });
}

describe("daemon events SSE limits", () => {
  it("preserves unlimited default parsing for a 2 MiB event", async () => {
    const data = "x".repeat(2 * 1024 * 1024);
    const events = [];
    for await (const event of clientWithEvent(data).events()) events.push(event);
    expect(events).toEqual([{ seq: 7, event: { seq: 7, type: "large", data } }]);
  });

  it("passes explicitly selected limits to the SSE parser", async () => {
    const read = async () => {
      for await (const _event of clientWithEvent("x".repeat(2048)).events({ limits: { maxEventBytes: 1024 } })) { /* exhaust the stream */ }
    };
    await expect(read()).rejects.toThrow("SSE event byte limit exceeded");
  });
});


it.each(["pending-read", "before-read", "cancel-reject"])("cancels an open app SSE reader promptly when stopped after fetch returns: %s", async mode => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; if (mode === "cancel-reject") return Promise.reject(new Error("fixture cancel rejected")); } });
  const ctl = new AbortController();
  const added = vi.spyOn(ctl.signal, "addEventListener"), removed = vi.spyOn(ctl.signal, "removeEventListener");
  const daemon = new DaemonClient({ baseUrl: "http://127.0.0.1:7433", fetch: (async () => new Response(body, { headers: { "content-type": "text/event-stream" } })) as typeof fetch });
  const events = daemon.appInvalidations(ctl.signal);
  expect((await events.next()).done).toBe(false);
  if (mode === "before-read") ctl.abort();
  const reading = events.next();
  if (mode !== "before-read") ctl.abort();
  let deadline: ReturnType<typeof setTimeout>;
  try {
    const done = await Promise.race([reading, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("app SSE reader remained pending after abort")), 250); })]);
    expect(done.done).toBe(true); expect(cancelled).toBe(true); expect(body.locked).toBe(false);
    for (const args of added.mock.calls) if (args[0] === "abort") expect(removed).toHaveBeenCalledWith("abort", args[1]);
  } finally { clearTimeout(deadline!); added.mockRestore(); removed.mockRestore(); }
});


it.each(["pending-headers", "already-aborted"])("forwards abort before app SSE response headers without yielding a snapshot trigger: %s", async mode => {
  const ctl = new AbortController();
  let observed: AbortSignal | null | undefined;
  const daemon = new DaemonClient({ baseUrl: "http://127.0.0.1:7433", fetch: ((_url, init) => {
    observed = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (!observed) return reject(new Error("missing fetch signal"));
      if (observed.aborted) reject(observed.reason);
      else observed.addEventListener("abort", () => reject(observed!.reason), { once: true });
    });
  }) as typeof fetch });
  if (mode === "already-aborted") ctl.abort();
  const reading = daemon.appInvalidations(ctl.signal).next();
  if (mode === "pending-headers") ctl.abort();
  let deadline: ReturnType<typeof setTimeout>;
  try {
    await expect(Promise.race([reading, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("headers remained pending after abort")), 250); })])).rejects.toHaveProperty("name", "AbortError");
    expect(observed).toBe(ctl.signal);
  } finally { clearTimeout(deadline!); }
});

it("cancels a legacy event reader after headers when its existing signal aborts", async () => {
  let cancelled = false, opened!: () => void;
  const ready = new Promise<void>(resolve => { opened = resolve; });
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const ctl = new AbortController();
  const daemon = new DaemonClient({ baseUrl: "http://127.0.0.1:7433", fetch: (async () => new Response(body, { headers: { "content-type": "text/event-stream" } })) as typeof fetch });
  const events = daemon.events({ signal: ctl.signal, onOpen: opened });
  const reading = events.next(); await ready; ctl.abort();
  let deadline: ReturnType<typeof setTimeout>;
  try {
    const result = await Promise.race([reading, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("legacy SSE reader remained pending after abort")), 250); })]);
    expect(result.done).toBe(true); expect(cancelled).toBe(true); expect(body.locked).toBe(false);
  } finally { clearTimeout(deadline!); }
});
