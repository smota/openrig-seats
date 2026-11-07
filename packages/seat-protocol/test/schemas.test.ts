import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

const schemaDir = resolve(dirname(fileURLToPath(import.meta.url)), "../schemas");
const fixtureDir = join(schemaDir, "fixtures");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

const files = readdirSync(schemaDir).filter((f) => f.endsWith(".v1.schema.json"));
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats.default(ajv);
for (const f of files) ajv.addSchema(readJson(join(schemaDir, f)));
const names = files.map((f) => f.replace(".v1.schema.json", "")).filter((n) => n !== "common");

const validate = (name: string) => {
  const v = ajv.getSchema(readJson(join(schemaDir, `${name}.v1.schema.json`)).$id);
  if (!v) throw new Error(`schema ${name} not found`);
  return v;
};

describe("schema set", () => {
  it("lists exactly the protocol kinds and messages", () => {
    expect(names.sort()).toEqual([
      "act-request", "act-response", "action", "attention", "capabilities", "host", "rig", "seat", "stream-control", "stream-envelope", "terminal", "terminal-scroll", "turn", "work", "x-openrig-event", "x-openrig-seat",
    ]);
  });

  it("declares JSON Schema 2020-12 and a matching $id for every schema", () => {
    for (const f of files) {
      const s = readJson(join(schemaDir, f));
      expect(s.$schema, f).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(String(s.$id).endsWith(`/${f}`), f).toBe(true);
    }
  });

  it("never closes objects: unknown fields must be ignorable", () => {
    for (const f of files) expect(readFileSync(join(schemaDir, f), "utf8"), f).not.toMatch(/"additionalProperties":\s*false/);
  });
});

for (const name of names) {
  describe(`fixtures: ${name}`, () => {
    const dir = (kind: string) => join(fixtureDir, kind, name);
    const list = (kind: string) => (existsSync(dir(kind)) ? readdirSync(dir(kind)).filter((f) => f.endsWith(".json")) : []);

    it("has valid and invalid fixtures", () => {
      expect(list("valid").length).toBeGreaterThanOrEqual(1);
      expect(list("invalid").length).toBeGreaterThanOrEqual(2);
    });

    for (const f of list("valid")) {
      it(`accepts valid/${f}`, () => {
        const v = validate(name);
        const ok = v(readJson(join(dir("valid"), f)));
        expect(ok, JSON.stringify(v.errors)).toBe(true);
      });
    }
    for (const f of list("invalid")) {
      it(`rejects invalid/${f}`, () => {
        expect(validate(name)(readJson(join(dir("invalid"), f)))).toBe(false);
      });
    }
  });
}
