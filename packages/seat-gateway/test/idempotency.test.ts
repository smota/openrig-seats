import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActResponse } from "@openrig-seats/seat-protocol";
import { IdempotencyTable, TableUnavailableError } from "../src/index.js";

let dir: string;
let file: string;
const done = (key: string): ActResponse => ({ idempotencyKey: key, status: "completed", replayed: false });
const open: IdempotencyTable[] = [];
const table = (max = 3, retention = 7 * 86_400_000, io?: ConstructorParameters<typeof IdempotencyTable>[3]) => {
  const t = new IdempotencyTable(file, max, retention, io);
  open.push(t);
  return t;
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seat-idem-"));
  file = join(dir, "t.json");
});
afterEach(() => {
  for (const t of open.splice(0)) t.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("retention instead of eviction", () => {
  it("a full table of unexpired keys refuses a new key and keeps every old one", () => {
    const t = table(3);
    for (const k of ["k-aaaaaaaa", "k-bbbbbbbb", "k-cccccccc"]) {
      t.begin(k, "f");
      t.complete(k, done(k));
    }
    expect(() => t.begin("k-dddddddd", "f")).toThrow(TableUnavailableError);
    expect(() => t.begin("k-dddddddd", "f")).toThrow(/unexpired/);
    for (const k of ["k-aaaaaaaa", "k-bbbbbbbb", "k-cccccccc"]) expect(t.get(k)?.response?.status).toBe("completed");
    expect(t.get("k-dddddddd")).toBeUndefined();
  });

  it("expired keys are dropped, which makes room", () => {
    writeFileSync(file, JSON.stringify({ version: 1, entries: { "old-key-01": { fingerprint: "f", at: "2020-01-01T00:00:00.000Z", response: done("old-key-01") } } }), { mode: 0o600 });
    const t = table(1);
    expect(t.get("old-key-01")).toBeUndefined();
    t.begin("new-key-01", "f");
    expect(t.size()).toBe(1);
  });
});

describe("one process owns the table", () => {
  it("a second instance refuses to start while the first holds the lock, and may after close", () => {
    const first = table();
    expect(() => new IdempotencyTable(file)).toThrow(/another gateway process holds the idempotency table lock/);
    first.close();
    const second = table();
    expect(second.size()).toBe(0);
  });

  it("takes over a lock whose owner is gone", () => {
    writeFileSync(`${file}.lock`, "999999999", { mode: 0o600 });
    expect(() => table()).not.toThrow();
  });

  it("a failed start does not leave the lock behind", () => {
    writeFileSync(file, "not json", { mode: 0o600 });
    expect(() => new IdempotencyTable(file)).toThrow(/not valid JSON/);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });
});

describe("durability before sending", () => {
  it("fsyncs the temp file and then the directory", () => {
    const calls: number[] = [];
    const t = table(3, undefined, { fsync: (fd) => void calls.push(fd) });
    t.begin("k-aaaaaaaa", "f");
    expect(calls).toHaveLength(2);
  });

  it("an fsync failure makes begin throw and leaves no entry, so nothing is sent", () => {
    for (const failOn of [1, 2]) {
      let n = 0;
      const t = table(3, undefined, { fsync: () => { if (++n === failOn) throw new Error("EIO"); } });
      expect(() => t.begin("k-aaaaaaaa", "f")).toThrow(/durably/);
      expect(t.get("k-aaaaaaaa")).toBeUndefined();
      t.close();
    }
  });
});
