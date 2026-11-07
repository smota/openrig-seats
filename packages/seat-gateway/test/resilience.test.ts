import { request } from "node:http";
import { serve } from "@hono/node-server";
import { Mirror, createSeatClient, type StreamEnvelope } from "@openrig-seats/seat-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, Store } from "../src/index.js";
import { auth, MockDaemon, readFrames, seqOf, startGateway, TOKEN, waitFor, type Running } from "./helpers.js";

let daemon: MockDaemon;
let gw: Running | undefined;
beforeEach(async () => {
  daemon = await new MockDaemon().start();
});
afterEach(async () => {
  await gw?.stop();
  gw = undefined;
  await daemon.stop();
});

function follow(url: string) {
  const client = createSeatClient({ baseUrl: url, token: TOKEN, minDelayMs: 5, maxDelayMs: 40 });
  const mirror = new Mirror();
  const cursors: string[] = [];
  const resets: string[] = [];
  const ctl = new AbortController();
  const done = (async () => {
    for await (const env of client.stream({ signal: ctl.signal, onCursor: (c) => cursors.push(c), onReset: (r) => resets.push(String(r.reason)) })) mirror.apply(env);
  })();
  return { mirror, cursors, resets, stop: async () => (ctl.abort(), done) };
}

const sortById = (xs: Array<Record<string, unknown>>) => [...xs].sort((a, b) => String(a.id).localeCompare(String(b.id)));

describe("daemon restart", () => {
  it("converges after a restart whose event log starts over (seq regress -> full resync), cursors stay monotonic", async () => {
    gw = await startGateway(daemon);
    const c = follow(gw.url);
    await waitFor(() => c.mirror.list("seat").length === 4);
    for (let i = 0; i < 4; i++) daemon.emit({ type: "chat.message" });
    await waitFor(() => gw!.gateway.source.status().lastSeq === 4);
    // the restarted daemon has different state and a fresh log
    daemon.ps = daemon.ps.filter((r) => r.rigId !== "rig-acme-2");
    daemon.nodes.delete("rig-acme-2");
    daemon.queue = daemon.queue.filter((q) => q.qitemId !== "q-200");
    await daemon.restart({ resetLog: true });
    await waitFor(() => daemon.streamCount === 1);
    daemon.emit({ type: "chat.message" });
    await waitFor(() => c.mirror.list("rig").length === 1 && c.mirror.list("seat").length === 3 && c.mirror.list("work").length === 1, 4000, "convergence");
    expect(sortById(c.mirror.list("seat"))).toEqual(sortById(gw.gateway.store.items("seat")));
    const seqs = c.cursors.map(seqOf);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    await c.stop();
  });

  it("converges after a sequence gap too", async () => {
    gw = await startGateway(daemon);
    const c = follow(gw.url);
    await waitFor(() => c.mirror.list("work").length === 2);
    daemon.emit({ type: "chat.message" });
    await waitFor(() => gw!.gateway.source.status().lastSeq === 1);
    daemon.queue = daemon.queue.filter((q) => q.qitemId !== "q-200");
    daemon.skipSeq(10);
    daemon.emit({ type: "chat.message" });
    await waitFor(() => c.mirror.list("work").length === 1, 4000, "work deleted by resync");
    await c.stop();
  });

  it("keeps serving cached state while the daemon is down", async () => {
    gw = await startGateway(daemon);
    await waitFor(() => gw!.gateway.store.items("seat").length === 4);
    await daemon.stop();
    await waitFor(() => (gw!.gateway.store.items("host")[0] as { state?: string })?.state === "offline");
    const res = await fetch(gw.url + "/snapshot/seat", { headers: auth });
    expect((await res.json()).items).toHaveLength(4);
    await daemon.start(Number(new URL(daemon.url).port));
  });
});

describe("gateway restart", () => {
  it("rebuilds from the daemon, and an old cursor gets a reset and the full state", async () => {
    gw = await startGateway(daemon);
    await waitFor(() => gw!.gateway.store.items("work").length === 2);
    const firstFrames = await readFrames(await fetch(gw.url + "/stream", { headers: auth }), (f) => f.filter((x) => x.id).length >= gw!.gateway.store.size());
    const oldCursor = firstFrames.filter((f) => f.id).at(-1)!.id!;
    const port = Number(new URL(gw.url).port);
    await gw.stop();
    gw = await startGateway(daemon, {}, { listen: { host: "127.0.0.1", port } });
    await waitFor(() => gw!.gateway.store.items("work").length === 2);
    const frames = await readFrames(await fetch(gw.url + "/stream", { headers: { ...auth, "last-event-id": oldCursor } }), (f) => f.filter((x) => x.id).length >= gw!.gateway.store.size());
    expect(frames.some((f) => f.event === "control" && f.data.includes('"reset"'))).toBe(true);
    expect(frames.filter((f) => f.id).length).toBe(gw.gateway.store.size());
    expect(oldCursor.split(".")[0]).not.toBe(gw.gateway.store.epoch);
  });

  it("a seat that disappears while the gateway is down is gone from a following client's mirror after the restart", async () => {
    gw = await startGateway(daemon);
    const c = follow(gw.url);
    await waitFor(() => c.mirror.list("seat").length === 4);
    const port = Number(new URL(gw.url).port);
    await gw.stop();
    daemon.ps = daemon.ps.filter((r) => r.rigId !== "rig-acme-2");
    daemon.nodes.delete("rig-acme-2");
    gw = await startGateway(daemon, {}, { listen: { host: "127.0.0.1", port } });
    await waitFor(() => c.resets.length === 1 && c.mirror.list("seat").length === 3, 6000, "mirror reset and rebuilt");
    expect(c.resets).toEqual(["cursor-unknown"]);
    for (const k of ["host", "rig", "seat", "attention", "work"]) expect(sortById(c.mirror.list(k)), k).toEqual(sortById(gw.gateway.store.items(k)));
    await c.stop();
  });

  it("never opens the daemon's database or writes: only GET requests reach the daemon", async () => {
    gw = await startGateway(daemon);
    await waitFor(() => gw!.gateway.store.items("work").length === 2);
    expect(daemon.requests.length).toBeGreaterThan(0);
    expect(new Set(daemon.requests.map((r) => r.method))).toEqual(new Set(["GET"]));
    expect(daemon.requests.every((r) => r.origin === undefined)).toBe(true);
  });
});

describe("slow and stalled clients", () => {
  it("a slow client does not slow the others, queues nothing, and converges when it catches up", async () => {
    gw = await startGateway(daemon);
    await waitFor(() => gw!.gateway.store.items("work").length === 2);
    const fast = follow(gw.url);
    await waitFor(() => fast.mirror.list("work").length === 2);

    // The slow client connects and then stops reading.
    const slowFrames: StreamEnvelope[] = [];
    const slow = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const u = new URL(gw!.url);
      const req = request({ host: u.hostname, port: Number(u.port), path: "/stream", headers: auth }, resolve);
      req.on("error", reject);
      req.end();
    });
    slow.pause();

    const before = gw.gateway.store.size();
    for (let i = 0; i < 150; i++) {
      daemon.queue = [...daemon.queue.filter((q) => q.qitemId !== "q-200"), { ...daemon.queue.find((q) => q.qitemId === "q-200")!, summary: `rev ${i}`, tsUpdated: new Date(1_800_000_000_000 + i * 1000).toISOString() }];
      daemon.emit({ type: "queue.updated", qitemId: "q-200" });
      if (i % 10 === 0) await new Promise((r) => setTimeout(r, 15));
    }
    await waitFor(() => (fast.mirror.get("work", "q-200") as { title?: string } | undefined)?.title === "rev 149", 4000, "fast client current");
    expect(gw.gateway.store.size()).toBeLessThanOrEqual(before + 2); // bounded: nothing queued for the slow client

    // The slow client resumes: it receives the newest state, in order, and it matches.
    let buf = "";
    const mirror = new Mirror();
    const seen: number[] = [];
    slow.setEncoding("utf8");
    slow.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split("\n").find((l) => l.startsWith("data:"));
        if (!data) continue;
        const env = JSON.parse(data.slice(5)) as StreamEnvelope;
        slowFrames.push(env);
        seen.push(seqOf(env.cursor));
        mirror.apply(env);
      }
    });
    slow.resume();
    await waitFor(() => (mirror.get("work", "q-200") as { title?: string } | undefined)?.title === "rev 149", 4000, "slow client current");
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
    expect(slowFrames.filter((e) => e.kind === "work" && e.id === "q-200").length).toBeLessThan(150); // conflated, not replayed
    expect(sortById(mirror.list("seat"))).toEqual(sortById(gw.gateway.store.items("seat")));
    slow.destroy();
    await fast.stop();
  });

  it("drops a client that stops reading entirely", async () => {
    const store = new Store(100, "aa");
    const big = "x".repeat(200_000);
    for (let i = 0; i < 80; i++) store.apply({ kind: "seat", id: `s${i}`, op: "upsert", data: { id: `s${i}`, updatedAt: "2026-11-07T12:00:00Z", pad: big } });
    let closed = 0;
    const app = createApp({ store, token: TOKEN, capabilities: async () => ({}) as never, enabledKinds: () => ["seat"], writeTimeoutMs: 300, onStream: (e) => e === "close" && closed++ });
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => server.once("listening", () => r()));
    const port = (server.address() as { port: number }).port;
    const res = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/stream", headers: auth }, resolve);
      req.on("error", reject);
      req.end();
    });
    res.pause();
    await waitFor(() => closed === 1, 6000, "stalled client dropped");
    res.destroy();
    (server as unknown as { closeAllConnections: () => void }).closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
});

async function serveStore(store: Store, opts: { heartbeatMs?: number } = {}) {
  const app = createApp({ store, token: TOKEN, capabilities: async () => ({}) as never, enabledKinds: () => ["seat"], ...opts });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    close: async () => {
      (server as unknown as { closeAllConnections: () => void }).closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
const seatChange = (id: string, v = 1) => ({ kind: "seat" as const, id, op: "upsert" as const, data: { id, updatedAt: "2026-11-07T12:00:00Z", rigId: "r", name: id, state: "idle", v } });

describe("pruned tombstones", () => {
  it("resets an established stream whose client missed pruned deletes: its mirror ends equal to the store", async () => {
    const store = new Store(1, "aa");
    for (const id of ["a", "b", "c"]) store.apply(seatChange(id));
    const srv = await serveStore(store);
    const c = follow(srv.url);
    await waitFor(() => c.mirror.list("seat").length === 3);
    // three deletes in one tick with room for one tombstone: two are pruned before the stream can send them
    for (const id of ["a", "b", "c"]) store.apply({ kind: "seat", id, op: "delete" });
    store.apply(seatChange("d"));
    await waitFor(() => c.resets.includes("cursor-pruned"), 4000, "reset");
    await waitFor(() => JSON.stringify(sortById(c.mirror.list("seat"))) === JSON.stringify(sortById(store.items("seat"))), 4000, "mirror equals store");
    expect(c.mirror.list("seat").map((s) => s.id)).toEqual(["d"]);
    const seqs = c.cursors.map(seqOf);
    expect(new Set(seqs).size).toBe(seqs.length);
    await c.stop();
    await srv.close();
  });

  it("a cursor already below the pruning floor gets a reset on connect, and the client mirror equals the snapshot", async () => {
    const store = new Store(1, "aa");
    for (const id of ["a", "b"]) store.apply(seatChange(id));
    const srv = await serveStore(store);
    const c = follow(srv.url);
    await waitFor(() => c.mirror.list("seat").length === 2);
    await c.stop();
    const stale = c.cursors.at(-1)!;
    for (const id of ["a", "b"]) store.apply({ kind: "seat", id, op: "delete" });
    store.apply(seatChange("e"));
    expect(store.resolve(stale)).toMatchObject({ reset: true, reason: "cursor-pruned" });
    const mirror = new Mirror();
    const client = createSeatClient({ baseUrl: srv.url, token: TOKEN, minDelayMs: 5 });
    mirror.apply({ kind: "seat", id: "a", op: "upsert", data: { id: "a" } }); // stale content from before
    const ctl = new AbortController();
    let resets = 0;
    const done = (async () => {
      for await (const it of client.stream({ cursor: stale, signal: ctl.signal, onReset: () => resets++ })) mirror.apply(it);
    })();
    await waitFor(() => resets === 1 && mirror.list("seat").length === 1, 4000, "reset and rebuilt");
    expect(resets).toBe(1);
    expect(mirror.list("seat").map((s) => s.id)).toEqual(["e"]);
    ctl.abort();
    await done;
    await srv.close();
  });

  it("tombstoneLimit 0 does not spin: waiting is idle, resets stay proportional to changes", async () => {
    const store = new Store(0, "aa");
    store.apply(seatChange("x"));
    store.apply({ kind: "seat", id: "x", op: "delete" });
    // waiting on the head that was already processed must not resolve at once
    const t0 = Date.now();
    await store.waitAfter(store.head(), new AbortController().signal, 60);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
    const srv = await serveStore(store, { heartbeatMs: 10_000 });
    const c = follow(srv.url);
    await waitFor(() => c.resets.length >= 0 && c.cursors.length >= 0, 500).catch(() => {});
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10); // starves if a microtask loop spins
    for (let i = 0; i < 20; i++) {
      store.apply(seatChange("y"));
      store.apply({ kind: "seat", id: "y", op: "delete" });
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 300));
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(15);
    expect(c.resets.length).toBeLessThanOrEqual(25);
    expect(c.mirror.list("seat")).toEqual([]);
    // idle: no traffic at all once settled
    const frames = await readFrames(await fetch(srv.url + "/stream", { headers: auth }), () => false, 300);
    expect(frames.length).toBeLessThan(6);
    await c.stop();
    await srv.close();
  });
});
