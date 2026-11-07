import { constants } from "node:fs";
import { mkdtemp, mkdir, writeFile, rename, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverAgySessions, discoverPiSessions, readAgySession, readPiSession } from "../src/index.js";

for (const [name, discover, read, sessionPath] of [
  ["agy", discoverAgySessions, readAgySession, "session/.system_generated/logs/transcript.jsonl"],
  ["pi", discoverPiSessions, readPiSession, "project/session.jsonl"],
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
