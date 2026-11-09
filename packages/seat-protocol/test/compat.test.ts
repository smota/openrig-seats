import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const readJson = (path: string) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const compat = readJson("openrig-compat.json");

describe("declared compatibility", () => {
  it("matches the repository version and protocol constant", () => {
    expect(compat.repositoryVersion).toBe(readJson("package.json").version);
    expect(compat.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("matches every checked-in schema's major version and dialect", () => {
    const files = readdirSync(resolve(root, "packages/seat-protocol/schemas")).filter((file) => file.endsWith(".schema.json"));
    expect(files.length).toBeGreaterThan(0);
    expect(compat.schemaVersion).toBe(`v${PROTOCOL_VERSION.split(".")[0]}`);
    expect(compat.jsonSchemaDialect).toBe("https://json-schema.org/draft/2020-12/schema");
    for (const file of files) {
      const schema = readJson(`packages/seat-protocol/schemas/${file}`);
      expect(file, file).toMatch(new RegExp(`\\.${compat.schemaVersion}\\.schema\\.json$`));
      expect(schema.$schema, file).toBe(compat.jsonSchemaDialect);
      expect(schema.$id, file).toBe(`https://smota.github.io/openrig-seats/schemas/${file}`);
    }
  });
});
