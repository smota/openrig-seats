import { describe, expect, it } from "vitest";
import { scrollFrame, terminalUpgradeUrl } from "../src/terminal.js";

describe("terminal client allowlist", () => {
  it("drops keys, text, paste, resize and malformed frames", () => {
    for (const frame of [{ type: "keys", keys: ["Enter"] }, { type: "text", text: "danger" }, { type: "paste", text: "danger" }, { type: "resize", cols: 80, rows: 24, text: "danger" }, { type: "scroll", offset: -1 }, { type: "scroll", offset: 1.5 }, null, []]) {
      expect(scrollFrame(JSON.stringify(frame))).toBeUndefined();
    }
    expect(scrollFrame("{broken")).toBeUndefined();
  });
  it("clamps huge offsets", () => { expect(scrollFrame('{"type":"scroll","offset":99999999}')).toBe('{"type":"scroll","offset":10000}'); });
  it("reconstructs only scroll offset and strips input fields", () => {
    expect(scrollFrame(JSON.stringify({ type: "scroll", offset: 20, text: "danger", keys: ["Enter"], resize: true }))).toBe('{"type":"scroll","offset":20}');
  });
});

import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { DaemonClient, TerminalSocket } from "@openrig-seats/seat-source-openrig";
import { TerminalBridge } from "../src/terminal.js";
import { createApp } from "../src/server.js";
import { Store } from "../src/store.js";
import { parseConfig } from "../src/config.js";
import { vi } from "vitest";

class Peer extends EventEmitter implements TerminalSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  terminated = false;
  send(data: string, cb?: (error?: Error) => void) { this.sent.push(data); cb?.(); }
  pong(data: Buffer, _mask: boolean, cb?: (error?: Error) => void) { this.sent.push(`pong:${data.toString()}`); cb?.(); }
  close() { this.terminate(); }
  terminate() { this.terminated = true; this.readyState = 3; }
}
function harness(extra: Record<string, unknown> = {}, synced = () => true) {
  const upstream = new Peer();
  const downstream = new Peer();
  const raw = new Duplex({ read() {}, write(_chunk, _enc, cb) { cb(); } });
  const daemon = { getJson: vi.fn(async () => ({ value: true })) } as unknown as DaemonClient;
  const config = parseConfig({ tokenFile: "t", terminal: { enabled: true, principal: "viewer@acme", maxFrameBytes: 128, maxViewers: 1, ...extra } }).terminal;
  const connect = vi.fn((_opts: Parameters<typeof import("@openrig-seats/seat-source-openrig").openTerminal>[0]) => upstream);
  const bridge = new TerminalBridge({ config, daemon, daemonUrl: "http://127.0.0.1:7433", daemonToken: "private", synced, seats: () => [{ id: "s1", name: "builder@acme", "x-openrig": { sessionName: "builder@acme" } }], connect,
    socketServer: { handleUpgrade: (_req, _socket, _head, cb) => cb(downstream), close() {} } });
  const attach = async () => {
    bridge.upgrade({} as IncomingMessage, raw, Buffer.alloc(0), async () => new Response(null, { status: 204, headers: { "x-seat-terminal-session": "builder@acme" } }));
    await Promise.resolve(); await Promise.resolve();
    upstream.emit("open");
  };
  return { upstream, downstream, raw, daemon, config, connect, bridge, attach };
}

describe("terminal bridge without network", () => {
  it("forwards raw output but never forwards keys or text; scroll is reconstructed", async () => {
    const h = harness();
    try {
      await h.attach();
      for (const frame of [{ type: "keys", keys: ["Enter"] }, { type: "text", text: "danger" }, { type: "paste", text: "danger" }, { type: "resize", cols: 80, text: "danger" }]) h.downstream.emit("message", Buffer.from(JSON.stringify(frame)), false);
      h.downstream.emit("message", Buffer.from('{"type":"scroll","offset":12,"text":"danger"}'), false);
      expect(h.upstream.sent).toEqual(['{"type":"scroll","offset":12}']);
      h.upstream.emit("message", Buffer.from("\x1b[2Jhello"), false);
      expect(h.downstream.sent).toEqual(["\x1b[2Jhello"]);
      expect(h.connect.mock.calls[0]?.[0]).toMatchObject({ principal: "viewer@acme", session: "builder@acme", token: "private" });
    } finally { h.bridge.stop(); }
  });
  it("drops binary input and closes on binary output", async () => {
    const h = harness();
    try {
      await h.attach();
      h.downstream.emit("message", Buffer.from('{"type":"scroll","offset":0}'), true);
      expect(h.upstream.sent).toEqual([]);
      h.upstream.emit("message", Buffer.from("binary"), true);
      expect(h.upstream.terminated && h.downstream.terminated).toBe(true);
      expect(h.bridge.activeViewers()).toBe(0);
    } finally { h.bridge.stop(); }
  });
  it.each(["frame", "buffer"])("bounds output %s bytes and releases viewer", async (limit) => {
    const h = harness();
    try {
      await h.attach();
      if (limit === "buffer") h.downstream.bufferedAmount = 128;
      h.upstream.emit("message", Buffer.from(limit === "frame" ? "x".repeat(129) : "x"), false);
      expect(h.downstream.sent).toEqual([]);
      expect(h.bridge.activeViewers()).toBe(0);
    } finally { h.bridge.stop(); }
  });
  it("counts pending authentication against the connection limit and cleans shutdown", () => {
    const h = harness();
    try {
      h.bridge.upgrade({} as IncomingMessage, h.raw, Buffer.alloc(0), () => new Promise(() => {}));
      const authenticate = vi.fn();
      const raw2 = new Duplex({ read() {}, write(_chunk, _enc, cb) { cb(); } });
      h.bridge.upgrade({} as IncomingMessage, raw2, Buffer.alloc(0), authenticate);
      expect(authenticate).not.toHaveBeenCalled();
      expect(h.bridge.activeViewers()).toBe(1);
      h.bridge.stop();
      expect(h.bridge.activeViewers()).toBe(0);
      expect(h.raw.destroyed).toBe(true);
      raw2.destroy();
    } finally { h.bridge.stop(); }
  });
  it("conflates early scroll into one frame and bounds upstream send buffers", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.upstream.readyState = 0;
    try {
      await h.attach();
      h.downstream.emit("message", Buffer.from('{"type":"scroll","offset":1}'), false);
      h.downstream.emit("message", Buffer.from('{"type":"scroll","offset":2}'), false);
      h.upstream.readyState = 1;
      h.upstream.emit("open");
      expect(h.upstream.sent).toEqual(['{"type":"scroll","offset":2}']);
      h.upstream.bufferedAmount = 128;
      h.upstream.emit("message", Buffer.from("out"), false);
      h.downstream.emit("message", Buffer.from('{"type":"scroll","offset":0}'), false);
      await vi.advanceTimersByTimeAsync(150);
      expect(h.bridge.activeViewers()).toBe(0);
    } finally { h.bridge.stop(); vi.useRealTimers(); }
  });
  it("a burst of 10,000 scrolls sends a handful of daemon frames and the last offset wins", async () => {
    vi.useFakeTimers();
    const h = harness();
    try {
      await h.attach();
      for (let i = 1; i <= 10_000; i++) h.downstream.emit("message", Buffer.from(JSON.stringify({ type: "scroll", offset: i })), false);
      expect(h.upstream.sent).toEqual(['{"type":"scroll","offset":1}']);
      await vi.advanceTimersByTimeAsync(2000); // in-flight timeout releases the next one
      expect(h.upstream.sent).toEqual(['{"type":"scroll","offset":1}', '{"type":"scroll","offset":10000}']);
      // output releases the slot; min gap still applies
      h.downstream.emit("message", Buffer.from('{"type":"scroll","offset":7}'), false);
      h.downstream.emit("message", Buffer.from('{"type":"scroll","offset":8}'), false);
      h.upstream.emit("message", Buffer.from("o"), false);
      expect(h.upstream.sent.length).toBe(2); // gap not elapsed yet
      await vi.advanceTimersByTimeAsync(100);
      expect(h.upstream.sent.at(-1)).toBe('{"type":"scroll","offset":8}');
      expect(h.upstream.sent.length).toBe(3);
      h.downstream.emit("message", Buffer.from('{"type":"scroll","offset":9}'), false);
      h.upstream.emit("message", Buffer.from("o"), false);
      expect(h.upstream.sent.length).toBe(3);
      await vi.advanceTimersByTimeAsync(100);
      expect(h.upstream.sent.at(-1)).toBe('{"type":"scroll","offset":9}');
      expect(h.upstream.sent.length).toBe(4);
      expect(h.bridge.activeViewers()).toBe(1);
    } finally { h.bridge.stop(); vi.useRealTimers(); }
  });
  it("refuses terminal authorization until the seat store has synced", async () => {
    let ready = false;
    const h = harness({}, () => ready);
    try {
      expect(await h.bridge.authorize("s1")).toEqual({ status: 403 });
      ready = true;
      expect(await h.bridge.authorize("s1")).toMatchObject({ status: 204 });
    } finally { h.bridge.stop(); }
  });
  it("fails closed for ui off, malformed, unreachable, and a seat principal", async () => {
    const h = harness();
    try {
      expect(await h.bridge.authorize("s1")).toMatchObject({ status: 204 });
      for (const value of [false, "true", undefined]) {
        vi.mocked(h.daemon.getJson).mockResolvedValue({ value });
        expect(await h.bridge.enabled()).toBe(false);
      }
      vi.mocked(h.daemon.getJson).mockRejectedValue(new Error("private content"));
      expect(await h.bridge.enabled()).toBe(false);
      h.config.principal = "builder@acme";
      vi.mocked(h.daemon.getJson).mockResolvedValue({ value: true });
      expect(await h.bridge.authorize("s1")).toEqual({ status: 403 });
    } finally { h.bridge.stop(); }
  });
  it("terminal route reuses bearer, Origin and Host checks", async () => {
    const terminal = vi.fn(async () => ({ status: 204, session: "builder@acme" }));
    const app = createApp({ store: new Store(10), token: "t", capabilities: async () => ({ protocol: { version: "1.0" }, kinds: [], extensions: [], harnesses: [], features: {} }), enabledKinds: () => [], terminal, terminalKey: "k" });
    const headers = { authorization: "Bearer t", host: "127.0.0.1", upgrade: "websocket", "x-seat-internal-upgrade": "k" };
    expect((await app.request("/terminal/s1", { headers: { ...headers, authorization: "wrong" } })).status).toBe(401);
    expect((await app.request("/terminal/s1", { headers: { ...headers, origin: "https://evil" } })).status).toBe(403);
    expect((await app.request("/terminal/s1", { headers: { ...headers, host: "evil" } })).status).toBe(403);
    expect(terminal).not.toHaveBeenCalled();
    expect((await app.request("/terminal/s1", { headers })).status).toBe(204);
    expect((await app.request("/terminal/s1", { headers: { authorization: "Bearer t", "x-seat-internal-upgrade": "k" } })).status).toBe(426);
    // a plain GET claiming Upgrade: websocket never produces the internal session header
    for (const h of [{ authorization: "Bearer t", upgrade: "websocket" } as Record<string, string>, { authorization: "Bearer t", upgrade: "websocket", "x-seat-internal-upgrade": "wrong" }]) {
      const r = await app.request("/terminal/s1", { headers: h as Record<string, string> });
      expect(r.status).toBe(426);
      expect(r.headers.get("x-seat-terminal-session")).toBeNull();
    }
  });
});

describe("terminal denial and timeout cleanup", () => {
  it("cancels denied HTTP bodies and flushes the denial before releasing the socket", async () => {
    const h = harness();
    let canceled = false;
    try {
      const body = new ReadableStream({ cancel() { canceled = true; } });
      h.bridge.upgrade({} as IncomingMessage, h.raw, Buffer.alloc(0), async () => new Response(body, { status: 401 }));
      await new Promise((r) => setTimeout(r, 0));
      expect(canceled).toBe(true);
      expect(h.connect).not.toHaveBeenCalled();
      expect(h.raw.destroyed).toBe(true);
      expect(h.bridge.activeViewers()).toBe(0);
    } finally { h.bridge.stop(); }
  });
  it("times out pending handshakes and releases their viewer budget", async () => {
    vi.useFakeTimers();
    const h = harness();
    try {
      h.bridge.upgrade({} as IncomingMessage, h.raw, Buffer.alloc(0), () => new Promise(() => {}));
      expect(h.bridge.activeViewers()).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.bridge.activeViewers()).toBe(0);
      expect(h.raw.destroyed).toBe(true);
    } finally { h.bridge.stop(); vi.useRealTimers(); }
  });
});

describe("terminal control frame bounds", () => {
  it("answers ping locally and applies the same budget to pong output", async () => {
    const h = harness();
    try {
      await h.attach();
      h.downstream.emit("ping", Buffer.from("hello"));
      expect(h.downstream.sent).toEqual(["pong:hello"]);
      expect(h.upstream.sent).toEqual([]);
      h.downstream.bufferedAmount = 128;
      h.downstream.emit("ping", Buffer.from("hello"));
      expect(h.bridge.activeViewers()).toBe(0);
      expect(h.downstream.sent).toEqual(["pong:hello"]);
    } finally { h.bridge.stop(); }
  });
});


describe("terminal upgrade routing", () => {
  it("validates normalized paths before dispatch so SSE routes cannot be opened by upgrade", () => {
    for (const raw of ["/stream", "/terminal/../stream", "/terminal/..\\stream", "/terminal/%2e%2e/stream", "/terminal/x/extra"]) expect(terminalUpgradeUrl(raw)).toBeUndefined();
    expect(terminalUpgradeUrl("/terminal/seat-1?ignored=true")?.pathname).toBe("/terminal/seat-1");
  });
});

import { Gateway } from "../src/gateway.js";
describe("terminal capability flags in process", () => {
  it("advertises a protocol descriptor only with both flags and fails closed on probe failure", async () => {
    let ui: unknown = true;
    let failure = false;
    const fetchDaemon = vi.fn(async () => { if (failure) throw new Error("unavailable"); return Response.json({ value: ui }); });
    vi.stubGlobal("fetch", fetchDaemon);
    const config = parseConfig({ tokenFile: "t", terminal: { enabled: true, principal: "viewer@acme" } });
    const gateway = new Gateway({ config, token: "t" });
    vi.spyOn(gateway.source, "probe").mockResolvedValue(gateway.source.features());
    try {
      expect(await gateway.capabilities()).toMatchObject({ features: { terminal: true }, terminal: { path: "/terminal/{seatId}", readOnly: true, clientFrames: ["scroll"] } });
      ui = false;
      const off = await gateway.capabilities();
      expect(off.features.terminal).toBe(false);
      expect(off.terminal).toBeUndefined();
      failure = true;
      expect((await gateway.capabilities()).features.terminal).toBe(false);
      config.terminal.enabled = false;
      failure = false; ui = true;
      expect((await gateway.capabilities()).features.terminal).toBe(false);
    } finally { await gateway.stop(); vi.unstubAllGlobals(); }
  });
});
