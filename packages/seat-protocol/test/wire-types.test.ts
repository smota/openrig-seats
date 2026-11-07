import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ActRequest, ActResponse, DeclaredAction, Json } from "../src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// These compile only while input and result are typed as arbitrary JSON (checked by the test below).
const nested: Json = { a: [1, "two", null, true, { b: [] }] };
const reqs: ActRequest[] = [
  { idempotencyKey: "key-12345678", kind: "attention", id: "a1", action: "decline", input: { reason: "no", n: [1, 2] } },
  { idempotencyKey: "key-12345678", kind: "attention", id: "a1", action: "x", input: "text" },
  { idempotencyKey: "key-12345678", kind: "attention", id: "a1", action: "x", input: 42 },
  { idempotencyKey: "key-12345678", kind: "attention", id: "a1", action: "x", input: null },
  { idempotencyKey: "key-12345678", kind: "attention", id: "a1", action: "x", input: nested },
];
const resps: ActResponse[] = [
  { idempotencyKey: "key-12345678", status: "completed", replayed: false, result: [1, { ok: true }] },
  { idempotencyKey: "key-12345678", status: "completed", replayed: false, result: "done" },
  { idempotencyKey: "key-12345678", status: "completed", replayed: true, result: null },
];
const forms: DeclaredAction[] = [
  { id: "a", label: "A", input: true },
  { id: "b", label: "B", input: { type: "object", required: ["reason"], properties: { reason: { type: "string" } } } },
];
// @ts-expect-error a function is not JSON
const bad: ActRequest = { idempotencyKey: "key-12345678", kind: "k", id: "i", action: "a", input: () => 1 };
// @ts-expect-error undefined is not JSON
const badResult: ActResponse = { idempotencyKey: "key-12345678", status: "completed", replayed: false, result: { a: undefined } };
void [bad, badResult];

describe("wire types", () => {
  it("round-trips arbitrary JSON values", () => {
    for (const r of reqs) expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    for (const r of resps) expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    expect(forms.length).toBe(2);
  });

  it("typechecks (tsc) with the expectations above", () => {
    execFileSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.check.json"], { cwd: root, encoding: "utf8" });
  }, 60_000);
});
