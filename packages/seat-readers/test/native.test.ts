import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createAgyReader, createPiReader, discoverAgySessions, discoverPiSessions, createReaders, selectReader, initialCursor } from "../src/index.js";
import { assertValid, fixture, serve } from "./helpers.js";

for (const [name, factory, file] of [["agy", createAgyReader, "agy-session.jsonl"], ["pi", createPiReader, "pi-session.jsonl"]] as const) {
  describe(name, () => {
    it("maps native records to valid turns without leaking private payloads", () => {
      const result = factory({ seatId: "s" }).follow(serve(fixture(file), 0), initialCursor());
      assertValid(result.turns);
      expect(result.turns.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE/);
      expect(result.cursor.offset).toBe(fixture(file).length);
      expect(result.turns.flatMap(t => t.parts).some(p => p.type === "tool")).toBe(true);
      if (name === "agy") expect(result.turns.flatMap(t => t.parts).find(p => p.type === "tool")).toMatchObject({ phase: "start", status: "pending" });
      if (name === "pi") expect(result.turns.flatMap(t => t.parts).filter(p => p.type === "tool")).toEqual([
        expect.objectContaining({ id: "call1", phase: "start", name: "read", status: "running" }),
        expect.objectContaining({ id: "call1", phase: "end", name: "read", status: "failed" }),
      ]);
    });
    it("includes conversation text only when requested", () => {
      const result = factory({ seatId: "s", includeText: true }).follow(serve(fixture(file), 0), initialCursor());
      assertValid(result.turns);
      expect(JSON.stringify(result.turns)).toContain("Synthetic prompt ☕");
      expect(result.turns.find(t => t.role === "user")?.parts).toContainEqual(expect.objectContaining({ type: "text", text: "Synthetic prompt ☕" }));
      expect(result.turns.find(t => t.role === "assistant" && t.parts.some(p => p.type === "text"))?.parts).toContainEqual(expect.objectContaining({ type: "text", text: "Synthetic reply" }));
      expect(result.turns.flatMap(t => t.parts)).toContainEqual(expect.objectContaining({ type: "status", state: "thinking" }));
      expect(JSON.stringify(result.turns)).toContain("Synthetic reply");
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE/);
    });
    it("holds partial lines and resumes with stable ids and no duplication", () => {
      const reader = factory({ seatId: "s", includeText: true });
      const data = fixture(file);
      const cut = data.indexOf(10) + 8;
      const a = reader.follow(serve(data.subarray(0, cut), 0), initialCursor());
      const b = reader.follow(serve(data, a.cursor.offset), a.cursor);
      expect([...a.turns, ...b.turns]).toEqual(reader.follow(serve(data, 0), initialCursor()).turns);
      expect(b.cursor.offset).toBe(data.length);
    });
    it("counts malformed lines and refetches a replaced generation", () => {
      const reader = factory({ seatId: "s" });
      const bytes = Buffer.concat([fixture(file), Buffer.from("{broken\n")]);
      const result = reader.follow(serve(bytes, 0), initialCursor());
      expect(result.skipped).toBe(1);
      const replaced = reader.follow({ generationId: "replacement", suffix: "", sinceBytes: result.cursor.offset }, result.cursor);
      expect(replaced).toMatchObject({ refetch: true, restarted: true, cursor: { offset: 0 } });
      expect(reader.detect({ id: "s", harness: "other" })).toBe(false);
    });
    it("selects the verified harness", () => {
      expect(selectReader({ id: "s", harness: name }, createReaders({ seatId: "s" })).name).toBe(`${name}-jsonl`);
    });
  });
}

it("discovers only native paths from injected home/root", async () => {
  const home = mkdtempSync(join(tmpdir(), "seat-native-"));
  try {
    const agy = join(home, ".gemini/antigravity-cli/brain/session/.system_generated/logs/transcript.jsonl");
    const pi = join(home, ".pi/agent/sessions/project/session.jsonl");
    for (const path of [agy, pi]) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "{}\n"); }
    expect(await discoverAgySessions({ home })).toEqual([agy]);
    expect(await discoverPiSessions({ home })).toEqual([pi]);
    expect(await discoverPiSessions({ root: join(home, ".pi/agent/sessions") })).toEqual([pi]);
    expect(await discoverAgySessions({ home: join(home, "absent") })).toEqual([]);
    const linked = join(home, ".gemini/antigravity-cli/brain/linked");
    mkdirSync(linked);
    symlinkSync(join(home, ".gemini/antigravity-cli/brain/session/.system_generated"), join(linked, ".system_generated"));
    expect(await discoverAgySessions({ home })).toEqual([agy]);
    await expect(discoverPiSessions({})).rejects.toThrow("injected");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("pairs Pi tool results across polls using pending cursor state", () => {
  const data = fixture("pi-session.jsonl");
  const cut = data.indexOf(Buffer.from('{"type":"message","id":"r1"'));
  const reader = createPiReader({ seatId: "s" });
  const first = reader.follow(serve(data.subarray(0, cut), 0), initialCursor());
  expect(first.cursor.pending).toEqual({ call1: "read" });
  const second = reader.follow(serve(data, first.cursor.offset), first.cursor);
  expect(second.turns.flatMap(t => t.parts)).toContainEqual(expect.objectContaining({ id: "call1", name: "read", phase: "end", status: "failed" }));
  expect(second.cursor.pending).toBeUndefined();
});
