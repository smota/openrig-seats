import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonClient, OpenRigSource, type Change } from "../src/index.js";
import { waitFor } from "./helpers.js";
import { MockDaemon } from "./mock-daemon.js";

const schemaDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../seat-protocol/schemas");
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats.default(ajv);
for (const f of readdirSync(schemaDir).filter((x) => x.endsWith(".v1.schema.json"))) ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, f), "utf8")));
const validator = (kind: string) => ajv.getSchema(`https://smota.github.io/openrig-seats/schemas/${kind}.v1.schema.json`)!;

let daemon: MockDaemon;
let source: OpenRigSource;
let changes: Change[];

const fast = { retryMinMs: 20, retryMaxMs: 160, debounceMs: 5, reconnectMinMs: 10, reconnectMaxMs: 40, resyncIntervalMs: 0 };
function make(extra: Partial<ConstructorParameters<typeof OpenRigSource>[0]> = {}) {
  source = new OpenRigSource({ daemon: new DaemonClient({ baseUrl: daemon.url }), onChange: (c) => changes.push(c), hostId: "host-1", hostName: "acme-host", ...fast, ...extra });
  return source;
}
const last = (kind: string, id: string) => [...changes].reverse().find((c) => c.kind === kind && c.id === id);

beforeEach(async () => {
  daemon = await new MockDaemon().start();
  changes = [];
});
afterEach(async () => {
  await source?.stop();
  await daemon.stop();
});

describe("snapshot mapping", () => {
  it("produces valid host, rig, seat, attention and work from the snapshots", async () => {
    make();
    await source.resync();
    for (const c of changes) if (c.op === "upsert") expect(validator(c.kind)(c.data), `${c.kind} ${c.id}: ${JSON.stringify(validator(c.kind).errors)}`).toBe(true);
    const ids = (k: string) => changes.filter((c) => c.kind === k).map((c) => c.id).sort();
    expect(ids("host")).toEqual(["host-1"]);
    expect(ids("rig")).toEqual(["rig-acme-1", "rig-acme-2"]);
    expect(ids("seat")).toEqual(["node-a1", "node-a2", "node-a3", "node-b1"]); // infrastructure node skipped
    expect(ids("attention")).toEqual(["queue-update:q-101", "queue:q-100"]);
    expect(ids("work")).toEqual(["q-100", "q-200"]); // closed item is not work
  });

  it("maps seat state, generation, harness and attention links", async () => {
    make();
    await source.resync();
    expect(last("seat", "node-a1")?.data).toMatchObject({ rigId: "rig-acme-1", name: "lead.planner", harness: "claude-code", state: "active", generationId: "gen-001" });
    expect(last("seat", "node-a2")?.data).toMatchObject({ state: "needs-input", attentionIds: ["queue:q-100"] });
    expect(last("seat", "node-a3")?.data).toMatchObject({ state: "stopped", harness: "agy" });
    expect(last("seat", "node-a3")?.data).not.toHaveProperty("generationId");
    expect(last("seat", "node-b1")?.data).toMatchObject({ state: "idle" });
  });

  it("maps rigs, attention severity and work links", async () => {
    make();
    await source.resync();
    expect(last("rig", "rig-acme-1")?.data).toMatchObject({ hostId: "host-1", name: "acme-ops", state: "partial", seatCount: 3 });
    expect(last("attention", "queue:q-100")?.data).toMatchObject({ severity: "warning", state: "open", seatId: "node-a2", title: "Request for a person: queue:q-100", since: "2026-11-07T11:30:00.000Z" });
    expect(last("attention", "queue:q-100")?.data).not.toHaveProperty("impact");
    expect(last("attention", "queue-update:q-101")?.data).toMatchObject({ severity: "info", title: "Update for a person: queue-update:q-101" });
    expect(last("work", "q-100")?.data).toMatchObject({ state: "pending", creatorSeatId: "node-a2", waitingOnHuman: true });
    expect(last("work", "q-200")?.data).toMatchObject({ state: "in-progress", assigneeSeatId: "node-b1", creatorSeatId: "node-a1" });
    expect(last("work", "q-200")?.data).not.toHaveProperty("waitingOnHuman");
  });

  it("emits nothing for an unchanged second read", async () => {
    make();
    await source.resync();
    const n = changes.length;
    await source.resync();
    expect(changes.length).toBe(n);
  });

  it("never copies request bodies into the protocol", async () => {
    make();
    await source.resync();
    expect(JSON.stringify(changes)).not.toContain("Details follow");
  });
});

describe("events", () => {
  it("opens the stream with a bounded replay budget (default 2000) and no Last-Event-ID on the first connection", async () => {
    make().start();
    await waitFor(() => changes.length > 0 && daemon.streamCount === 1);
    const req = daemon.requests.find((r) => r.path === "/api/events")!;
    expect(req.query).toBe("?replay=2000");
    expect(req.lastEventId).toBeUndefined();
  });

  it("uses a configured replay budget and feeds the replayed events through the same mapper", async () => {
    for (let i = 0; i < 5; i++) daemon.emit({ type: "queue.claimed", qitemId: `q-${i}`, destinationSession: "dev-writer@acme-ops", claimedAt: "x", closureRequiredAt: null, summary: "c" });
    make({ eventReplay: 3 }).start();
    await waitFor(() => source.status().lastSeq === 5 && daemon.streamCount === 1, 4000, "replay");
    expect(daemon.requests.find((r) => r.path === "/api/events")!.query).toBe("?replay=3");
    expect(source.current("x-openrig.event").map((e) => e.seq).sort()).toEqual([3, 4, 5]);
  });

  it("drops the cursor and replays the budget again when the daemon restarted", async () => {
    make().start();
    await waitFor(() => daemon.streamCount === 1 && last("seat", "node-a1"));
    daemon.emit({ type: "queue.claimed", qitemId: "q-1", destinationSession: "dev-writer@acme-ops", claimedAt: "x", closureRequiredAt: null, summary: "c" });
    await waitFor(() => source.current("x-openrig.event").length === 1);
    await daemon.restart({ resetLog: true });
    daemon.emit({ type: "queue.created", qitemId: "q-9", sourceSession: "a@b", destinationSession: "dev-writer@acme-ops", priority: "routine", tier: null, summary: "n" });
    await waitFor(() => source.current("x-openrig.event").length === 1 && source.current("x-openrig.event")[0]!.workId === "q-9", 6000, "fresh ring");
    const reqs = daemon.requests.filter((r) => r.path === "/api/events");
    expect(reqs.at(-1)!.lastEventId).toBeUndefined();
    expect(reqs.at(-1)!.query).toBe("?replay=2000");
  });

  it("upserts a seat from agent.activity and the daemon's next read", async () => {
    make().start();
    await waitFor(() => daemon.streamCount === 1 && last("seat", "node-b1"));
    const node = daemon.nodes.get("rig-acme-2")![0]!;
    node.agentActivity = { state: "needs_input", reason: "asking", evidenceSource: "runtime_hook", sampledAt: "x", evidence: null };
    node.arbitratedNeedsInput = true;
    daemon.emit({ type: "agent.activity", rigId: "rig-acme-2", nodeId: "node-b1", sessionName: "dev-builder@acme-build", runtime: "claude-code", activity: node.agentActivity });
    await waitFor(() => last("seat", "node-b1")?.data?.state === "needs-input", 4000, "seat needs-input");
  });

  it("deletes a rig and its seats on rig.deleted", async () => {
    make().start();
    await waitFor(() => daemon.streamCount === 1 && last("seat", "node-b1"));
    daemon.ps = daemon.ps.filter((r) => r.rigId !== "rig-acme-2");
    daemon.nodes.delete("rig-acme-2");
    daemon.emit({ type: "rig.deleted", rigId: "rig-acme-2" });
    await waitFor(() => last("rig", "rig-acme-2")?.op === "delete" && last("seat", "node-b1")?.op === "delete");
  });

  it("deletes a seat on node.removed and updates the rig count", async () => {
    make().start();
    await waitFor(() => daemon.streamCount === 1 && last("seat", "node-a3"));
    daemon.nodes.set("rig-acme-1", daemon.nodes.get("rig-acme-1")!.filter((n) => n.nodeId !== "node-a3"));
    daemon.ps[0]!.nodeCount = 2;
    daemon.emit({ type: "node.removed", rigId: "rig-acme-1", nodeId: "node-a3" });
    await waitFor(() => last("seat", "node-a3")?.op === "delete" && (last("rig", "rig-acme-1")?.data as { seatCount?: number })?.seatCount === 2);
  });

  it("turns queue events into attention and work changes, deleting what closed", async () => {
    make().start();
    await waitFor(() => daemon.streamCount === 1 && last("work", "q-100"));
    daemon.attention = { ...daemon.attention, items: (daemon.attention.items as unknown[]).slice(1) };
    daemon.queue = daemon.queue.map((q) => (q.qitemId === "q-100" ? { ...q, state: "done" } : q));
    daemon.emit({ type: "queue.updated", qitemId: "q-100", fromState: "pending", toState: "done", closureReason: null, closureTarget: null, actorSession: "human@acme", summary: null });
    await waitFor(() => last("attention", "queue:q-100")?.op === "delete" && last("work", "q-100")?.op === "delete");
    expect(last("work", "q-200")?.op).toBe("upsert");
  });

  it("ignores event types it does not map", async () => {
    make().start();
    await waitFor(() => daemon.streamCount === 1 && changes.length > 0);
    const before = daemon.requests.length;
    daemon.emit({ type: "chat.message", rigId: "rig-acme-1" });
    await new Promise((r) => setTimeout(r, 60));
    expect(daemon.requests.length).toBe(before);
  });

  it("coalesces a burst of events into few reads", async () => {
    make({ debounceMs: 40 }).start();
    await waitFor(() => daemon.streamCount === 1 && changes.length > 0);
    const before = daemon.requests.filter((r) => r.path.endsWith("/nodes")).length;
    for (let i = 0; i < 30; i++) daemon.emit({ type: "node.model_changed", rigId: "rig-acme-1", nodeId: "node-a1" });
    await waitFor(() => daemon.requests.filter((r) => r.path.endsWith("/nodes")).length > before);
    await new Promise((r) => setTimeout(r, 120));
    expect(daemon.requests.filter((r) => r.path.endsWith("/nodes")).length - before).toBeLessThanOrEqual(3);
  });
});

describe("reconnect and restart", () => {
  it("resumes with Last-Event-ID and applies replayed events without a full resync", async () => {
    make().start();
    await waitFor(() => daemon.streamCount === 1 && changes.length > 0);
    daemon.emit({ type: "chat.message", rigId: "rig-acme-1" });
    await waitFor(() => source.status().lastSeq === 1);
    const psCalls = () => daemon.requests.filter((r) => r.path === "/api/ps").length;
    const before = psCalls();
    daemon.dropStreams();
    daemon.emit({ type: "chat.message", rigId: "rig-acme-1" }); // missed while down
    await waitFor(() => source.status().lastSeq === 2, 4000, "replayed event");
    const resumed = daemon.requests.filter((r) => r.path === "/api/events").at(-1)!;
    expect(resumed.lastEventId).toBe("1");
    expect(resumed.query).toBe("?replay=0");
    expect(psCalls()).toBe(before + 1); // every reconnect reads everything again
    expect(source.status().resyncs).toBe(2);
  });

  it("does a full resync on a sequence gap and drops what vanished", async () => {
    make().start();
    await waitFor(() => daemon.streamCount === 1 && last("seat", "node-b1"));
    daemon.emit({ type: "chat.message" });
    await waitFor(() => source.status().lastSeq === 1);
    daemon.ps = daemon.ps.filter((r) => r.rigId !== "rig-acme-2");
    daemon.nodes.delete("rig-acme-2");
    daemon.skipSeq(5);
    daemon.emit({ type: "chat.message" });
    await waitFor(() => last("rig", "rig-acme-2")?.op === "delete" && last("seat", "node-b1")?.op === "delete", 4000, "resync deletes");
    expect(source.status().resyncs).toBe(2);
  });

  it("marks the host offline while the daemon is down, keeps the cache, and recovers", async () => {
    make().start();
    await waitFor(() => daemon.streamCount === 1 && last("host", "host-1")?.data?.state === "online");
    await daemon.stop();
    await waitFor(() => last("host", "host-1")?.data?.state === "offline", 4000, "offline");
    expect(last("seat", "node-a1")?.op).toBe("upsert");
    await daemon.start(Number(new URL(daemon.url).port));
    await waitFor(() => last("host", "host-1")?.data?.state === "online", 4000, "online again");
  });

  it("resyncs when the daemon restarts with a log that starts over", async () => {
    make().start();
    await waitFor(() => daemon.streamCount === 1 && last("seat", "node-b1"));
    for (let i = 0; i < 5; i++) daemon.emit({ type: "chat.message" });
    await waitFor(() => source.status().lastSeq === 5);
    daemon.ps = daemon.ps.filter((r) => r.rigId !== "rig-acme-2");
    daemon.nodes.delete("rig-acme-2");
    await daemon.restart({ resetLog: true });
    await waitFor(() => daemon.streamCount === 1);
    daemon.emit({ type: "chat.message" }); // seq 1 < 5: the log restarted
    await waitFor(() => last("rig", "rig-acme-2")?.op === "delete", 4000, "resync after reset");
  });

  it("host is unknown before first contact and offline after a failed one", async () => {
    await daemon.stop();
    make().start();
    await waitFor(() => last("host", "host-1")?.data?.state === "offline");
    await daemon.start();
  });
});

describe("features", () => {
  it("probe turns a 404 route off and keeps the rest", async () => {
    daemon.missing.add("/api/queue/list");
    make();
    const f = await source.probe();
    expect(f).toMatchObject({ host: true, rig: true, attention: true, work: false });
    await source.resync();
    expect(changes.some((c) => c.kind === "work")).toBe(false);
    expect(changes.some((c) => c.kind === "attention")).toBe(true);
  });

  it("a route that starts answering 404 turns its kind off and deletes it", async () => {
    make();
    await source.resync();
    expect(last("attention", "queue:q-100")?.op).toBe("upsert");
    daemon.missing.add("/api/attention");
    await source.resync();
    expect(last("attention", "queue:q-100")?.op).toBe("delete");
    expect(source.features().attention).toBe(false);
  });

  it("seatsSynced is set only after every rig's seats were read; a later failure keeps it", async () => {
    daemon.broken.add("/api/rigs/rig-acme-2/nodes");
    make();
    expect(source.status().seatsSynced).toBe(false);
    await expect(source.resync()).rejects.toThrow();
    expect(source.status().seatsSynced).toBe(false);
    daemon.broken.delete("/api/rigs/rig-acme-2/nodes");
    await source.resync();
    expect(source.status().seatsSynced).toBe(true);
    daemon.broken.add("/api/rigs/rig-acme-2/nodes");
    await expect(source.resync()).rejects.toThrow();
    expect(source.status().seatsSynced).toBe(true);
  });

  it("seatsSynced stays false while attention/queue are still awaited and is set with the publish", async () => {
    let release!: () => void;
    daemon.holdAttention = new Promise<void>((r) => (release = r));
    make();
    const done = source.resync();
    await waitFor(() => daemon.requests.some((r) => r.path === "/api/attention"));
    expect(source.status().seatsSynced).toBe(false);
    expect(source.current("seat")).toHaveLength(0);
    release();
    await done;
    expect(source.status().seatsSynced).toBe(true);
    expect(source.current("seat").length).toBeGreaterThan(0);
  });

  it("a 500 is an outage, not a missing feature", async () => {
    daemon.broken.add("/api/attention");
    make();
    await expect(source.resync()).rejects.toThrow();
    expect(source.features().attention).toBe(true);
  });
});

describe("daemon client safety", () => {
  it("only talks to a literal loopback IP and never sends a token elsewhere", () => {
    for (const bad of ["http://example.com:7433", "http://localhost:7433", "http://192.168.1.5:7433", "https://127.0.0.1:7433", "http://127.0.0.1.evil.test"]) {
      expect(() => new DaemonClient({ baseUrl: bad, token: "x" }), bad).toThrow();
    }
    expect(() => new DaemonClient({ baseUrl: "http://127.0.0.1:7433" })).not.toThrow();
    expect(() => new DaemonClient({ baseUrl: "http://[::1]:7433" })).not.toThrow();
  });

  it("sends the bearer as a header, GET only, without an Origin", async () => {
    source = new OpenRigSource({ daemon: new DaemonClient({ baseUrl: daemon.url, token: "secret-test-token" }), onChange: () => {}, ...fast });
    await source.resync();
    expect(daemon.requests.length).toBeGreaterThan(0);
    for (const r of daemon.requests) {
      expect(r.method).toBe("GET");
      expect(r.authorization).toBe("Bearer secret-test-token");
      expect(r.origin).toBeUndefined();
      expect(r.query).not.toContain("secret");
    }
  });
});

describe("integrity fixes", () => {
  it("retries a failed refresh with bounded backoff and no new event or periodic resync", async () => {
    let schedulingRetry = false;
    make({ log: (message) => { if (message.startsWith("refresh failed")) schedulingRetry = true; } }).start();
    await waitFor(() => daemon.streamCount === 1 && source.status().seatsSynced);
    const retryDelays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) => {
      // The failed-refresh log immediately precedes scheduling, with no intervening await.
      if (schedulingRetry) { retryDelays.push(ms!); schedulingRetry = false; }
      return realSetTimeout(callback, ms, ...args);
    });
    try {
      daemon.broken.add("/api/attention");
      daemon.attention = { ...daemon.attention, items: (daemon.attention.items as unknown[]).slice(1) };
      daemon.emit({ type: "queue.updated", qitemId: "q-100" });
      await waitFor(() => retryDelays.length >= 5, 4000, "capped retries");
      // Assert the backoff itself, independent of how many attempts wall time allowed.
      expect(retryDelays).toEqual(retryDelays.map((_, i) => Math.min(fast.retryMaxMs, fast.retryMinMs * 2 ** i)));
      daemon.broken.delete("/api/attention");
      await waitFor(() => last("attention", "queue:q-100")?.op === "delete", 4000, "retry succeeded");
      const settled = daemon.requests.filter((r) => r.path === "/api/attention").length;
      const scheduled = [...retryDelays];
      await new Promise((r) => setTimeout(r, 400));
      expect(daemon.requests.filter((r) => r.path === "/api/attention")).toHaveLength(settled);
      expect(retryDelays).toEqual(scheduled); // retries stop after success
    } finally {
      timers.mockRestore();
    }
  });

  it("detects a restarted daemon with no new events: a new identity forgets the sequence and everything is read again", async () => {
    make().start();
    await waitFor(() => daemon.streamCount === 1 && last("seat", "node-b1"));
    for (let i = 0; i < 3; i++) daemon.emit({ type: "chat.message" });
    await waitFor(() => source.status().lastSeq === 3);
    daemon.ps = daemon.ps.filter((r) => r.rigId !== "rig-acme-2");
    daemon.nodes.delete("rig-acme-2");
    await daemon.restart({ resetLog: true }); // nothing is emitted afterwards
    await waitFor(() => last("rig", "rig-acme-2")?.op === "delete" && last("seat", "node-b1")?.op === "delete", 4000, "state re-read");
    const reopened = daemon.requests.filter((r) => r.path === "/api/events").at(-1)!;
    expect(reopened.lastEventId).toBeUndefined();
    expect(source.status().lastSeq).toBeNull();
  });

  it("detects a restart with an equal sequence (same log length, same identity) because every connect resyncs", async () => {
    make().start();
    await waitFor(() => daemon.streamCount === 1 && last("seat", "node-b1"));
    daemon.emit({ type: "chat.message" });
    await waitFor(() => source.status().lastSeq === 1);
    daemon.ps = daemon.ps.filter((r) => r.rigId !== "rig-acme-2");
    daemon.nodes.delete("rig-acme-2");
    daemon.dropStreams();
    await waitFor(() => last("rig", "rig-acme-2")?.op === "delete", 4000, "resync on reconnect");
  });

  it("a full page of work is treated as partial: nothing is deleted from it, the host says so", async () => {
    daemon.queue = Array.from({ length: 500 }, (_, i) => ({ qitemId: `qp-${i}`, tsCreated: "2026-11-07T10:00:00.000Z", tsUpdated: "2026-11-07T10:00:00.000Z", sourceSession: "a@b", destinationSession: "c@d", state: "pending", priority: "routine", body: "x", summary: `item ${i}` }));
    make();
    await source.resync();
    expect(source.current("work")).toHaveLength(500);
    expect(last("host", "host-1")?.data).toMatchObject({ state: "degraded", incomplete: ["work"] });
    daemon.queue = daemon.queue.slice(1).concat([{ ...daemon.queue[0]!, qitemId: "qp-new" }]); // still a full page; qp-0 is absent
    await source.resync();
    expect(changes.some((c) => c.kind === "work" && c.op === "delete")).toBe(false);
    expect(source.current("work")).toHaveLength(501);
    daemon.queue = daemon.queue.slice(0, 3); // a short page is complete again: absent items are deleted
    await source.resync();
    expect(source.current("work")).toHaveLength(3);
    expect(last("host", "host-1")?.data).toMatchObject({ state: "online" });
  });

  it("a partial attention source suspends deletes the same way", async () => {
    make();
    await source.resync();
    daemon.attention = { ...daemon.attention, items: [], sources: [{ source: "queue", state: "partial", detail: "1001 rows" }] };
    await source.resync();
    expect(changes.some((c) => c.kind === "attention" && c.op === "delete")).toBe(false);
    daemon.attention = { ...daemon.attention, items: [], sources: [{ source: "queue", state: "available", detail: "" }] };
    await source.resync();
    expect(last("attention", "queue:q-100")?.op).toBe("delete");
  });

  it("a 404 for one rig's nodes removes only that rig's seats and keeps the feature on", async () => {
    make();
    await source.resync();
    daemon.nodes.delete("rig-acme-2"); // ps still lists it
    await source.resync();
    expect(last("seat", "node-b1")?.op).toBe("delete");
    expect(last("seat", "node-a1")?.op).toBe("upsert");
    expect(source.features().seat).toBe(true);
    daemon.nodes.set("rig-acme-2", JSON.parse(JSON.stringify([{ nodeId: "node-b1", rigId: "rig-acme-2", rigName: "acme-build", logicalId: "dev.builder", nodeKind: "agent", runtime: "claude-code", lifecycleState: "running" }])));
    await source.resync();
    expect(last("seat", "node-b1")?.op).toBe("upsert");
  });

  it("probe: seats are off only when every known rig answers 404 on the nodes route", async () => {
    make();
    await source.resync();
    daemon.nodes.delete("rig-acme-2");
    expect((await source.probe()).seat).toBe(true);
    daemon.missing.add("/api/rigs/");
    expect((await source.probe()).seat).toBe(false);
  });

  it("never derives a title from a request body", async () => {
    const SENTINEL = "SENTINEL-BODY-DO-NOT-LEAK";
    daemon.queue = [
      { qitemId: "q-x1", tsCreated: "2026-11-07T10:00:00.000Z", tsUpdated: "2026-11-07T10:00:00.000Z", sourceSession: "a@b", destinationSession: "c@d", state: "pending", priority: "routine", body: `${SENTINEL} first line\nsecond` },
      { qitemId: "q-x2", tsCreated: "2026-11-07T10:00:00.000Z", tsUpdated: "2026-11-07T10:00:00.000Z", sourceSession: "a@b", destinationSession: "c@d", state: "pending", priority: "routine", body: SENTINEL, summary: "Safe summary" },
    ];
    daemon.attention = { ...daemon.attention, items: [{ id: "queue:q-x1", kind: "action", urgency: "urgent", at: "2026-11-07T11:00:00.000Z", scope: "instance", project: null, source: "x", body: SENTINEL }] };
    make();
    await source.resync();
    expect(JSON.stringify(changes)).not.toContain(SENTINEL);
    expect(last("work", "q-x1")?.data?.title).toBe("Queue item q-x1");
    expect(last("work", "q-x2")?.data?.title).toBe("Queue item q-x2"); // summary is daemon text: off by default
    expect(last("attention", "queue:q-x1")?.data?.title).toBe("Request for a person: queue:q-x1");
  });

  it("with includeText the work title, attention title and impact are the daemon's summary and unblocks", async () => {
    daemon.queue = [{ qitemId: "q-x2", tsCreated: "2026-11-07T10:00:00.000Z", tsUpdated: "2026-11-07T10:00:00.000Z", sourceSession: "a@b", destinationSession: "c@d", state: "pending", priority: "routine", body: "BODY", summary: "Safe summary" }];
    make({ includeText: true });
    await source.resync();
    expect(last("work", "q-x2")?.data?.title).toBe("Safe summary");
    expect(last("attention", "queue:q-100")?.data).toMatchObject({ title: "Approve the release notes", impact: "The weekly release" });
    expect(JSON.stringify(changes)).not.toContain("BODY");
  });
});

describe("redirects", () => {
  it("never follows a redirect from the daemon, so a token cannot leave", async () => {
    const hits: Array<string | undefined> = [];
    const target = createServer((req, res) => {
      hits.push(req.headers.authorization);
      res.writeHead(200, { "content-type": "application/json" }).end("[]");
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const tport = (target.address() as { port: number }).port;
    const bouncer = createServer((_req, res) => res.writeHead(302, { location: `http://127.0.0.1:${tport}/api/ps` }).end());
    await new Promise<void>((r) => bouncer.listen(0, "127.0.0.1", r));
    const bport = (bouncer.address() as { port: number }).port;
    try {
      const client = new DaemonClient({ baseUrl: `http://127.0.0.1:${bport}`, token: "tok-redirect" });
      await expect(client.getJson("/api/ps")).rejects.toThrow();
      await expect(client.status("/api/ps")).rejects.toThrow();
      await expect(client.events({}).next()).rejects.toThrow();
      expect(hits).toEqual([]);
    } finally {
      target.close();
      bouncer.close();
    }
  });
});

describe("ordering and probing", () => {
  it("reads the snapshot only after the event stream is open, so a change between connect and open is not lost", async () => {
    daemon.openDelayMs = 150;
    make().start();
    await new Promise((r) => setTimeout(r, 50)); // connected, not yet open
    daemon.ps = daemon.ps.filter((r) => r.rigId !== "rig-acme-2");
    daemon.nodes.delete("rig-acme-2");
    daemon.emit({ type: "rig.deleted", rigId: "rig-acme-2" });
    await waitFor(() => last("host", "host-1")?.data?.state === "online", 4000, "first snapshot");
    const openedAt = daemon.opens[0]!;
    const firstSnapshotRead = daemon.requests.find((r) => r.path === "/api/ps" && r.at >= openedAt - 5);
    expect(firstSnapshotRead).toBeTruthy();
    expect(daemon.requests.filter((r) => r.path === "/api/ps" && r.at < openedAt)).toEqual([]);
    expect(source.current("rig").map((r) => r.id)).toEqual(["rig-acme-1"]);
    expect(source.current("seat").every((s) => s.rigId === "rig-acme-1")).toBe(true);
  });

  it("probes with the rig ids of the current /api/ps, so replacement rigs keep seats on", async () => {
    make();
    await source.resync(); // caches rig-acme-1 and rig-acme-2
    const node = (rigId: string) => [{ nodeId: `n-${rigId}`, rigId, rigName: rigId, logicalId: "dev.x", nodeKind: "agent", runtime: "codex", lifecycleState: "running" }];
    daemon.ps = [{ ...daemon.ps[0]!, rigId: "rig-acme-9", name: "acme-new" }];
    daemon.nodes = new Map([["rig-acme-9", node("rig-acme-9")]]); // the cached rigs now 404
    expect((await source.probe()).seat).toBe(true);
    await source.resync();
    expect(source.current("seat").map((s) => s.id)).toEqual(["n-rig-acme-9"]);
  });
});

describe("x-openrig extension", () => {
  const ext = (id: string) => (last("seat", id)?.data as { "x-openrig"?: Record<string, unknown> } | undefined)?.["x-openrig"];

  it("carries structured daemon node detail on every seat, valid against the schema", async () => {
    const node = daemon.nodes.get("rig-acme-1")![0]!;
    Object.assign(node, {
      podNamespace: "lead", startupStatus: "ready", pendingWorkCount: 2, inProgressWorkCount: 1, intentionallyStopped: false,
      heldReason: "excluded_from_subset", latestError: "Harness launch requires attention: /home/x/secret",
      activityState: { activity: "working", display: "working", needsInput: { count: 0, reason: null }, decidedBy: null, seq: 1, lastSwap: null },
    });
    make();
    await source.resync();
    expect(ext("node-a1")).toMatchObject({
      version: "1.0", sessionName: "lead-planner@acme-ops", rigName: "acme-ops", podNamespace: "lead", sessionStatus: "running", lifecycleState: "running",
      startupStatus: "ready", held: true, heldReasonCode: "excluded_from_subset", errorCategory: "launch_unconfirmed", activity: "working", display: "working",
      needsInputCount: 0, pendingWorkCount: 2, inProgressWorkCount: 1, intentionallyStopped: false, needsAttention: false,
    });
    for (const c of changes) if (c.kind === "seat" && c.op === "upsert") expect(validator("seat")(c.data), JSON.stringify(validator("seat").errors)).toBe(true);
    expect(ext("node-a3")).toMatchObject({ version: "1.0", sessionStatus: "detached" });
    expect(ext("node-a3")).not.toHaveProperty("held");
    expect(ext("node-a3")).not.toHaveProperty("errorCategory");
  });

  it("by default carries no daemon free text: categories and allowlisted codes only", async () => {
    const [a1, a2, a3] = daemon.nodes.get("rig-acme-1")!;
    a1!.latestError = { message: "token=abc123 exploded" };
    a1!.heldReason = "operator said: password=hunter2";
    a2!.activityState = { activity: "needs-input", display: "needs input", needsInput: { count: 1, reason: "permission_prompt", summary: "Allow edit of the zebra file?", prompt: "RAW PROMPT" } };
    a3!.startupStatus = "failed";
    make();
    await source.resync();
    expect(ext("node-a1")).toMatchObject({ errorCategory: "unknown", held: true, heldReasonCode: "other" });
    expect(ext("node-a2")).toMatchObject({ needsInputCount: 1, promptKind: "permission_prompt", arbitratedNeedsInput: true });
    expect(ext("node-a3")).toMatchObject({ errorCategory: "startup_failed" });
    const text = JSON.stringify(changes);
    for (const s of ["abc123", "hunter2", "zebra", "RAW PROMPT"]) expect(text).not.toContain(s);
    for (const f of ["lastError", "heldReason", "promptSummary"]) for (const id of ["node-a1", "node-a2"]) expect(ext(id)).not.toHaveProperty(f);
  });

  it("with includeText the daemon text is carried: bounded, one line, never the raw prompt", async () => {
    const [a1, a2] = daemon.nodes.get("rig-acme-1")!;
    a1!.latestError = { message: "token=abc123 exploded" };
    a1!.heldReason = "x".repeat(1000);
    a2!.activityState = { activity: "needs-input", display: "needs input", needsInput: { count: 1, reason: "selection prompt", summary: "Allow\nedit?", prompt: "RAW PROMPT" } };
    make({ includeText: true });
    await source.resync();
    expect(ext("node-a1")?.lastError).toBe("token=abc123 exploded");
    expect((ext("node-a1")?.heldReason as string).length).toBe(300);
    expect(ext("node-a2")).toMatchObject({ promptSummary: "Allow edit?", promptKind: "selection_prompt" });
    expect(JSON.stringify(changes)).not.toContain("RAW PROMPT");
    for (const c of changes) if (c.kind === "seat" && c.op === "upsert") expect(validator("seat")(c.data), JSON.stringify(validator("seat").errors)).toBe(true);
  });

  it("with includeText the prompt summary falls back to the reason, and nothing else", async () => {
    const [, a2] = daemon.nodes.get("rig-acme-1")!;
    a2!.activityState = { activity: "needs-input", display: "needs input", needsInput: { count: 1, reason: "selection prompt", prompt: "RAW PROMPT" } };
    make({ includeText: true });
    await source.resync();
    expect(ext("node-a2")?.promptSummary).toBe("selection prompt");
  });

  const emitAll = async () => {
    const s1 = daemon.emit({ type: "queue.handed_off", qitemId: "q-100", fromSession: "lead-planner@acme-ops", toSession: "dev-writer@acme-ops", closureReason: "handed_off_to", summary: "Review\nnotes", body: "SECRET BODY" });
    const s2 = daemon.emit({ type: "queue.updated", qitemId: "q-100", fromState: "in-progress", toState: "done", closureReason: "no-follow-on", closureTarget: null, actorSession: "dev-writer@acme-ops", summary: "a human reply" });
    daemon.emit({ type: "queue.updated", qitemId: "q-101", fromState: "in-progress", toState: "done", closureReason: "answered", closureTarget: null, actorSession: "dev-writer@acme-ops", summary: "done" });
    daemon.emit({ type: "queue.updated", qitemId: "q-101", fromState: "pending", toState: "blocked", closureReason: null, closureTarget: null, actorSession: "x@y", summary: "ignored" });
    daemon.emit({ type: "queue.claimed", qitemId: "q-200", destinationSession: "dev-builder@acme-build", claimedAt: "x", closureRequiredAt: null, summary: "claim it" });
    daemon.emit({ type: "queue.created", qitemId: "q-300", sourceSession: "ghost@nowhere", destinationSession: "lead-planner@acme-ops", priority: "routine", tier: null, summary: "hello" });
    daemon.emit({ type: "agent.activity", rigId: "rig-acme-1", nodeId: "node-a2", sessionName: "dev-writer@acme-ops", runtime: "codex", activity: { state: "needs_input", reason: "permission prompt: rm -rf /home/x" } });
    await waitFor(() => changes.filter((c) => c.kind === "x-openrig.event").length >= 6, 4000, "six events");
    return { s1, s2 };
  };

  it("serves handoff, close, claim, message and prompt as x-openrig.event with seat ids and fixed summaries; a close is never an answer", async () => {
    make().start();
    await waitFor(() => daemon.streamCount === 1 && last("seat", "node-a1"));
    const { s1, s2 } = await emitAll();
    const evs = changes.filter((c) => c.kind === "x-openrig.event");
    for (const c of evs) expect(validator("x-openrig-event")(c.data), JSON.stringify(validator("x-openrig-event").errors)).toBe(true);
    const byId = (id: string) => last("x-openrig.event", id)?.data;
    expect(byId(`ev-${s1}`)).toMatchObject({ eventType: "handoff", daemonEvent: "queue.handed_off", seq: s1, summary: "handoff q-100", fromSession: "lead-planner@acme-ops", toSession: "dev-writer@acme-ops", fromSeatId: "node-a1", toSeatId: "node-a2", workId: "q-100" });
    expect(byId(`ev-${s2}`)).toMatchObject({ eventType: "close", summary: "close q-100", fromSeatId: "node-a2" });
    const kinds = evs.map((c) => (c.data as { eventType: string }).eventType).sort();
    expect(kinds).toEqual(["claim", "close", "close", "handoff", "message", "prompt"]);
    const msg = evs.find((c) => (c.data as { eventType: string }).eventType === "message")!.data as Record<string, unknown>;
    expect(msg).toMatchObject({ fromSession: "ghost@nowhere", toSeatId: "node-a1" });
    expect(msg).not.toHaveProperty("fromSeatId");
    const text = JSON.stringify(changes);
    for (const s of ["SECRET BODY", "Review", "a human reply", "claim it", "hello", "rm -rf"]) expect(text).not.toContain(s);
  });

  it("with includeText the event summary is the daemon's short single line", async () => {
    make({ includeText: true }).start();
    await waitFor(() => daemon.streamCount === 1 && last("seat", "node-a1"));
    const { s1 } = await emitAll();
    expect(last("x-openrig.event", `ev-${s1}`)?.data).toMatchObject({ summary: "Review notes" });
    const prompt = changes.find((c) => (c.data as { eventType?: string } | undefined)?.eventType === "prompt")!;
    expect((prompt.data as { summary: string }).summary).toBe("permission prompt: rm -rf /home/x");
    expect(JSON.stringify(changes)).not.toContain("SECRET BODY");
  });

  it("a prompt episode ends when the seat leaves needs_input, so a later identical prompt is emitted", async () => {
    make().start();
    await waitFor(() => daemon.streamCount === 1 && last("seat", "node-a1"));
    const act = (state: string) => ({ type: "agent.activity", rigId: "rig-acme-1", nodeId: "node-a2", sessionName: "dev-writer@acme-ops", runtime: "codex", activity: { state, reason: "permission_prompt" } });
    daemon.emit(act("needs_input"));
    daemon.emit(act("needs_input")); // re-reported inside the same episode
    await waitFor(() => source.status().lastSeq === 2, 4000, "two prompts");
    expect(source.current("x-openrig.event").length).toBe(1);
    daemon.emit(act("running"));
    daemon.emit(act("needs_input"));
    await waitFor(() => source.status().lastSeq === 4, 4000, "four events");
    expect(source.current("x-openrig.event").length).toBe(2);
  });

  it("keeps at most 200 events and clears them when the daemon log restarts", async () => {
    make().start();
    await waitFor(() => daemon.streamCount === 1 && last("seat", "node-a1"));
    for (let i = 0; i < 205; i++) daemon.emit({ type: "queue.claimed", qitemId: `q-${i}`, destinationSession: "dev-writer@acme-ops", claimedAt: "x", closureRequiredAt: null, summary: "c" });
    await waitFor(() => source.status().lastSeq === 205, 6000, "all events");
    expect(source.current("x-openrig.event").length).toBe(200);
    await daemon.restart({ resetLog: true });
    await waitFor(() => source.current("x-openrig.event").length === 0, 6000, "events cleared");
  });
});
