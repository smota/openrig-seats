import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("generated types", () => {
  it("src/types.generated.ts is up to date with the schemas", () => {
    const out = execFileSync("node", ["scripts/generate-types.mjs", "--check"], { cwd: root, encoding: "utf8" });
    expect(out).toContain("up to date");
  });
});
