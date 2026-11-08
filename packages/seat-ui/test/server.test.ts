// @vitest-environment node
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createSeatUIHandler } from "../server.mjs";

const auth = { authorization: "Bearer private" };
const request = (path: string, init: RequestInit = {}) => new Request(`http://127.0.0.1:5173${path}`, init);
const caps = { features: { terminal: true }, terminal: { transport: "websocket", path: "/terminal/{seatId}", readOnly: true, output: "ansi-text", clientFrames: ["scroll"], maxFrameBytes: 128, maxViewers: 1 } };
class Socket extends EventEmitter {
  frames: string[] = []; stopped = false;
  send(text: string) { this.frames.push(text); }
  terminate() { this.stopped = true; }
}

describe("standalone fixed-target bridge", () => {
  it("proxies only protocol routes and passes bearer/cursor while refusing foreign Origin/Host", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: typeof fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return Response.json({ cursor: "snapshot", kinds: {} }); };
    const handle = createSeatUIHandler({ gatewayUrl: "http://127.0.0.1:8088", fetch: fetcher });
    expect((await handle(request("/gateway/snapshot", { headers: auth }))).status).toBe(200);
    expect(calls[0]!.url).toBe("http://127.0.0.1:8088/snapshot");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer private");
    expect(calls[0]!.init.redirect).toBe("error");
    expect((await handle(request("/gateway/stream?cursor=abc", { headers: { ...auth, "last-event-id": "abc" } }))).status).toBe(200);
    expect(new Headers(calls[1]!.init.headers).get("last-event-id")).toBe("abc");
    for (const path of ["/gateway/anything", "/gateway/act?token=private", "/gateway/snapshot?url=http://evil.test", "/gateway/stream?token=private"]) expect((await handle(request(path, { headers: auth }))).status).toBe(404);
    expect((await handle(request("/gateway/snapshot"))).status).toBe(401);
    expect((await handle(request("/gateway/snapshot", { headers: { ...auth, origin: "http://evil.test" } }))).status).toBe(403);
    expect((await handle(request("/gateway/snapshot", { headers: { ...auth, host: "evil.test" } }))).status).toBe(403);
    expect(calls).toHaveLength(2);
  });
  it("forwards declared action JSON and never arbitrary methods or redirects", async () => {
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ status: "completed" }));
    const handle = createSeatUIHandler({ fetch: fetcher });
    const body = { kind: "x-example.item", id: "a", action: "custom", idempotencyKey: "key-123456", input: { text: "hi" } };
    expect((await handle(request("/gateway/act", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) }))).status).toBe(200);
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(Buffer.from(init.body as Uint8Array).toString())).toEqual(body);
    expect((await handle(request("/gateway/act", { headers: auth }))).status).toBe(405);
    expect((await handle(request("/gateway/snapshot", { method: "DELETE", headers: auth }))).status).toBe(405);
  });
  it("opens the advertised terminal with header auth, sends only scroll, closes on cancellation", async () => {
    const socket = new Socket(); let socketURL = ""; let socketOptions: unknown;
    const handle = createSeatUIHandler({ fetch: async () => Response.json(caps), connectTerminal: (url: string, options: unknown) => { socketURL = url; socketOptions = options; return socket; } });
    const response = await handle(request("/gateway/terminal/s1", { headers: { ...auth, accept: "application/x-seat-terminal", "x-seat-ui-scroll-offset": "20", "x-seat-ui-keys": "Enter" } }));
    expect(socketURL).toBe("ws://127.0.0.1:8088/terminal/s1");
    expect(socketOptions).toMatchObject({ headers: auth, followRedirects: false, maxPayload: 128 });
    socket.emit("open"); expect(socket.frames).toEqual(['{"type":"scroll","offset":20}']);
    const reader = response.body!.getReader(); const next = reader.read(); socket.emit("message", Buffer.from("<img onerror=alert(1)>"), false);
    expect(new TextDecoder().decode((await next).value)).toContain('<img onerror=alert(1)>');
    await reader.cancel(); expect(socket.stopped).toBe(true);
  });
  it("enforces advertised terminal limits, rejects malformed scroll and binary/oversized output", async () => {
    const sockets: Socket[] = [];
    const handle = createSeatUIHandler({ fetch: async () => Response.json(caps), connectTerminal: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
    const terminalRequest = (offset = "0", signal?: AbortSignal) => request("/gateway/terminal/s1", { headers: { ...auth, accept: "application/x-seat-terminal", "x-seat-ui-scroll-offset": offset }, signal });
    for (const offset of ["-1", "1.2", "100001", '{"type":"keys"}']) expect((await handle(terminalRequest(offset))).status).toBe(400);
    const first = await handle(terminalRequest());
    expect((await handle(terminalRequest())).status).toBe(503);
    sockets[0]!.emit("message", Buffer.from("x".repeat(129)), false); expect(sockets[0]!.stopped).toBe(true); await first.body!.cancel();
    const abort = new AbortController(); const second = await handle(terminalRequest("0", abort.signal));
    sockets[1]!.emit("message", Buffer.from("binary"), true); expect(sockets[1]!.stopped).toBe(true); await second.body!.cancel();
    const third = await handle(terminalRequest("0", abort.signal)); abort.abort(); expect(sockets[2]!.stopped).toBe(true); await third.body!.cancel();
  });
  it("never opens a terminal when capabilities do not advertise it", async () => {
    const connect = vi.fn(); const handle = createSeatUIHandler({ fetch: async () => Response.json({ features: { terminal: false } }), connectTerminal: connect });
    expect((await handle(request("/gateway/terminal/s1", { headers: { ...auth, accept: "application/x-seat-terminal" } }))).status).toBe(404); expect(connect).not.toHaveBeenCalled();
  });
});

it("serves static HTML without bearer and permits schema compilation without inline scripts", async () => {
  const handle = createSeatUIHandler({ rootDir: new URL("..", import.meta.url).pathname });
  const response = await handle(request("/"));
  expect(response.status).toBe(200); expect(await response.text()).toContain('<div id="app">');
  const policy = response.headers.get("content-security-policy")!;
  expect(policy).toContain("script-src 'self' 'unsafe-eval'"); expect(policy).not.toContain("unsafe-inline");
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("buffers eight terminal frames before disconnecting a slow viewer", async () => {
  const socket = new Socket();
  const handle = createSeatUIHandler({ fetch: async () => Response.json(caps), connectTerminal: () => socket });
  const response = await handle(request("/gateway/terminal/s", { headers: { ...auth, accept: "application/x-seat-terminal" } }));
  for (let i = 0; i < 8; i++) socket.emit("message", Buffer.from(String(i)), false);
  expect(socket.stopped).toBe(false);
  socket.emit("message", Buffer.from("overflow"), false); expect(socket.stopped).toBe(true);
  await response.body!.cancel();
});
it("limits connect-src to self and the configured gateway origin", async () => {
  const handle = createSeatUIHandler({ gatewayUrl: "https://gateway.example.test/path", rootDir: new URL("..", import.meta.url).pathname });
  const policy = (await handle(request("/"))).headers.get("content-security-policy")!;
  expect(policy).toContain("connect-src 'self' https://gateway.example.test;");
  expect(() => createSeatUIHandler({ gatewayUrl: "http://gateway.example.test" })).toThrow(/HTTPS/);
});

it("cancels oversized capabilities before opening a terminal", async () => {
  let cancelled = false;
  const source = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; } });
  const connect = vi.fn();
  const handle = createSeatUIHandler({ fetch: async () => new Response(source), connectTerminal: connect });
  const response = await handle(request("/gateway/terminal/s", { headers: { ...auth, accept: "application/x-seat-terminal" } }));
  expect(response.status).toBe(502); expect(cancelled).toBe(true); expect(connect).not.toHaveBeenCalled();
});
