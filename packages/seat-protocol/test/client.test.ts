import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Mirror, SeatClientError, createSeatClient, isCoreKind, isStreamControl, toGenericCard, type StreamEnvelope, type StreamItem } from "../src/index.js";
import { MockSeatServer } from "./mock-server.js";

const T = "2026-11-07T12:00:00Z";
const seat = (id: string, state = "idle") => ({ kind: "seat", id, op: "upsert" as const, data: { id, updatedAt: T, rigId: "r1", name: id, state } });

let server: MockSeatServer;
beforeEach(async () => { server = await new MockSeatServer().start(); });
afterEach(async () => { await server.stop(); });

const noSleep = async () => {};

async function take(it: AsyncGenerator<StreamItem>, n: number, ctl: AbortController): Promise<StreamEnvelope[]> {
  const out: StreamEnvelope[] = [];
  for await (const e of it) {
    if (isStreamControl(e)) continue;
    out.push(e);
    if (out.length === n) ctl.abort();
  }
  return out;
}

describe("capabilities", () => {
  it("reads GET /capabilities", async () => {
    const c = createSeatClient({ baseUrl: server.url });
    const caps = await c.capabilities();
    expect(caps.protocol.version).toBe("1.0");
    expect(caps.kinds).toContain("seat");
  });

  it("sends the bearer token as a header and surfaces 401", async () => {
    await server.stop();
    server = await new MockSeatServer().start("s3cret");
    await expect(createSeatClient({ baseUrl: server.url }).capabilities()).rejects.toMatchObject({ status: 401 });
    expect((await createSeatClient({ baseUrl: server.url, token: "s3cret" }).capabilities()).protocol.version).toBe("1.0");
  });
});

describe("stream", () => {
  it("replays the log, then delivers live envelopes in order", async () => {
    server.push(seat("a")); server.push(seat("b"));
    const ctl = new AbortController();
    const c = createSeatClient({ baseUrl: server.url });
    const got = take(c.stream({ signal: ctl.signal }), 3, ctl);
    await new Promise((r) => setTimeout(r, 50));
    server.push(seat("c"));
    expect((await got).map((e) => [e.cursor, e.id])).toEqual([["1", "a"], ["2", "b"], ["3", "c"]]);
  });

  it("starts after a given cursor", async () => {
    server.push(seat("a")); server.push(seat("b"));
    const ctl = new AbortController();
    const got = await take(createSeatClient({ baseUrl: server.url }).stream({ cursor: "1", signal: ctl.signal }), 1, ctl);
    expect(got.map((e) => e.id)).toEqual(["b"]);
    expect(server.streamRequests[0]).toMatchObject({ lastEventId: "1", cursorQuery: "1" });
  });

  it("resumes from the last cursor after a drop, with no gap and no duplicate", async () => {
    server.push(seat("a"));
    const ctl = new AbortController();
    const reconnects: number[] = [];
    const c = createSeatClient({ baseUrl: server.url, sleep: noSleep });
    const got = take(c.stream({ signal: ctl.signal, onReconnect: (i) => reconnects.push(i.attempt) }), 4, ctl);
    await new Promise((r) => setTimeout(r, 50));
    server.push(seat("b"));
    await new Promise((r) => setTimeout(r, 50));
    server.dropStreams();
    server.push(seat("c")); // lands while the client is disconnected
    server.push(seat("d"));
    const ids = (await got).map((e) => e.id);
    expect(ids).toEqual(["a", "b", "c", "d"]);
    expect(reconnects.length).toBeGreaterThanOrEqual(1);
    expect(server.streamRequests.at(-1)).toMatchObject({ lastEventId: "2" });
  });

  it("skips malformed messages and reports them", async () => {
    server.push(seat("a"));
    const ctl = new AbortController();
    const skipped: string[] = [];
    // Raw frames through the live connection: one bad JSON, one non-envelope, then a good one.
    const c = createSeatClient({ baseUrl: server.url });
    const got = take(c.stream({ signal: ctl.signal, onSkipped: (r) => skipped.push(r) }), 2, ctl);
    await new Promise((r) => setTimeout(r, 50));
    server.raw('data: {nope\n\ndata: {"cursor":"x"}\n\n');
    server.push(seat("b"));
    expect((await got).map((e) => e.id)).toEqual(["a", "b"]);
    expect(skipped).toEqual(["invalid JSON", "not an envelope"]);
  });

  it("does not retry an authorization failure", async () => {
    await server.stop();
    server = await new MockSeatServer().start("tok");
    const c = createSeatClient({ baseUrl: server.url, token: "wrong", sleep: noSleep });
    await expect(c.stream().next()).rejects.toBeInstanceOf(SeatClientError);
    expect(server.streamRequests.length).toBe(0);
  });

  it("gives up after maxAttempts when the server is unreachable", async () => {
    const url = server.url;
    await server.stop();
    const c = createSeatClient({ baseUrl: url, sleep: noSleep, maxAttempts: 3 });
    await expect(c.stream().next()).rejects.toThrow(/gave up after 3/);
  });

  it("ends quietly when aborted", async () => {
    const ctl = new AbortController();
    const c = createSeatClient({ baseUrl: server.url });
    const it = c.stream({ signal: ctl.signal });
    const next = it.next();
    await new Promise((r) => setTimeout(r, 50));
    ctl.abort();
    expect((await next).done).toBe(true);
  });
});

async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
}

describe("stream: consumer that stops early", () => {
  it("never sees a processed envelope again: the cursor advances before the envelope is yielded", async () => {
    server.push(seat("a")); server.push(seat("b"));
    const c = createSeatClient({ baseUrl: server.url });
    let saved: string | undefined;
    for await (const e of c.stream({ onCursor: (cur) => (saved = cur) })) {
      expect(e.id).toBe("a");
      break;
    }
    expect(saved).toBe("1");
    const ctl = new AbortController();
    const next = await take(c.stream({ cursor: saved, signal: ctl.signal }), 1, ctl);
    expect(next.map((e) => e.id)).toEqual(["b"]);
  });

  it("closes the connection when the consumer breaks out", async () => {
    server.push(seat("a"));
    const c = createSeatClient({ baseUrl: server.url });
    for await (const _ of c.stream()) break;
    await until(() => server.openStreams === 0);
    expect(server.streamRequests.length).toBe(1); // and it did not reconnect
  });

  it("closes the connection when the consumer throws", async () => {
    server.push(seat("a"));
    const c = createSeatClient({ baseUrl: server.url });
    await expect((async () => { for await (const _ of c.stream()) throw new Error("boom"); })()).rejects.toThrow("boom");
    await until(() => server.openStreams === 0);
  });
});

describe("stream: server retry", () => {
  async function delayAfterDrop(retryLine: string, opts: { maxDelayMs?: number } = {}): Promise<number> {
    const delays: number[] = [];
    const ctl = new AbortController();
    const c = createSeatClient({ baseUrl: server.url, ...opts, sleep: async (ms) => { delays.push(ms); ctl.abort(); } });
    const run = (async () => { for await (const _ of c.stream({ signal: ctl.signal })) { /* none */ } })();
    await until(() => server.openStreams === 1);
    server.raw(retryLine);
    await new Promise((r) => setTimeout(r, 30));
    server.dropStreams();
    await run;
    return delays[0]!;
  }

  it("uses a retry-only block as the reconnect delay", async () => {
    expect(await delayAfterDrop("retry: 1500\n\n")).toBe(1500);
  });
  it("uses retry sent with an event", async () => {
    expect(await delayAfterDrop(`retry: 700\ndata: ${JSON.stringify({ cursor: "1", kind: "x-a.b", id: "i", op: "delete" })}\n\n`)).toBe(700);
  });
  it("caps a huge retry at maxDelayMs and floors a tiny one at 50 ms", async () => {
    expect(await delayAfterDrop("retry: 999999\n\n", { maxDelayMs: 4000 })).toBe(4000);
    expect(await delayAfterDrop("retry: 1\n\n")).toBe(50);
  });
  it("falls back to minDelayMs without a retry value", async () => {
    expect(await delayAfterDrop(": nothing\n\n")).toBe(250);
  });
});

describe("act", () => {
  const base = { kind: "attention", id: "a1", action: "allow" };

  it("posts with a generated idempotency key", async () => {
    const res = await createSeatClient({ baseUrl: server.url }).act(base);
    expect(res).toMatchObject({ status: "completed", replayed: false });
    expect(server.actCalls[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("replays the stored result for the same key", async () => {
    const c = createSeatClient({ baseUrl: server.url });
    await c.act({ ...base, idempotencyKey: "key-12345678" });
    const second = await c.act({ ...base, idempotencyKey: "key-12345678" });
    expect(second.replayed).toBe(true);
  });

  it("retries a 5xx with the same key", async () => {
    server.failActOnce = 1;
    const res = await createSeatClient({ baseUrl: server.url, sleep: noSleep }).act(base);
    expect(res.status).toBe("completed");
    expect(server.actCalls.length).toBe(2);
    expect(server.actCalls[0]!.key).toBe(server.actCalls[1]!.key);
  });

  it("returns a rejected outcome from a 4xx body instead of throwing", async () => {
    const res = await createSeatClient({ baseUrl: server.url }).act({ ...base, action: "nope" });
    expect(res).toMatchObject({ status: "rejected", error: { code: "unknown_action" } });
  });
});

describe("kinds and mirror", () => {
  it("recognises core kinds", () => {
    expect(isCoreKind("seat")).toBe(true);
    expect(isCoreKind("x-acme.approval")).toBe(false);
  });

  it("renders an unknown kind as a generic card, ignoring unknown fields", () => {
    const card = toGenericCard({
      kind: "x-acme.approval", id: "ap1", op: "upsert",
      data: { id: "ap1", updatedAt: T, title: "Grant spend", summary: "EUR 40", amount: 40, actions: [{ id: "grant", label: "Grant" }, { bad: true }] },
    });
    expect(card).toEqual({ kind: "x-acme.approval", id: "ap1", title: "Grant spend", summary: "EUR 40", actions: [{ id: "grant", label: "Grant" }] });
    expect(toGenericCard({ kind: "x-a.b", id: "z", op: "upsert", data: { id: "z", updatedAt: T } }).title).toBe("z");
  });

  it("mirrors upserts and deletes, keeping unknown kinds", () => {
    const m = new Mirror();
    m.apply({ kind: "seat", id: "a", op: "upsert", data: { id: "a", state: "idle" } });
    m.apply({ kind: "seat", id: "a", op: "upsert", data: { id: "a", state: "active" } });
    m.apply({ kind: "x-acme.thing", id: "t", op: "upsert", data: { id: "t" } });
    expect(m.get("seat", "a")).toMatchObject({ state: "active" });
    m.apply({ kind: "seat", id: "a", op: "delete" });
    expect(m.list("seat")).toEqual([]);
    expect(m.kinds()).toEqual(["x-acme.thing"]);
  });
});

describe("reset control message", () => {
  const ctrl = (reason: string) => `event: control\ndata: ${JSON.stringify({ type: "reset", reason })}\n\n`;

  it("surfaces reset through onReset and as a yielded item, and drops the cursor", async () => {
    server.push(seat("a"));
    const ctl = new AbortController();
    const resets: unknown[] = [];
    const items: StreamItem[] = [];
    const c = createSeatClient({ baseUrl: server.url, minDelayMs: 1 });
    const done = (async () => {
      for await (const it of c.stream({ signal: ctl.signal, onReset: (r) => resets.push(r) })) items.push(it);
    })();
    await new Promise((r) => setTimeout(r, 50));
    server.raw(ctrl("cursor-pruned"));
    
    await new Promise((r) => setTimeout(r, 50));
    ctl.abort();
    await done;
    expect(resets).toEqual([{ type: "reset", reason: "cursor-pruned" }]);
    expect(items.some((i) => isStreamControl(i) && i.type === "reset")).toBe(true);
  });

  it("reconnects without the old cursor after a reset", async () => {
    server.push(seat("a"));
    const ctl = new AbortController();
    const c = createSeatClient({ baseUrl: server.url, minDelayMs: 1 });
    const done = (async () => {
      for await (const _ of c.stream({ signal: ctl.signal })) void _;
    })();
    await new Promise((r) => setTimeout(r, 50));
    server.raw(ctrl("cursor-unknown"));
    await new Promise((r) => setTimeout(r, 30));
    server.dropStreams();
    await new Promise((r) => setTimeout(r, 80));
    ctl.abort();
    await done;
    expect(server.streamRequests.at(-1)?.lastEventId).toBeUndefined();
  });

  it("ignores control types it does not know and malformed control data", async () => {
    server.push(seat("a"));
    const ctl = new AbortController();
    const skipped: string[] = [];
    const items: StreamItem[] = [];
    const c = createSeatClient({ baseUrl: server.url });
    const done = (async () => {
      for await (const it of c.stream({ signal: ctl.signal, onSkipped: (r) => skipped.push(r) })) items.push(it);
    })();
    await new Promise((r) => setTimeout(r, 50));
    server.raw('event: control\ndata: {"type":"x-acme.notice"}\n\n');
    server.raw("event: control\ndata: nope\n\n");
    await new Promise((r) => setTimeout(r, 50));
    ctl.abort();
    await done;
    expect(items.filter(isStreamControl)).toEqual([]);
    expect(skipped).toEqual(["invalid JSON"]);
  });

  it("Mirror.clear and a reset item empty the mirror; other controls do not", () => {
    const m = new Mirror();
    m.apply({ kind: "seat", id: "a", op: "upsert", data: { id: "a" } });
    m.apply({ type: "x-acme.notice" });
    expect(m.list("seat")).toHaveLength(1);
    m.apply({ type: "reset", reason: "cursor-unknown" });
    expect(m.kinds()).toEqual([]);
    m.apply({ kind: "seat", id: "b", op: "upsert", data: { id: "b" } });
    m.clear();
    expect(m.list("seat")).toEqual([]);
  });
});
