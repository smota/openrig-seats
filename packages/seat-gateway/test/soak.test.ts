// Soak: random daemon churn, daemon stream drops, a restart that resets the event log, a sequence gap and
// clients that keep dropping their connection, for SEAT_GATEWAY_SOAK_MS (default 3000, short for CI).
// SEAT_GATEWAY_SOAK_SEED fixes the random sequence. At the end the event-driven state must equal a fresh
// snapshot, every client must hold exactly the gateway's state, and cursors must never repeat or go back.
import { Mirror, createSeatClient } from "@openrig-seats/seat-protocol";
import { describe, expect, it } from "vitest";
import { MockDaemon, seqOf, startGateway, TOKEN, waitFor } from "./helpers.js";

const SOAK_MS = Number(process.env.SEAT_GATEWAY_SOAK_MS ?? 3000);
const SEED = Number(process.env.SEAT_GATEWAY_SOAK_SEED ?? 20261107);

function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sortById = (xs: Array<Record<string, unknown>>) => [...xs].sort((a, b) => String(a.id).localeCompare(String(b.id)));
const KINDS = ["host", "rig", "seat", "attention", "work"];

describe("soak", () => {
  it(`stays correct under churn for ${SOAK_MS} ms`, { timeout: SOAK_MS + 40_000 }, async () => {
    const rnd = prng(SEED);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const daemon = await new MockDaemon().start();
    const gw = await startGateway(daemon, {}, { tombstoneLimit: 200 });
    await waitFor(() => gw.gateway.store.items("work").length === 2);

    const clients = Array.from({ length: 4 }, () => {
      const mirror = new Mirror();
      const cursors: string[] = [];
      const ctl = new AbortController();
      const flaky: typeof fetch = (input, init) => {
        if (!String(input).endsWith("/stream") && !String(input).includes("/stream?")) return fetch(input, init);
        const conn = new AbortController();
        init?.signal?.addEventListener("abort", () => conn.abort(), { once: true });
        const t = setTimeout(() => conn.abort(), 30 + rnd() * 250);
        conn.signal.addEventListener("abort", () => clearTimeout(t), { once: true });
        return fetch(input, { ...init, signal: conn.signal });
      };
      const client = createSeatClient({ baseUrl: gw.url, token: TOKEN, fetch: flaky, minDelayMs: 2, maxDelayMs: 20 });
      const done = (async () => {
        for await (const env of client.stream({ signal: ctl.signal, onCursor: (c) => cursors.push(c) })) mirror.apply(env);
      })();
      return { mirror, cursors, stop: async () => (ctl.abort(), done) };
    });

    let n = 0;
    const rigNodes = () => [...daemon.nodes.entries()];
    const tick = () => {
      n++;
      const op = rnd();
      if (op < 0.35) {
        const [rigId, nodes] = pick(rigNodes());
        const agents = nodes.filter((x) => x.nodeKind === "agent");
        if (!agents.length) return;
        const node = pick(agents);
        const state = pick(["running", "idle", "needs_input"]);
        node.agentActivity = { state, reason: `soak ${n}`, evidenceSource: "runtime_hook", sampledAt: "x", evidence: null };
        node.arbitratedNeedsInput = state === "needs_input";
        daemon.emit({ type: "agent.activity", rigId, nodeId: node.nodeId, sessionName: node.canonicalSessionName, runtime: node.runtime, activity: node.agentActivity });
      } else if (op < 0.5) {
        const [rigId, nodes] = pick(rigNodes());
        const id = `node-s${n}`;
        nodes.push({ nodeId: id, rigId, rigName: rigId, logicalId: `soak.${n}`, canonicalSessionName: `soak-${n}@${rigId}`, nodeKind: "agent", runtime: "codex", lifecycleState: "running", agentActivity: { state: "idle", reason: "new", evidenceSource: "x", sampledAt: "x", evidence: null } });
        const ps = daemon.ps.find((p) => p.rigId === rigId);
        if (ps) ps.nodeCount = nodes.length;
        daemon.emit({ type: "node.added", rigId, nodeId: id, logicalId: `soak.${n}` });
      } else if (op < 0.62) {
        const [rigId, nodes] = pick(rigNodes());
        const removable = nodes.filter((x) => String(x.nodeId).startsWith("node-s"));
        if (!removable.length) return;
        const node = pick(removable);
        nodes.splice(nodes.indexOf(node), 1);
        const ps = daemon.ps.find((p) => p.rigId === rigId);
        if (ps) ps.nodeCount = nodes.length;
        daemon.emit({ type: "node.removed", rigId, nodeId: node.nodeId });
      } else if (op < 0.85) {
        const open = daemon.queue.filter((q) => String(q.qitemId).startsWith("q-s"));
        if (open.length < 30 && rnd() < 0.6) {
          const id = `q-s${n}`;
          daemon.queue.push({ qitemId: id, tsCreated: "2026-11-07T10:00:00.000Z", tsUpdated: new Date(1_800_000_000_000 + n * 1000).toISOString(), sourceSession: "lead-planner@acme-ops", destinationSession: "dev-builder@acme-build", state: "pending", priority: "routine", body: `soak ${n}` });
          daemon.emit({ type: "queue.created", qitemId: id });
        } else if (open.length) {
          const q = pick(open);
          if (rnd() < 0.5) q.state = pick(["in-progress", "blocked", "done"]);
          else daemon.queue.splice(daemon.queue.indexOf(q), 1);
          daemon.emit({ type: "queue.updated", qitemId: q.qitemId });
        }
      } else if (op < 0.95) {
        const items = daemon.attention.items as Array<Record<string, unknown>>;
        if (items.length > 1 && rnd() < 0.5) items.pop();
        else items.push({ id: `queue:q-a${n}`, kind: "action", summary: `Soak ask ${n}`, unblocks: null, urgency: pick(["routine", "urgent", "critical"]), at: "2026-11-07T11:00:00.000Z", scope: "instance", project: null, source: "x" });
        daemon.emit({ type: "queue.created", qitemId: `q-a${n}` });
      } else {
        daemon.emit({ type: "chat.message", rigId: "rig-acme-1" });
      }
    };

    const end = Date.now() + SOAK_MS;
    let nextDrop = Date.now() + 200;
    let restarted = false;
    let gapped = false;
    while (Date.now() < end) {
      tick();
      const now = Date.now();
      if (now > nextDrop) {
        nextDrop = now + 150 + rnd() * 400;
        daemon.dropStreams();
      }
      const progress = (now - (end - SOAK_MS)) / SOAK_MS;
      if (!gapped && progress > 0.3) {
        gapped = true;
        daemon.skipSeq(7);
      }
      if (!restarted && progress > 0.6) {
        restarted = true;
        await daemon.restart({ resetLog: true });
      }
      await new Promise((r) => setTimeout(r, 2 + rnd() * 6));
    }

    // Quiesce: the daemon is quiet; wait for the gateway to stop changing.
    let head = -1;
    await waitFor(
      async () => {
        const h = gw.gateway.store.head();
        const stable = h === head && daemon.streamCount >= 1;
        head = h;
        await new Promise((r) => setTimeout(r, 250));
        return stable;
      },
      15_000,
      "gateway to settle",
    );

    // The event-driven state must equal a fresh snapshot of the daemon.
    const eventState = Object.fromEntries(KINDS.map((k) => [k, sortById(gw.gateway.store.items(k))]));
    await gw.gateway.source.resync();
    const snapshotState = Object.fromEntries(KINDS.map((k) => [k, sortById(gw.gateway.store.items(k))]));
    expect(snapshotState).toEqual(eventState);
    expect(gw.gateway.store.items("seat").length).toBeGreaterThan(0);

    // Every client holds exactly the gateway's state, and cursors never repeat or go back.
    for (const [i, c] of clients.entries()) {
      await waitFor(() => KINDS.every((k) => JSON.stringify(sortById(c.mirror.list(k))) === JSON.stringify(snapshotState[k])), 10_000, `client ${i} to converge`);
      const seqs = c.cursors.map(seqOf);
      expect(seqs, `client ${i} cursors`).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size, `client ${i} duplicates`).toBe(seqs.length);
    }

    const stats = gw.gateway.stats();
    expect(stats.entries).toBeLessThan(2000); // live items plus the tombstone limit, never the history
    expect(stats.source.resyncs).toBeGreaterThanOrEqual(2); // the gap and the restart both forced one
    expect(gw.logs.join("\n")).not.toContain(TOKEN);

    for (const c of clients) await c.stop();
    await gw.stop();
    await daemon.stop();
  });
});
