import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Turn } from "@openrig-seats/seat-protocol";
import type { GenerationRecord } from "../src/index.js";

export const fixture = (name: string): Buffer => readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", name));

export const gen = (occupant = "occ-1", file = 1) => JSON.stringify([occupant, "acme-session", "record.jsonl", 1, file, 1700000000000]);

/** Behaves like OpenRig's route: slice bytes from `since`, cap the read, decode as UTF-8 (a cut character becomes U+FFFD). */
export function serve(file: Buffer, since: number, generationId = gen(), cap = 8 * 1024 * 1024): GenerationRecord {
  const length = Math.min(file.length - since, cap);
  return { generationId, sessionId: "acme-session", totalBytes: file.length, suffix: file.subarray(since, since + length).toString("utf8"), truncated: file.length - since > length, sinceBytes: since };
}

const schemaDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../seat-protocol/schemas");
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats.default(ajv);
import { readdirSync } from "node:fs";
for (const f of readdirSync(schemaDir).filter((n) => n.endsWith(".v1.schema.json"))) ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, f), "utf8")));
const validateTurn = ajv.getSchema("https://smota.github.io/openrig-seats/schemas/turn.v1.schema.json")!;

export function assertValid(turns: Turn[]): void {
  for (const t of turns) if (!validateTurn(t)) throw new Error(`invalid turn ${JSON.stringify(t)}: ${JSON.stringify(validateTurn.errors)}`);
}
