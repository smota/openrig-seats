import { readFileSync, readdirSync } from "node:fs";
import { request } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Mirror, createSeatClient, type StreamEnvelope } from "@openrig-seats/seat-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auth, MockDaemon, readFrames, seqOf, startGateway, TOKEN, waitFor, type Running } from "./helpers.js";

const schemaDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../seat-protocol/schemas");
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats.default(ajv);
for (const f of readdirSync(schemaDir).filter((x) => x.endsWith(".v1.schema.json"))) ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, f), "utf8")));
const validate = (name: string, v: unknown) => {
  const fn = ajv.getSchema(`https://smota.github.io/openrig-seats/schemas/${name}.v1.schema.json`)!;
  expect(fn(v), JSON.stringify(fn.errors)).toBe(true);
};

let daemon: MockDaemon;
let gw: Running;
beforeEach(async () => {
  daemon = await new MockDaemon().start();
});
afterEach(async () => {
  await gw?.stop();
  await daemon.stop();
});

const get = (path: string, headers: Record<string, string> = auth) => fetch(gw.url + path, { headers });

describe("security", () => {
  beforeEach(async () => {
    gw = await startGateway(daemon);
    await waitFor(() => gw.gateway.store.size() > 5);
  });

  it("requires the bearer token on every route", async () => {
    for (const path of ["/capabilities", "/stream", "/snapshot", "/snapshot/seat", "/act", "/nope"]) {
      expect((await get(path, {})).status, path).toBe(401);
      expect((await get(path, { authorization: "Bearer wrong" })).status, path).toBe(401);
      expect((await get(path, { authorization: TOKEN })).status, path).toBe(401);
    }
    expect((await get("/capabilities")).status).toBe(200);
  });

  it("refuses a foreign Origin even with a valid token", async () => {
    const res = await get("/capabilities", { ...auth, origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await get("/stream", { ...auth, origin: "http://127.0.0.1:1" })).status).toBe(403);
  });

  it("refuses a Host header that is not loopback (DNS rebinding)", async () => {
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const u = new URL(gw.url);
        const req = request({ host: u.hostname, port: Number(u.port), path: "/capabilities", headers: { ...auth, host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    expect(await status("rebind.example")).toBe(403);
    expect(await status("rebind.example:8088")).toBe(403);
    expect(await status(`127.0.0.1:${new URL(gw.url).port}`)).toBe(200);
    expect(await status("localhost:8088")).toBe(200);
  });

  it("is read-only: no /act, no writes", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await fetch(gw.url + "/act", { method, headers: { ...auth, "content-type": "application/json" }, body: method === "DELETE" ? undefined : "{}" });
      expect(res.status, method).toBe(405);
    }
    expect((await get("/act")).status).toBe(404);
  });

  it("binds loopback only and refuses a non-loopback bind unless allowed", async () => {
    const { parseConfig, Gateway } = await import("../src/index.js");
    expect(() => parseConfig({ tokenFile: "x", listen: { host: "0.0.0.0" } })).toThrow(/loopback/);
    expect(() => parseConfig({ tokenFile: "x", listen: { host: "192.168.0.4" } })).toThrow(/loopback/);
    expect(() => parseConfig({ tokenFile: "x", listen: { host: "0.0.0.0" }, allowNonLoopback: true })).not.toThrow();
    expect(() => parseConfig({ tokenFile: "x", daemonUrl: "http://example.com:7433" })).toThrow(/loopback/);
    expect(() => new Gateway({ config: { ...parseConfig({ tokenFile: "x" }), listen: { host: "0.0.0.0", port: 0 } }, token: "t" })).toThrow(/non-loopback/);
    expect(gw.url.startsWith("http://127.0.0.1:")).toBe(true);
  });

  it("never logs a token and never sends one to the daemon unless configured", async () => {
    await get("/capabilities");
    expect(gw.logs.join("\n")).not.toContain(TOKEN);
    expect(daemon.requests.every((r) => r.authorization === undefined && r.method === "GET")).toBe(true);
  });

  it("sends the daemon token only when configured, as a header, GET only", async () => {
    const other = await startGateway(daemon, { daemonToken: "daemon-secret" });
    await waitFor(() => other.gateway.store.size() > 5);
    const withToken = daemon.requests.filter((r) => r.authorization === "Bearer daemon-secret");
    expect(withToken.length).toBeGreaterThan(0);
    expect(withToken.every((r) => r.method === "GET" && !r.query.includes("daemon-secret"))).toBe(true);
    expect(other.logs.join("\n")).not.toContain("daemon-secret");
    await other.stop();
  });
});

describe("capabilities and snapshot", () => {
  it("declares protocol, kinds, harnesses and features; act is absent", async () => {
    gw = await startGateway(daemon);
    await waitFor(() => gw.gateway.store.size() > 5);
    const caps = await (await get("/capabilities")).json();
    validate("capabilities", caps);
    expect(caps.protocol.version).toBe("1.0");
    expect(caps.kinds).toEqual(["host", "rig", "seat", "attention", "work"]);
    expect(caps.harnesses).toEqual(["agy", "claude-code", "codex"]);
    expect(caps.features).toMatchObject({ act: false, terminal: false, attention: true, work: true, resume: true });
  });

  it("a feature whose daemon route is 404 is off, its kind is gone, and its snapshot is 404", async () => {
    daemon.missing.add("/api/queue/list");
    gw = await startGateway(daemon);
    await waitFor(() => gw.gateway.store.items("seat").length === 4);
    const caps = await (await get("/capabilities")).json();
    expect(caps.features.work).toBe(false);
    expect(caps.kinds).not.toContain("work");
    expect((await get("/snapshot/work")).status).toBe(404);
    expect((await get("/snapshot/seat")).status).toBe(200);
  });

  it("re-probes: a route that appears later turns the feature on", async () => {
    daemon.missing.add("/api/attention");
    gw = await startGateway(daemon, { probeTtlMs: 0 });
    expect((await (await get("/capabilities")).json()).features.attention).toBe(false);
    daemon.missing.delete("/api/attention");
    expect((await (await get("/capabilities")).json()).features.attention).toBe(true);
  });

  it("serves a snapshot per kind with a cursor, valid items, and an all-kinds form", async () => {
    gw = await startGateway(daemon);
    await waitFor(() => gw.gateway.store.items("work").length === 2);
    for (const kind of ["host", "rig", "seat", "attention", "work"]) {
      const body = await (await get(`/snapshot/${kind}`)).json();
      expect(body.kind).toBe(kind);
      expect(body.cursor).toMatch(/^[0-9a-f]+\.\d+$/);
      expect(body.items.length).toBeGreaterThan(0);
      for (const item of body.items) validate(kind, item);
    }
    expect((await (await get("/snapshot?kind=rig")).json()).items).toHaveLength(2);
    const all = await (await get("/snapshot")).json();
    expect(Object.keys(all.kinds).sort()).toEqual(["attention", "host", "rig", "seat", "work"]);
    expect((await get("/snapshot/turn")).status).toBe(404);
    expect((await get("/snapshot/bogus")).status).toBe(404);
  });
});

describe("stream", () => {
  beforeEach(async () => {
    gw = await startGateway(daemon);
    await waitFor(() => gw.gateway.store.items("work").length === 2);
  });

  it("sends the full state to a new client as valid envelopes with increasing cursors", async () => {
    const res = await get("/stream");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const frames = (await readFrames(res, (f) => f.filter((x) => x.id).length >= gw.gateway.store.size())).filter((f) => f.id);
    expect(frames.length).toBe(gw.gateway.store.size());
    const seqs = frames.map((f) => seqOf(f.id!));
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
    for (const f of frames) {
      const env = JSON.parse(f.data) as StreamEnvelope;
      expect(env.cursor).toBe(f.id);
      validate("stream-envelope", env);
    }
  });

  it("resumes with Last-Event-ID: only newer entries, none missed", async () => {
    const first = await readFrames(await get("/stream"), (f) => f.filter((x) => x.id).length >= gw.gateway.store.size());
    const lastId = first.filter((f) => f.id).at(-1)!.id!;
    daemon.attention = { ...daemon.attention, items: (daemon.attention.items as unknown[]).slice(1) };
    daemon.emit({ type: "queue.updated", qitemId: "q-100" });
    await waitFor(() => gw.gateway.store.head() > seqOf(lastId));
    const res = await fetch(gw.url + "/stream", { headers: { ...auth, "last-event-id": lastId } });
    const frames = (await readFrames(res, (f) => f.some((x) => x.data.includes('"delete"')), 3000)).filter((f) => f.id);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    for (const f of frames) expect(seqOf(f.id!)).toBeGreaterThan(seqOf(lastId));
    const env = frames.map((f) => JSON.parse(f.data) as StreamEnvelope);
    expect(env.some((e) => e.kind === "attention" && e.id === "queue:q-100" && e.op === "delete")).toBe(true);
  });

  it("answers an unknown cursor (for example from before a gateway restart) with reset then the full state", async () => {
    const res = await fetch(gw.url + "/stream", { headers: { ...auth, "last-event-id": "deadbeef0000.7" } });
    const frames = await readFrames(res, (f) => f.filter((x) => x.id).length >= gw.gateway.store.size());
    const control = frames.find((f) => f.event === "control");
    expect(control).toBeTruthy();
    expect(control!.id).toBeUndefined(); // a control message never moves the cursor
    validate("stream-control", JSON.parse(control!.data));
    expect(JSON.parse(control!.data)).toEqual({ type: "reset", reason: "cursor-unknown" });
    expect(frames.filter((f) => f.id).length).toBe(gw.gateway.store.size());
    expect(gw.gateway.stats().resets).toBe(1);
  });

  it("streams live changes after the snapshot, with a heartbeat comment when idle", async () => {
    await gw.stop();
    gw = await startGateway(daemon, { heartbeatMs: 50 });
    await waitFor(() => gw.gateway.store.items("work").length === 2);
    const res = await get("/stream");
    setTimeout(() => {
      daemon.queue = daemon.queue.map((q) => (q.qitemId === "q-200" ? { ...q, state: "blocked" } : q));
      daemon.emit({ type: "queue.updated", qitemId: "q-200" });
    }, 150);
    const frames = await readFrames(res, (f) => f.some((x) => x.id && x.data.includes('"q-200"') && x.data.includes("blocked")) && f.some((x) => x.comment === "ping"));
    expect(frames.some((x) => x.comment === "ping")).toBe(true);
    expect(frames.some((x) => x.id && x.data.includes("blocked"))).toBe(true);
  });

  it("works with the protocol client end to end and reconnects with its cursor", async () => {
    const client = createSeatClient({ baseUrl: gw.url, token: TOKEN, minDelayMs: 5 });
    const mirror = new Mirror();
    const cursors: string[] = [];
    const ctl = new AbortController();
    const done = (async () => {
      for await (const env of client.stream({ signal: ctl.signal, onCursor: (c) => cursors.push(c) })) mirror.apply(env);
    })();
    await waitFor(() => mirror.list("seat").length === 4);
    expect(mirror.list("host")).toHaveLength(1);
    // drop every stream; the client reconnects with its cursor while the daemon changes
    daemon.ps = daemon.ps.filter((r) => r.rigId !== "rig-acme-2");
    daemon.nodes.delete("rig-acme-2");
    daemon.emit({ type: "rig.deleted", rigId: "rig-acme-2" });
    await waitFor(() => mirror.list("rig").length === 1 && mirror.list("seat").length === 3);
    ctl.abort();
    await done;
    const seqs = cursors.map(seqOf);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("reports an offline host through the stream when the daemon goes away", async () => {
    const mirror = new Mirror();
    const client = createSeatClient({ baseUrl: gw.url, token: TOKEN, minDelayMs: 5 });
    const ctl = new AbortController();
    const done = (async () => {
      for await (const env of client.stream({ signal: ctl.signal })) mirror.apply(env);
    })();
    await waitFor(() => mirror.list("host")[0]?.state === "online");
    await daemon.stop();
    await waitFor(() => mirror.list("host")[0]?.state === "offline");
    expect(mirror.list("seat").length).toBe(4); // cached state stays visible
    await daemon.start(Number(new URL(daemon.url).port));
    await waitFor(() => mirror.list("host")[0]?.state === "online");
    ctl.abort();
    await done;
  });
});
