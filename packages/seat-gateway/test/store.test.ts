import { describe, expect, it } from "vitest";
import { envelope, Store } from "../src/index.js";

const up = (id: string, v = 1, kind: "seat" | "work" = "seat") => ({ kind, id, op: "upsert" as const, data: { id, v } });
const del = (id: string, kind: "seat" | "work" = "seat") => ({ kind, id, op: "delete" as const });

describe("Store", () => {
  it("stamps strictly increasing sequence numbers and keeps the latest operation per item", () => {
    const s = new Store(10, "aa");
    s.apply(up("a"));
    s.apply(up("b"));
    s.apply(up("a", 2));
    expect(s.since(0).map((e) => [e.id, e.seq])).toEqual([["b", 2], ["a", 3]]);
    expect(s.items("seat")).toEqual([{ id: "b", v: 1 }, { id: "a", v: 2 }]);
    expect(s.cursor(3)).toBe("aa.3");
  });

  it("drops a no-op upsert and a delete of nothing", () => {
    const s = new Store(10, "aa");
    expect(s.apply(up("a"))).not.toBeNull();
    expect(s.apply(up("a"))).toBeNull();
    expect(s.apply(del("zzz"))).toBeNull();
    expect(s.apply(del("a"))).not.toBeNull();
    expect(s.apply(del("a"))).toBeNull();
    expect(s.head()).toBe(2);
  });

  it("resumes without gaps or duplicates", () => {
    const s = new Store(10, "aa");
    s.apply(up("a"));
    s.apply(up("b"));
    const r = s.resolve("aa.1");
    expect(r).toEqual({ from: 1, reset: false });
    s.apply(del("a"));
    s.apply(up("c"));
    const got = s.since(r.from).map((e) => `${e.op}:${e.id}`);
    expect(got).toEqual(["upsert:b", "delete:a", "upsert:c"]);
    expect(new Set(s.since(0).map((e) => e.seq)).size).toBe(s.since(0).length);
  });

  it("resets a cursor from another epoch, from the future, or older than pruned tombstones", () => {
    const s = new Store(2, "aa");
    expect(s.resolve(undefined)).toEqual({ from: 0, reset: false });
    expect(s.resolve("bb.1")).toMatchObject({ reset: true, reason: "cursor-unknown" });
    expect(s.resolve("garbage")).toMatchObject({ reset: true, reason: "cursor-unknown" });
    expect(s.resolve("aa.9")).toMatchObject({ reset: true, reason: "cursor-ahead" });
    for (const id of ["a", "b", "c", "d"]) s.apply(up(id));
    for (const id of ["a", "b", "c", "d"]) s.apply(del(id)); // 4 tombstones, limit 2: a and b are pruned
    expect(s.size()).toBe(2);
    expect(s.resolve("aa.4")).toMatchObject({ reset: true, reason: "cursor-pruned" });
    expect(s.resolve(`aa.${s.head()}`)).toEqual({ from: s.head(), reset: false });
  });

  it("bounds memory by live items plus the tombstone limit", () => {
    const s = new Store(50, "aa");
    for (let i = 0; i < 5000; i++) {
      s.apply(up(`x${i}`));
      s.apply(del(`x${i}`));
    }
    s.apply(up("live"));
    expect(s.size()).toBeLessThanOrEqual(51);
  });

  it("wakes a waiter on change, on abort and on timeout", async () => {
    const s = new Store(10, "aa");
    const ctl = new AbortController();
    const p = s.waitAfter(0, ctl.signal, 5000);
    s.apply(up("a"));
    await p;
    await s.waitAfter(1, ctl.signal, 20); // timeout
    const q = s.waitAfter(1, ctl.signal, 5000);
    ctl.abort();
    await q;
  });

  it("builds protocol envelopes", () => {
    const s = new Store(10, "aa");
    const e = s.apply(up("a"))!;
    expect(envelope(s, e)).toEqual({ cursor: "aa.1", kind: "seat", id: "a", op: "upsert", data: { id: "a", v: 1 } });
    const d = s.apply(del("a"))!;
    expect(envelope(s, d)).toEqual({ cursor: "aa.2", kind: "seat", id: "a", op: "delete" });
  });
});
