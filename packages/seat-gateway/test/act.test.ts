import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/index.js";
import { auth, MockDaemon, startGateway, waitFor, type Running } from "./helpers.js";

const schemaDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../seat-protocol/schemas");
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats.default(ajv);
for (const f of readdirSync(schemaDir).filter((x) => x.endsWith(".v1.schema.json"))) ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, f), "utf8")));
const validate = (name: string, v: unknown) => {
  const fn = ajv.getSchema(`https://smota.github.io/openrig-seats/schemas/${name}.v1.schema.json`)!;
  expect(fn(v), JSON.stringify(fn.errors)).toBe(true);
};

const SENDER = "cockpit@acme-ops";
let daemon: MockDaemon;
let gw: Running | undefined;
let dir: string;
let file: string;
const actConfig = (extra: Record<string, unknown> = {}) => ({ act: { send: true, sender: SENDER, idempotencyFile: file, ...extra } });

beforeEach(async () => {
  daemon = await new MockDaemon().start();
  dir = mkdtempSync(join(tmpdir(), "seat-act-"));
  file = join(dir, "idempotency.json");
});
afterEach(async () => {
  await gw?.stop();
  gw = undefined;
  await daemon.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function start(config: Record<string, unknown> = actConfig(), extra = {}) {
  gw = await startGateway(daemon, extra, config);
  await waitFor(() => gw!.gateway.store.items("seat").length >= 3);
  return gw;
}
const KEY = (n: string) => `key-${n}-0000000`;
const act = (body: Record<string, unknown>, headers: Record<string, string> = auth) =>
  fetch(gw!.url + "/act", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
const send = (key: string, text = "hello there", id = "node-a1") => act({ idempotencyKey: key, kind: "seat", id, action: "send", input: { text } });
const json = async (res: Response) => (await res.json()) as Record<string, any>;

describe("send action: off by default", () => {
  it("is not advertised, not declared on seats and not served", async () => {
    await start({});
    const caps = await json(await fetch(gw!.url + "/capabilities", { headers: auth }));
    expect(caps.features.act).toBe(false);
    expect(caps.actions).toBeUndefined();
    expect(gw!.gateway.store.items("seat").every((s) => s.actions === undefined)).toBe(true);
    expect((await send(KEY("a"))).status).toBe(405);
    expect(daemon.posts).toHaveLength(0);
  });

  it("act.send needs a sender and a file; the sender must look like an address", () => {
    expect(() => parseConfig({ tokenFile: "x", act: { send: true, idempotencyFile: "f" } })).toThrow(/sender/);
    expect(() => parseConfig({ tokenFile: "x", act: { send: true, sender: SENDER } })).toThrow(/idempotencyFile/);
    expect(() => parseConfig({ tokenFile: "x", act: { send: true, sender: "bad sender", idempotencyFile: "f" } })).toThrow(/name@rig/);
    expect(parseConfig({ tokenFile: "x" }).act.send).toBe(false);
  });
});

describe("send action: enabled", () => {
  it("advertises act, the actions list and a send action on every seat, all schema-valid", async () => {
    await start();
    const caps = await json(await fetch(gw!.url + "/capabilities", { headers: auth }));
    validate("capabilities", caps);
    expect(caps.features.act).toBe(true);
    expect(caps.actions).toEqual([{ kind: "seat", action: expect.objectContaining({ id: "send", danger: false, input: expect.objectContaining({ required: ["text"] }) }) }]);
    for (const s of gw!.gateway.store.items("seat")) {
      validate("seat", s);
      expect(s.actions).toEqual([caps.actions[0].action]);
    }
  });

  it("requires the gateway bearer", async () => {
    await start();
    expect((await send(KEY("a")).then(() => act({ idempotencyKey: KEY("a"), kind: "seat", id: "node-a1", action: "send", input: { text: "x" } }, {}))).status).toBe(401);
    expect((await act({}, { authorization: "Bearer wrong" })).status).toBe(401);
  });

  it("sends once as the fixed principal and maps a verified delivery to completed", async () => {
    await start(actConfig(), { daemonToken: "daemon-secret" });
    const res = await send(KEY("a"), "ship it");
    const body = await json(res);
    expect(res.status).toBe(200);
    validate("act-response", body);
    expect(body).toMatchObject({ status: "completed", replayed: false, result: { outcome: "delivered", verified: true } });
    expect(daemon.posts).toHaveLength(1);
    const p = daemon.posts[0]!;
    expect(p.headers["x-openrig-session"]).toBe(SENDER);
    expect(p.headers["x-openrig-occupant-generation"]).toBeUndefined();
    expect(p.headers.authorization).toBe("Bearer daemon-secret");
    expect(p.body).toEqual({ session: "lead-planner@acme-ops", text: "ship it", deliveryId: expect.stringMatching(/^gw-[0-9a-f]{32}$/), verify: true });
    expect(JSON.stringify(p.body)).not.toMatch(/force|dangerously|typeWithoutChecking|waitForIdle/);
    expect(gw!.logs.join("\n")).not.toContain("daemon-secret");
  });

  it("sends no daemon token when none is configured", async () => {
    await start();
    await send(KEY("a"));
    expect(daemon.posts[0]!.headers.authorization).toBeUndefined();
  });
});

describe("send action: idempotency", () => {
  beforeEach(() => start());

  it("returns the stored response for the same key and never sends again; a new key is a new send", async () => {
    const first = await json(await send(KEY("a"), "same text"));
    const again = await json(await send(KEY("a"), "same text"));
    expect(again).toMatchObject({ status: first.status, replayed: true });
    expect(daemon.posts).toHaveLength(1);
    await send(KEY("b"), "same text");
    expect(daemon.posts).toHaveLength(2);
    expect(daemon.posts[0]!.body.deliveryId).not.toBe(daemon.posts[1]!.body.deliveryId);
  });

  it("refuses a key reused for a different request", async () => {
    await send(KEY("a"), "one");
    const res = await send(KEY("a"), "two");
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("idempotency_key_reused");
    expect(daemon.posts).toHaveLength(1);
  });

  it("two writers with the same key at the same time type once", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    daemon.sendReply = async (b) => {
      await held;
      return { status: 200, body: { ok: true, sessionName: b.session, outcome: "delivered", verified: true, sent: true } };
    };
    const a = send(KEY("race"), "once");
    const b = send(KEY("race"), "once");
    await waitFor(() => daemon.posts.length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(daemon.posts).toHaveLength(1);
    release();
    const [ra, rb] = await Promise.all([a, b].map(async (p) => json(await p)));
    expect([ra!.replayed, rb!.replayed].sort()).toEqual([false, true]);
    expect(ra!.status).toBe("completed");
    expect(rb!.status).toBe("completed");
    expect(daemon.posts).toHaveLength(1);
  });

  it("two writers with different keys to one seat are sent one after the other", async () => {
    let open = 0;
    let maxOpen = 0;
    daemon.sendReply = async (b) => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      await new Promise((r) => setTimeout(r, 60));
      open--;
      return { status: 200, body: { ok: true, sessionName: b.session, outcome: "delivered", verified: true, sent: true } };
    };
    await Promise.all([send(KEY("w1"), "first"), send(KEY("w2"), "second")]);
    expect(daemon.posts).toHaveLength(2);
    expect(maxOpen).toBe(1);
  });

  it("persists to a 0600 file without the text, and a restart keeps the key", async () => {
    await send(KEY("a"), "private words");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain("private words");
    await gw!.stop();
    await start();
    const res = await json(await send(KEY("a"), "private words"));
    expect(res).toMatchObject({ status: "completed", replayed: true });
    expect(daemon.posts).toHaveLength(1);
  });

  it("a send left in flight by a crash comes back as failed and is never re-sent", async () => {
    await gw!.stop();
    const fp = (await import("node:crypto")).createHash("sha256").update(JSON.stringify(["seat", "node-a1", "send", "lost"])).digest("hex");
    writeFileSync(file, JSON.stringify({ version: 1, entries: { [KEY("crash")]: { fingerprint: fp, at: "2026-11-07T12:00:00.000Z" } } }), { mode: 0o600 });
    await start();
    const res = await send(KEY("crash"), "lost");
    expect(await json(res)).toMatchObject({ status: "failed", replayed: true, error: { code: "gateway_restarted_during_send" } });
    expect(daemon.posts).toHaveLength(0);
  });

  it("refuses a table file that others can read", async () => {
    await gw!.stop();
    writeFileSync(file, JSON.stringify({ version: 1, entries: {} }), { mode: 0o644 });
    await expect(start()).rejects.toThrow(/chmod 600/);
  });
});

describe("send action: durability guards", () => {
  it("a full table of unexpired keys answers 503 and never evicts: the old key still replays", async () => {
    await start(actConfig({ maxKeys: 1 }));
    expect((await send(KEY("a"), "one")).status).toBe(200);
    const full = await send(KEY("b"), "two");
    expect(full.status).toBe(503);
    expect((await json(full)).error.code).toBe("idempotency_table_full");
    expect((await json(await send(KEY("a"), "one"))).replayed).toBe(true);
    expect(daemon.posts).toHaveLength(1);
  });

  it("a second gateway on the same table file refuses to start", async () => {
    await start();
    await expect(startGateway(daemon, {}, actConfig())).rejects.toThrow(/lock/);
  });
});

describe("send action: refusals before anything is sent", () => {
  beforeEach(() => start());

  it("a held seat is refused", async () => {
    await gw!.stop();
    daemon.nodes.get("rig-acme-1")![0]!.heldReason = "excluded_from_subset";
    await start();
    const res = await send(KEY("a"));
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("seat_not_accepting_input");
    expect(daemon.posts).toHaveLength(0);
  });
  const none = () => expect(daemon.posts).toHaveLength(0);

  it("unknown seat, unknown action, wrong kind, bad key and missing text", async () => {
    expect((await send(KEY("a"), "x", "nope")).status).toBe(404);
    expect(await json(await act({ idempotencyKey: KEY("b"), kind: "seat", id: "node-a1", action: "stop" }))).toMatchObject({ status: "rejected", error: { code: "unknown_action" } });
    expect((await act({ idempotencyKey: KEY("c"), kind: "rig", id: "rig-acme-1", action: "send", input: { text: "x" } })).status).toBe(400);
    expect((await act({ idempotencyKey: "short", kind: "seat", id: "node-a1", action: "send", input: { text: "x" } })).status).toBe(400);
    expect((await send(KEY("d"), "   ")).status).toBe(400);
    none();
  });

  it("text over the bound is refused", async () => {
    await gw!.stop();
    await start(actConfig({ maxLength: 10 }));
    const res = await send(KEY("a"), "x".repeat(11));
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("text_too_long");
    expect((await send(KEY("b"), "x".repeat(10))).status).toBe(200);
  });

  it("seats the daemon reports as needing input or stopped are refused, and the key stays usable", async () => {
    for (const id of ["node-a2", "node-a3"]) {
      const res = await send(KEY(id), "x", id);
      expect(res.status).toBe(409);
      expect((await json(res)).error.code).toBe("seat_not_accepting_input");
    }
    none();
  });

  it("a sender that is a seat is refused", async () => {
    await gw!.stop();
    await start(actConfig({ sender: "lead-planner@acme-ops" }));
    const res = await send(KEY("a"));
    expect((await json(res)).error.code).toBe("sender_is_a_seat");
    none();
  });
});

describe("send action: outcomes and no retry", () => {
  beforeEach(() => start());
  const reply = (status: number, body: unknown) => (daemon.sendReply = () => ({ status, body }));

  it("rendered-unconfirmed is completed, retained is accepted", async () => {
    reply(200, { ok: true, outcome: "rendered-unconfirmed", sent: true });
    expect(await json(await send(KEY("a")))).toMatchObject({ status: "completed", result: { outcome: "rendered-unconfirmed", verified: false } });
    reply(200, { ok: true, outcome: "retained", sent: false, reason: "runtime_switch_in_progress" });
    expect(await json(await send(KEY("b")))).toMatchObject({ status: "accepted", result: { outcome: "retained", reason: "runtime_switch_in_progress" } });
  });

  it("a clean refusal before input is rejected with the daemon's reason code", async () => {
    reply(409, { ok: false, outcome: "failed", reason: "mid_work", sent: false, inputPhase: "not_reached", error: "free text with secret-xyz" });
    const res = await send(KEY("a"));
    const body = await json(res);
    validate("act-response", body);
    expect(body).toMatchObject({ status: "rejected", error: { code: "mid_work" } });
    expect(JSON.stringify(body)).not.toContain("secret-xyz");
    expect(daemon.posts).toHaveLength(1);
  });

  it.each([
    ["attempted", 409, { ok: false, outcome: "failed", reason: "delivery_indeterminate", inputPhase: "attempted" }],
    ["written", 502, { ok: false, outcome: "failed", reason: "submit_failed", sent: true, inputPhase: "written" }],
    ["no phase, 5xx", 502, { ok: false, reason: "send_failed" }],
    ["not json", 500, undefined],
  ])("%s is failed, returned to the person, never retried", async (_n, status, body) => {
    reply(status, body);
    const res = await send(KEY("a"));
    const out = await json(res);
    validate("act-response", out);
    expect(out.status).toBe("failed");
    expect(out.error.message).toMatch(/does not retry/);
    await send(KEY("a"));
    expect(daemon.posts).toHaveLength(1);
  });

  it("a redirect is not followed and counts as no answer (indeterminate, stored)", async () => {
    daemon.sendReply = () => ({ redirect: "http://127.0.0.1:9/elsewhere" });
    const out = await json(await send(KEY("a")));
    expect(out).toMatchObject({ status: "failed", error: { code: "daemon_no_answer" } });
    expect(daemon.posts).toHaveLength(1);
    expect((await json(await send(KEY("a")))).replayed).toBe(true);
    expect(daemon.posts).toHaveLength(1);
  });

  it("daemon authentication refusal is a rejection", async () => {
    reply(401, { error: "unauthorized" });
    expect(await json(await send(KEY("a")))).toMatchObject({ status: "rejected", error: { code: "daemon_auth_refused" } });
  });
});
