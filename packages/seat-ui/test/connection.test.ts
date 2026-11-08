import { describe, expect, it, vi } from "vitest";
import type { ActInput, Capabilities, StreamItem } from "@openrig-seats/seat-protocol";
import { connectSeat, limitedJSONResponse, terminalStream } from "../src/connection.js";

const caps: Capabilities = { protocol: { version: "1.0" }, kinds: ["seat"], extensions: [], harnesses: [], features: {} };
const sse = (data: string) => new Response(new TextEncoder().encode(data), { headers: { "content-type": "text/event-stream" } });

describe("authenticated connection", () => {
  it("loads a snapshot then resumes its opaque cursor with bearer headers only, and aborts", async () => {
    const abort = new AbortController(); const calls: Array<{ url: string; init?: RequestInit }> = [];
    const local = vi.spyOn(Storage.prototype, "setItem");
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/capabilities")) return Response.json(caps);
      if (String(url).endsWith("/snapshot")) return Response.json({ cursor: "opaque.42", kinds: { seat: [{ id: "old" }] } });
      return sse('id: opaque.43\ndata: {"cursor":"opaque.43","kind":"seat","id":"old","op":"delete"}\n\nevent: control\ndata: {"type":"reset","reason":"cursor-pruned"}\n\n');
    };
    const items: StreamItem[] = []; const ready = vi.fn();
    await connectSeat({ baseUrl: "http://127.0.0.1:8088", token: "memory-secret", signal: abort.signal, fetch: fetcher, ready,
      item: (item) => { items.push(item); if ("type" in item) abort.abort(); },
    });
    expect(ready).toHaveBeenCalledWith(caps, { cursor: "opaque.42", kinds: { seat: [{ id: "old" }] } }, expect.any(Function));
    expect(items).toHaveLength(2);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:8088/capabilities", "http://127.0.0.1:8088/snapshot", "http://127.0.0.1:8088/stream?cursor=opaque.42"]);
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get("authorization")).toBe("Bearer memory-secret");
      expect(call.url).not.toContain("memory-secret"); expect(call.init).toMatchObject({ redirect: "error", credentials: "omit" });
    }
    expect(new Headers(calls[2]!.init?.headers).get("last-event-id")).toBe("opaque.42");
    expect(local).not.toHaveBeenCalled(); local.mockRestore();
  });

  it("keeps an action key stable through retry using the protocol client", async () => {
    const abort = new AbortController(); const posts: ActInput[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/capabilities")) return Response.json(caps);
      if (String(url).endsWith("/snapshot")) return Response.json({ cursor: "snapshot", kinds: {} });
      if (String(url).endsWith("/act")) {
        const body = JSON.parse(String(init?.body)) as ActInput; posts.push(body);
        return posts.length === 1 ? Response.json({}, { status: 503 }) : Response.json({ idempotencyKey: body.idempotencyKey, status: "completed", replayed: true });
      }
      await action; abort.abort(); return sse("");
    };
    let action: Promise<unknown> | undefined;
    await connectSeat({ baseUrl: "/gateway", token: "memory", signal: abort.signal, fetch: fetcher,
      ready: (_caps, _snapshot, act) => { action = act({ kind: "x-example.card", id: "c", action: "launch", input: true, idempotencyKey: "stable-12345678" }); }, item: () => {},
    });
    await action;
    expect(posts).toHaveLength(2); expect(posts[0]).toEqual(posts[1]);
  });
});

it("reads terminal text using only bearer and a numeric scroll header", async () => {
  let init: RequestInit | undefined; let url = "";
  const abort = new AbortController(); const output: string[] = [];
  const fetcher: typeof fetch = async (value, options) => { url = String(value); init = options; return sse('data: "<script>inert</script>"\n\n'); };
  await terminalStream("/gateway", "/terminal/{seatId}", "secret", "seat/one", 12, (value) => { output.push(value); abort.abort(); }, abort.signal, fetcher);
  expect(url).toBe("/gateway/terminal/seat%2Fone");
  expect(init?.headers).toEqual({ authorization: "Bearer secret", accept: "application/x-seat-terminal", "x-seat-ui-scroll-offset": "12" });
  expect(output).toEqual(["<script>inert</script>"]);
});

for (const route of ["capabilities", "snapshot", "stream", "terminal"]) {
  it(`cancels oversized ${route} data and reports a clear notice`, async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("x".repeat(route === "terminal" ? 6 * 1024 * 1024 + 65 : 4 * 1024 * 1024 + 1))); }, cancel() { cancelled = true; } });
    const fetcher: typeof fetch = async (url) => {
      if (String(url).includes(`/${route}`)) return new Response(source);
      if (String(url).endsWith("/capabilities")) return Response.json(caps);
      return Response.json({ cursor: "s", kinds: {} });
    };
    const signal = new AbortController().signal;
    const operation = route === "terminal" ? terminalStream("/gateway", "/terminal/s", "t", "s", 0, () => {}, signal, fetcher)
      : connectSeat({ baseUrl: "/gateway", token: "t", signal, fetch: fetcher, ready: () => {}, item: () => {} });
    await expect(operation).rejects.toThrow(/source sent too much data/i);
    expect(cancelled).toBe(true);
  });
}
it("refuses non-loopback plaintext gateway URLs before sending credentials", async () => {
  const fetcher = vi.fn();
  await expect(connectSeat({ baseUrl: "http://example.com", token: "t", signal: new AbortController().signal, fetch: fetcher, ready: () => {}, item: () => {} })).rejects.toThrow(/HTTPS/);
  expect(fetcher).not.toHaveBeenCalled();
});

for (const status of [204, 304]) {
  it(`preserves a bodyless HTTP ${status} response`, async () => {
    const response = await limitedJSONResponse({ body: new ReadableStream({ start(c) { c.close(); } }), status, statusText: "", headers: new Headers() } as Response);
    expect(response.status).toBe(status); expect(response.body).toBeNull();
  });
}
for (const status of [200, 400, 503]) {
  it(`caps and cancels HTTP ${status} action response bodies at 1 MiB`, async () => {
    const abort = new AbortController(); let cancelled = 0; let action: Promise<unknown> | undefined;
    const fetcher: typeof fetch = async (url) => {
      if (String(url).endsWith("/capabilities")) return Response.json(caps);
      if (String(url).endsWith("/snapshot")) return Response.json({ cursor: "s", kinds: {} });
      if (String(url).endsWith("/act")) { return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel() { cancelled++; } }), { status }); }
      abort.abort(); return sse("");
    };
    await connectSeat({ baseUrl: "/gateway", token: "t", signal: abort.signal, fetch: fetcher,
      ready: (_caps, _snapshot, act) => { action = act({ kind: "seat", id: "s", action: "act" }); }, item: () => {} });
    await expect(action).rejects.toThrow(/source sent too much data/i); expect(cancelled).toBeGreaterThan(0);
  });
}
