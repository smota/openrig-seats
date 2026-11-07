import { constants } from "node:fs";
import { mkdtemp, mkdir, writeFile, rename, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverAgySessions, discoverPiSessions, readAgySession, readPiSession, createAgyReader, createPiReader, initialCursor } from "../src/index.js";
import { fixture } from "./helpers.js";
import { READ_WINDOW_BYTES } from "../src/follow.js";

for (const [name, discover, read, sessionPath, factory, fixtureName] of [
  ["agy", discoverAgySessions, readAgySession, "session/.system_generated/logs/transcript.jsonl", createAgyReader, "agy-session.jsonl"],
  ["pi", discoverPiSessions, readPiSession, "project/session.jsonl", createPiReader, "pi-session.jsonl"],
] as const) {
  describe(`${name} native file opens`, () => {
    async function layout(run: (root: string, file: string) => Promise<void>) {
      const root = await mkdtemp(join(tmpdir(), "seat-open-"));
      const file = join(root, sessionPath);
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, "{}\n");
        await run(root, file);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }

    it("reads a discovered regular file", async () => {
      await layout(async (root) => {
        const [file] = await discover({ root });
        expect(await read(file!)).toBe("{}\n");
      });
    });

    it("reads only the bounded tail of a large file and returns the most recent turns", async () => {
      await layout(async (_root, file) => {
        const recent = fixture(fixtureName).toString("utf8");
        await writeFile(file, "x".repeat(READ_WINDOW_BYTES + 100) + "\n" + recent);
        const text = await read(file);
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(READ_WINDOW_BYTES);
        expect(text).toBe(recent);
        const reader = factory({ seatId: "s", includeText: true, now: () => new Date("2026-11-08T00:00:00Z") });
        const result = reader.follow({ generationId: null, suffix: text }, initialCursor());
        expect(result.turns).toEqual(reader.follow({ generationId: null, suffix: recent }, initialCursor()).turns);
        expect(result.turns.length).toBeGreaterThan(0);
        expect(result.skipped).toBe(0);
      });
    });

    it("drops the partial first line even if its suffix is valid JSON", async () => {
      await layout(async (_root, file) => {
        const partial = '{"partial":true}\n';
        const recent = '{}\n';
        const padding = " ".repeat(READ_WINDOW_BYTES - Buffer.byteLength(partial + recent));
        await writeFile(file, "discarded-prefix" + partial + padding + recent);
        const text = await read(file);
        expect(text.includes("partial")).toBe(false);
        expect(Buffer.byteLength(text)).toBe(Buffer.byteLength(padding + recent));
        expect(text.endsWith(recent)).toBe(true);
      });
    });

    it("retains the first complete line when the tail starts at a line boundary", async () => {
      await layout(async (_root, file) => {
        const first = '{"complete":true}\n';
        const tail = first + " ".repeat(READ_WINDOW_BYTES - Buffer.byteLength(first));
        await writeFile(file, "old\n" + tail);
        const text = await read(file);
        expect(text.startsWith(first)).toBe(true);
        expect(Buffer.byteLength(text)).toBe(READ_WINDOW_BYTES);
      });
    });

    it.skipIf(!constants.O_NOFOLLOW)("refuses a final file replaced by a symlink after discovery", async () => {
      await layout(async (root, file) => {
        const [discovered] = await discover({ root });
        const target = `${file}.original`;
        await rename(file, target);
        await symlink(target, file);
        await expect(read(discovered!)).rejects.toMatchObject({ code: "ELOOP" });
      });
    });

    it("refuses a final file replaced by a directory after discovery", async () => {
      await layout(async (root, file) => {
        const [discovered] = await discover({ root });
        await rm(file);
        await mkdir(file);
        await expect(read(discovered!)).rejects.toThrow("regular file");
      });
    });
  });
}
