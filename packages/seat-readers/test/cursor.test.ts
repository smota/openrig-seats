import { describe, expect, it } from "vitest";
import { createClaudeJsonlReader, initialCursor, occupantGeneration, restartCursor } from "../src/index.js";
import { assertValid, fixture, gen, serve } from "./helpers.js";

const reader = createClaudeJsonlReader({ seatId: "seat-acme" });
const line = (n: number, text: string) => JSON.stringify({ type: "user", uuid: `u${n}`, timestamp: "2026-11-07T10:00:00Z", message: { role: "user", content: text } }) + "\n";

describe("cursor rule", () => {
  it("advances by the UTF-8 byte length of complete lines only", () => {
    const file = Buffer.from(line(1, "café ☕") + line(2, "b"));
    const r = reader.follow(serve(file, 0), initialCursor());
    expect(r.cursor.offset).toBe(file.length);
    expect(r.turns).toHaveLength(2);
    expect(file.length).toBeGreaterThan(file.toString("utf8").length);
  });

  it("holds back a partial last line and delivers it once complete", () => {
    const full = Buffer.from(line(1, "one") + line(2, "two"));
    const cut = line(1, "one").length + 10;
    const first = reader.follow(serve(full.subarray(0, cut), 0), initialCursor());
    expect(first.turns.map((t) => t.id)).toEqual(["u1"]);
    expect(first.cursor.offset).toBe(Buffer.byteLength(line(1, "one")));
    const second = reader.follow(serve(full, first.cursor.offset), first.cursor);
    expect(second.turns.map((t) => t.id)).toEqual(["u2"]);
    expect(second.cursor.offset).toBe(full.length);
  });

  it("no new bytes: nothing, cursor unchanged", () => {
    const file = Buffer.from(line(1, "one"));
    const a = reader.follow(serve(file, 0), initialCursor());
    const b = reader.follow(serve(file, a.cursor.offset), a.cursor);
    expect(b.turns).toEqual([]);
    expect(b.cursor).toEqual(a.cursor);
  });

  it("handles a multi-byte character split at the 8 MiB read boundary with no loss or duplicate", () => {
    const cap = 8 * 1024 * 1024;
    const head = line(1, "start");
    // pad so the next line's two-byte "é" straddles byte `cap`
    const prefixBytes = `{"type":"user","uuid":"u2","message":{"role":"user","content":"`;
    const used = Buffer.byteLength(head) + Buffer.byteLength(prefixBytes);
    const filler = "x".repeat(cap - used - 1); // one byte left before the boundary, then "é" (2 bytes) straddles it
    const second = `${prefixBytes}${filler}étail"}}\n`;
    const file = Buffer.from(head + second + line(3, "end"));
    expect(file[cap - 1]).toBe(0xc3); // first byte of the split character
    const first = reader.follow(serve(file, 0), initialCursor());
    expect(first.cursor.offset).toBe(Buffer.byteLength(head)); // the straddling line is held back whole
    expect(first.turns.map((t) => t.id)).toEqual(["u1"]);
    const next = reader.follow(serve(file, first.cursor.offset), first.cursor);
    expect(next.turns.map((t) => t.id)).toEqual(["u2"]); // the next 8 MiB read ends inside line 3
    const last = reader.follow(serve(file, next.cursor.offset), next.cursor);
    expect(last.turns.map((t) => t.id)).toEqual(["u3"]);
    expect(last.cursor.offset).toBe(file.length);
    const text = (next.turns[0]!.parts[0] as { text: string }).text;
    expect(text.endsWith("étail")).toBe(true);
    expect(text).not.toContain("�");
  });

  it("reports a stall when one line exceeds the read cap", () => {
    const big = Buffer.from(line(1, "y".repeat(300)));
    const r = reader.follow(serve(big, 0, gen(), 100), initialCursor());
    expect(r.stalled).toBe(true);
    expect(r.cursor.offset).toBe(0);
  });

  it("skips and counts malformed lines without losing offsets", () => {
    const file = Buffer.from(line(1, "a") + "{not json\n\n" + line(2, "b"));
    const r = reader.follow(serve(file, 0), initialCursor());
    expect(r.skipped).toBe(1);
    expect(r.lines).toBe(3);
    expect(r.turns.map((t) => t.id)).toEqual(["u1", "u2"]);
    expect(r.cursor.offset).toBe(file.length);
  });

  it("restarts from 0 when the generationId changes (file replaced)", () => {
    const old = Buffer.from(line(1, "old") + line(2, "old2"));
    const a = reader.follow(serve(old, 0, gen("occ-1", 1)), initialCursor());
    const fresh = Buffer.from(line(9, "new"));
    // The caller asked from the old offset, so the suffix is from the wrong file.
    const bad = reader.follow({ ...serve(fresh, 0, gen("occ-1", 2)), sinceBytes: a.cursor.offset }, a.cursor);
    expect(bad.refetch).toBe(true);
    expect(bad.restarted).toBe(true);
    expect(bad.cursor).toEqual({ generationId: gen("occ-1", 2), offset: 0 });
    const ok = reader.follow(serve(fresh, 0, gen("occ-1", 2)), bad.cursor);
    expect(ok.turns.map((t) => t.id)).toEqual(["u9"]);
    expect(ok.cursor.offset).toBe(fresh.length);
  });

  it("restartCursor handles a 409 record_truncated by keeping the generation and going back to 0", () => {
    expect(restartCursor({ generationId: gen(), offset: 99 })).toEqual({ generationId: gen(), offset: 0 });
  });

  it("asks for a refetch when the record was read from another offset", () => {
    const file = Buffer.from(line(1, "a") + line(2, "b"));
    const a = reader.follow(serve(file, 0), initialCursor());
    const r = reader.follow({ ...serve(file, 0), sinceBytes: 0 }, a.cursor);
    expect(r.refetch).toBe(true);
    expect(r.turns).toEqual([]);
  });
});

describe("occupantGeneration", () => {
  it("is generationId[0], not the whole id", () => {
    expect(occupantGeneration(gen("occ-7", 1))).toBe("occ-7");
    expect(occupantGeneration(gen("occ-7", 2))).toBe("occ-7");
    expect(gen("occ-7", 1)).not.toBe(gen("occ-7", 2));
  });
  it("is null for null, malformed or non-string first elements", () => {
    expect(occupantGeneration(null)).toBeNull();
    expect(occupantGeneration("nope")).toBeNull();
    expect(occupantGeneration(JSON.stringify([null, "s"]))).toBeNull();
  });
});

describe("turn validity", () => {
  it("emits schema-valid turns for the recorded session", () => {
    const r = reader.follow(serve(fixture("claude-session.jsonl"), 0), initialCursor());
    assertValid(r.turns);
  });
});
