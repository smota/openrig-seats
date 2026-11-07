import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverAgySessions, discoverPiSessions } from "../src/index.js";

for (const [name, discover, rootPath, sessionPath] of [
  ["pi", discoverPiSessions, ".pi/agent/sessions", "project/session.jsonl"],
  ["agy", discoverAgySessions, ".gemini/antigravity-cli/brain", "session/.system_generated/logs/transcript.jsonl"],
] as const) {
  describe(`${name} discovery boundaries`, () => {
    async function layout(run: (home: string, outside: string) => Promise<void>) {
      const temp = await mkdtemp(join(tmpdir(), "seat-discover-"));
      const home = join(temp, "home");
      const outside = join(temp, "outside");
      try {
        await mkdir(home);
        await mkdir(outside);
        await run(home, outside);
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    }
    async function session(root: string) {
      const file = join(root, sessionPath);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "{}\n");
      return file;
    }

    it("discovers normal layouts with an injected home or root", async () => {
      await layout(async (home) => {
        const root = join(home, rootPath);
        const file = await session(root);
        expect(await discover({ home })).toEqual([file]);
        expect(await discover({ root })).toEqual([file]);
      });
    });

    it("rejects a symlinked ancestor below home pointing outside", async () => {
      await layout(async (home, outside) => {
        const [first, ...rest] = rootPath.split("/");
        await session(join(outside, ...rest));
        await symlink(outside, join(home, first!), "dir");
        expect(await discover({ home })).toEqual([]);
      });
    });

    it("rejects a symlinked discovery root below home", async () => {
      await layout(async (home, outside) => {
        await session(outside);
        const root = join(home, rootPath);
        await mkdir(dirname(root), { recursive: true });
        await symlink(outside, root, "dir");
        expect(await discover({ home })).toEqual([]);
      });
    });

    it("rejects symlink components even when their target is inside home", async () => {
      await layout(async (home) => {
        const target = join(home, "actual-root");
        await session(target);
        const root = join(home, rootPath);
        await mkdir(dirname(root), { recursive: true });
        await symlink(target, root, "dir");
        expect(await discover({ home })).toEqual([]);
      });
    });

    it("rejects a session file symlink pointing outside the injected root", async () => {
      await layout(async (home, outside) => {
        const target = await session(outside);
        const root = join(home, rootPath);
        const file = join(root, sessionPath);
        await mkdir(dirname(file), { recursive: true });
        await symlink(target, file);
        expect(await discover({ home })).toEqual([]);
        expect(await discover({ root })).toEqual([]);
      });
    });
  });
}
