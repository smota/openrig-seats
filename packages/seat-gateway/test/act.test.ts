import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readdirSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, IdempotencyTable } from "../src/index.js";
import { AnswerAction } from "../src/answer.js";
import { CoreAppJob, DaemonClient } from "@openrig-seats/seat-source-openrig";
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


describe("Core app human-answer job", () => {
  const actor = "human-lee@external";
  const input = { actor, requestId: "ask-1", questionId: "ship", episodeKey: null, expectedRevision: "dr1-original", optionId: "yes" };
  const request = { requestId: "ask-1", asker: "builder@acme-ops", askedPerson: actor, actor: { address: actor, assurance: "app-attributed" }, state: "pending", decisionRevision: "dr1-original", episodeKey: null, questions: [{ id: "ship", question: "Ship the report?", options: [{ id: "yes", label: "Yes" }] }], humanAnswers: {}, answer: { job: "human-answer", forms: ["option", "typed-reply"] } };
  const configure = async (actions = true) => {
    const tokenFile = join(dir, "app-token"); writeFileSync(tokenFile, "fictional-app-token", { mode: 0o600 });
    daemon.coreApp = {
      capabilities: { contract: "openrig.core-app", version: 1, jobs: [{ id: "human-answer", answerForms: ["option", "typed-reply"], actorAssurance: ["app-attributed"], stableSubmissionIds: true, resultRead: true }], app: { id: "fixture-seats", actors: [actor] } },
      snapshot: { version: 1, requests: [request], sources: [{ source: "queue", state: "available" }] },
      receipt: { submission: { state: "committed", outcome: "answered" }, links: { result: `/api/apps/v1/requests/ask-1/result?actor=${encodeURIComponent(actor)}` } },
      result: { answerReturn: { state: "returned", body: "Yes" }, permissionDecision: { state: "awaiting-agent" }, work: { completion: { status: "unknown" } } },
    };
    await start({ coreApp: { tokenFile, actor, actions, idempotencyFile: file } });
  };
  const answer = (key: string, binding = input) => act({ kind: "attention", id: "core-app:ask-1", action: "answer-option", input: binding, idempotencyKey: key });

  it("discovers only the separately authenticated optional job and preserves ordinary send refusal", async () => {
    await configure();
    const caps = await json(await fetch(gw!.url + "/capabilities", { headers: auth }));
    expect(caps.protocol.version).toBe("1.0");
    expect(caps.features["x-openrig.core-app.human-answer"]).toBe(true);
    expect(caps.features.act).toBe(true);
    const item = gw!.gateway.store.items("attention").find((x) => x.id === "core-app:ask-1")!;
    expect(item.summary).toContain("Ship the report?: Yes (yes)");
    expect((item.actions as any[])[0].input.properties.expectedRevision).toEqual({ const: "dr1-original" });
    expect(daemon.requests.filter((r) => r.path.startsWith("/api/apps/")).every((r) => r.authorization === "Bearer fictional-app-token")).toBe(true);
    expect(JSON.stringify(caps) + JSON.stringify(item)).not.toContain("fictional-app-token");
    expect((await send(KEY("unsafe"), "yes", "node-a2")).status).toBe(400);
    expect(daemon.posts).toHaveLength(0);
  });

  it("passes the rendered binding unchanged and follows actual linked result without claiming work completion", async () => {
    await configure();
    const response = await json(await answer(KEY("core")));
    expect(response).toMatchObject({ status: "completed", result: { submission: { state: "committed", outcome: "answered" } } });
    expect(daemon.appPosts[0]!.body).toEqual({ job: "human-answer", actor, requestId: "ask-1", questionId: "ship", episodeKey: null, expectedRevision: "dr1-original", answer: { kind: "option", optionId: "yes" } });
    expect(daemon.appPosts[0]!.headers["x-openrig-session"]).toBeUndefined();
    await waitFor(() => JSON.stringify(gw!.gateway.store.items("attention")).includes("awaiting-agent"));
    expect(JSON.stringify(gw!.gateway.store.items("attention"))).toContain('"status":"unknown"');
  });

  it("retries lost receipts with the same Core answer ID, including after gateway restart", async () => {
    await configure(); daemon.dropAppReceipt = true;
    expect(await json(await answer(KEY("lost")))).toMatchObject({ status: "accepted", result: { retrySameSubmission: true } });
    await gw!.stop(); await configure();
    expect(await json(await answer(KEY("lost")))).toMatchObject({ status: "completed", replayed: true });
    expect(daemon.appBindings.size).toBe(1);
    expect(readFileSync(file, "utf8")).not.toContain("submission");
    expect(daemon.appPosts).toHaveLength(2);
    expect(daemon.appPosts[1]!.path).toBe(daemon.appPosts[0]!.path);
    expect(daemon.appPosts[1]!.body).toEqual(daemon.appPosts[0]!.body);
  });

  it("refuses stale rendered revision without replacing it and rejects actor substitution", async () => {
    await configure();
    expect(await json(await answer(KEY("stale"), { ...input, expectedRevision: "dr1-stale" }))).toMatchObject({ status: "rejected", error: { code: "decision_revision_changed" } });
    expect(daemon.appPosts[0]!.body.expectedRevision).toBe("dr1-stale");
    expect((await answer(KEY("actor"), { ...input, actor: "human-other@external" })).status).toBe(403);
    expect(daemon.appPosts).toHaveLength(1);
  });

  it("lets Core refuse conflicting key reuse and retains authoritative results after attention vanishes", async () => {
    await configure(); await answer(KEY("bound"));
    expect(await json(await answer(KEY("bound"), { ...input, optionId: "no" }))).toMatchObject({ status: "rejected", error: { code: "answer_id_reused" } });
    expect(daemon.appPosts).toHaveLength(2);
    expect(daemon.appPosts[1]!.path).toBe(daemon.appPosts[0]!.path);
    daemon.coreApp!.snapshot.requests = [];
    await gw!.gateway.source.resync();
    expect(gw!.gateway.store.items("attention").find((x) => x.id === "core-app:ask-1")!.summary).toContain("awaiting-agent");
    expect(daemon.requests.some((r) => r.path === "/api/apps/v1/requests/ask-1/result" && r.query === `?actor=${encodeURIComponent(actor)}`)).toBe(true);
  });

  it("is read-only unless actions are explicitly enabled and degrades only the new job on unsupported Core", async () => {
    await configure(false);
    expect((await answer(KEY("off"))).status).toBe(405);
    expect(gw!.gateway.store.items("attention").find((x) => x.id === "core-app:ask-1")!.actions).toBeUndefined();
    daemon.coreApp!.capabilities.version = 2;
    await gw!.gateway.source.resync();
    const caps = await json(await fetch(gw!.url + "/capabilities", { headers: auth }));
    expect(caps.features.attention).toBe(true);
    expect(caps.features["x-openrig.core-app.human-answer"]).toBe(false);
    expect(caps.features.act).toBe(false);
  });
});


it.each(['{"submission":', '{"unexpected":true}'])("keeps an unreadable or unrecognized successful Core receipt uncertain: %s", async (rawReceipt) => {
  const actor = "human-lee@external";
  const calls: Array<{ path: string; body: string }> = [];
  let receipt = rawReceipt, discovered = true;
  const client = new DaemonClient({ baseUrl: "http://127.0.0.1:7433", token: "fictional-app-token", fetch: (async (url, init) => {
    const path = String(url);
    if (path.endsWith("/capabilities")) return Response.json({ contract: "openrig.core-app", version: 1, jobs: discovered ? [{ id: "human-answer", answerForms: ["option"], actorAssurance: ["app-attributed"], stableSubmissionIds: true, resultRead: true }] : [], app: { actors: [actor] } });
    if (init?.method === "POST") { calls.push({ path, body: String(init.body) }); return new Response(receipt, { status: 200, headers: { "content-type": "application/json" } }); }
    return Response.json({ version: 1, requests: [], sources: [{ source: "queue", state: "available" }] });
  }) as typeof fetch });
  const job = new CoreAppJob({ daemon: client, actor, actions: true }); await job.discover();
  const table = new IdempotencyTable(file);
  try {
    const action = new AnswerAction({ job, actor, table });
    const request = { kind: "attention", id: "core-app:A", action: "answer-option", idempotencyKey: "stable_1234", input: { actor, requestId: "A", questionId: "q1", episodeKey: null, expectedRevision: "dr1-rendered", optionId: "yes" } };
    const first = await action.handle(request);
    expect(first).toMatchObject({ httpStatus: 200, response: { status: "accepted", retrySameRequest: true, result: { answerId: expect.stringMatching(/^seats_[a-f0-9]{64}$/) } } });
    discovered = false; await job.discover();
    expect(await action.handle(request)).toMatchObject({ response: { status: "accepted", retrySameRequest: true } });
    expect(calls).toHaveLength(1);
    expect(await action.handle({ ...request, input: { ...request.input, optionId: "no" } })).toMatchObject({ httpStatus: 409, response: { error: { code: "idempotency_key_reused" } } });
    expect(await action.handle({ ...request, input: { ...request.input, actor: "human-other@external" } })).toMatchObject({ httpStatus: 403 });
    expect(table.size()).toBe(1);
    expect(await action.handle({ ...request, idempotencyKey: "new_request_123" })).toMatchObject({ httpStatus: 503, response: { status: "rejected" } });
    discovered = true; await job.discover();
    receipt = JSON.stringify({ submission: { state: "committed" }, replayed: true });
    expect(await action.handle(request)).toMatchObject({ response: { status: "completed", replayed: true } });
    expect(calls[1]).toEqual(calls[0]);
  } finally { table.close(); await job.stop(); }
});


// Explicit checkout proof uses that tree's built owners and native SQLite dependency. No daemon boot/providers.
const coreCheckout = process.env.OPENRIG_CHECKOUT;
describe.skipIf(!coreCheckout)("actual Core app job through source and gateway", () => {
  const actor = "human-fixture@external";
  async function actualCore() {
    const own = createRequire(resolve(coreCheckout!, "package.json"));
    const load = (path: string) => import(/* @vite-ignore */ pathToFileURL(resolve(coreCheckout!, "packages/daemon/dist", path)).href);
    const [migration, migrations, event, queue, accessModule, logModule, writeModule, jobModule, route, outbox, rigsModule, sessionsModule, permissionModule] = await Promise.all([
      "db/migrate.js", "db/all-migrations.js", "domain/event-bus.js", "domain/queue-repository.js", "domain/core-app-access.js", "domain/mission-control/mission-control-action-log.js", "domain/mission-control/mission-control-write-contract.js", "domain/core-app-job.js", "routes/core-app.js", "domain/outbox-handler.js", "domain/rig-repository.js", "domain/session-registry.js", "domain/runner-permissions.js",
    ].map(load));
    const Database = own("better-sqlite3"), { Hono } = own("hono");
    const db = new Database(join(dir, "actual-core.sqlite")); migration.migrate(db, migrations.ALL_MIGRATIONS);
    const registry = { ok: true, entities: [{ entityId: "human-fixture", class: "human", displayName: "Fictional operator", address: actor, connectorBindings: [], prefs: { deliveryClass: "A" } }] };
    const bus = new event.EventBus(db), repo = new queue.QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => registry, permissionDecider: () => ({ session: "lead@fixture" }), transport: { send: async () => ({ ok: true, verified: true, sent: true }) } });
    repo.attachOutbox(new outbox.OutboxHandler(db));
    const access = new accessModule.CoreAppAccess(db, repo), log = new logModule.MissionControlActionLog(db);
    const writes = new writeModule.MissionControlWriteContract({ db, eventBus: bus, queueRepo: repo, actionLog: log });
    const job = new jobModule.CoreAppJob(access, repo, bus, writes, log);
    const app = new Hono(), requests: Array<{ path: string; query: string; attribution: boolean }> = [], posts: Array<{ path: string; body: unknown }> = [];
    let loseReceipt = false;
    app.use("*", async (c: any, next: () => Promise<void>) => {
      requests.push({ path: c.req.path, query: new URL(c.req.url).search, attribution: !!c.req.header("x-openrig-session") });
      await next();
      if (c.req.method === "POST" && c.req.path.includes("/answers/")) {
        posts.push({ path: c.req.path, body: await c.req.json() });
        if (loseReceipt && c.res.status === 200) { loseReceipt = false; c.res = new Response('{"submission":', { status: 200, headers: { "content-type": "application/json" } }); }
      }
    });
    app.route("/api/apps", route.coreAppRoutes({ access, operatorToken: "fictional-operator", job }));
    // Unrelated inventory comes from the existing fictional daemon, never from an installed Core.
    app.all("*", (c: any) => fetch(daemon.url + new URL(c.req.url).pathname + new URL(c.req.url).search, { signal: c.req.raw.signal }));
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }) as HttpServer;
    await new Promise<void>((done, fail) => { server.once("listening", done); server.once("error", fail); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const provision = await fetch(url + "/api/apps/v1/credentials", { method: "POST", headers: { authorization: "Bearer fictional-operator", "content-type": "application/json" }, body: JSON.stringify({ appId: "seats-fixture", actors: [actor], job: "human-answer", attribution: "app-attributed" }) });
    expect(provision.status).toBe(201);
    const credential = await provision.json() as { token: string };
    const appTokenFile = join(dir, "actual-app-token"); writeFileSync(appTokenFile, credential.token, { mode: 0o600 });
    const config = { daemonUrl: url, act: { send: true, sender: SENDER, idempotencyFile: file }, coreApp: { tokenFile: appTokenFile, actor, actions: true, idempotencyFile: join(dir, "actual-answer-keys") } };
    const start = async () => { gw = await startGateway(daemon, {}, config); };
    const item = (id: string) => gw!.gateway.store.items("attention").find(i => i.id === `core-app:${id}`) as Record<string, any> | undefined;
    const answer = async (id: string, key: string, option: string) => {
      const card = await waitFor(() => item(id)?.actions?.length && item(id));
      const declaration = card.actions.find((a: any) => a.id.startsWith("answer-option:"));
      const input = Object.fromEntries(Object.entries(declaration.input.properties).filter(([, v]) => Object.hasOwn(v as object, "const")).map(([k, v]) => [k, (v as any).const]));
      return { kind: "attention", id: card.id, action: declaration.id, input: { ...input, optionId: option }, idempotencyKey: key };
    };
    const permission = async () => {
      const rigs = new rigsModule.RigRepository(db), rig = rigs.createRig("fixture"), node = rigs.addNode(rig.id, "runner", { runtime: "synth" });
      const sessions = new sessionsModule.SessionRegistry(db); sessions.registerSession(node.id, "runner@fixture");
      const generation = sessions.currentOccupantTenure(node.id).generationUuid;
      const permissions = new permissionModule.RunnerPermissions({ db, queueRepo: repo, eventBus: bus, humanRegistry: () => registry, ownerOf: () => actor, currentGeneration: (id: string) => sessions.currentOccupantTenure(id)?.generationUuid ?? null });
      const ask = await permissions.submit({ nodeId: node.id, sessionName: "runner@fixture", generation }, { nativeRef: "fictional-session", turnId: "fictional-turn", requestId: "fictional-permission", toolCall: { title: "Write fictional report", kind: "edit" }, options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject once", kind: "reject_once" }] });
      expect(ask.ok).toBe(true); return { permissions, askId: ask.askId };
    };
    const stop = async () => { await gw?.stop(); gw = undefined; server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await waitFor(() => bus.subscriberCount === 0, 4000, "actual Core app SSE subscription cleanup"); db.close(); };
    return { db, bus, repo, log, requests, posts, config, start, item, answer, permission, stop, url, token: credential.token, loseReceipt: () => { loseReceipt = true; } };
  }

  it("discovers, answers, recovers a lost receipt after gateway restart, and follows actual event/poll results", { timeout: 45000 }, async () => {
    const f = await actualCore();
    try {
      const ask = await f.repo.create({ sourceSession: "lead-planner@acme-ops", destinationSession: actor, body: "Fictional report decision", humanIntent: "decision", humanQuestions: [{ id: "ship", question: "Ship the report?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }], nudge: false });
      const work = await f.repo.create({ sourceSession: "builder@fixture", destinationSession: "builder@fixture", body: "Prepare fictional report", nudge: false });
      f.repo.claim({ qitemId: work.qitemId, destinationSession: "builder@fixture" }); f.repo.update({ qitemId: work.qitemId, actorSession: "builder@fixture", state: "blocked", blockedOn: ask.qitemId });
      await f.start();
      const original = await f.answer(ask.qitemId, KEY("actual-core"), "yes");
      const caps = await json(await fetch(gw!.url + "/capabilities", { headers: auth }));
      expect(caps.features["x-openrig.core-app.human-answer"]).toBe(true); expect(caps.protocol.version).toBe("1.0");
      f.loseReceipt();
      expect(await json(await act(original))).toMatchObject({ status: "accepted", retrySameRequest: true });
      expect(f.repo.getHumanAnswer(ask.qitemId, actor)?.sourceSession).toBe(actor);
      await gw!.stop(); await f.start();
      const initialRetry = await json(await act(original));
      expect(["accepted", "completed"], JSON.stringify(initialRetry)).toContain(initialRetry.status);
      if (initialRetry.status === "accepted") expect(initialRetry.retrySameRequest).toBe(true);
      await waitFor(() => gw!.gateway.source.status().seatsSynced);
      const replay = await json(await act(original));
      expect(replay, JSON.stringify(replay)).toMatchObject({ status: "completed", replayed: true, result: { actor: { address: actor, assurance: "app-attributed" }, submission: { state: "committed", outcome: "answered" } } });
      expect(f.posts.length).toBeGreaterThanOrEqual(2); for (const posted of f.posts) expect(posted).toEqual(f.posts[0]);
      expect(f.log.countAll()).toBe(1); expect(f.db.prepare("SELECT COUNT(*) n FROM queue_items WHERE reply_to = ?").get(ask.qitemId)).toEqual({ n: 1 });
      for (const link of Object.values(replay.result.links) as string[]) expect(link).toContain(`actor=${encodeURIComponent(actor)}`);
      const request = await fetch(f.url + replay.result.links.request, { headers: { authorization: `Bearer ${f.token}` } });
      expect(request.status).toBe(200); expect(await request.json()).toMatchObject({ requestId: ask.qitemId, actor: { address: actor } });
      expect((await send(KEY("still-unsafe"), "yes", "node-a2")).status).toBe(409); expect(daemon.posts).toHaveLength(0);
      await waitFor(() => f.requests.some(r => r.path === "/api/apps/v1/events"));
      await new Promise(done => setTimeout(done, 200));
      f.db.prepare("UPDATE queue_items SET blocked_on = NULL, state = 'in-progress' WHERE qitem_id = ?").run(work.qitemId);
      const result = await f.repo.create({ sourceSession: "builder@fixture", destinationSession: actor, body: "Actual recorded result: fictional report delivered", inboundReplyTo: work.qitemId, humanIntent: "update", nudge: false });
      f.repo.update({ qitemId: work.qitemId, actorSession: "builder@fixture", state: "done", closureReason: "no-follow-on", evidenceRef: "artifact:fictional-report" });
      const current = await waitFor(() => f.item(ask.qitemId)?.["x-openrig.core-app"]?.result?.work?.records?.some((r: any) => r.qitemId === result.qitemId) && f.item(ask.qitemId));
      expect(current["x-openrig.core-app"].result).toMatchObject({ answerReturn: { status: "returned" }, permissionDecision: { status: "not-applicable", nativeEffect: "unknown" }, work: { completion: { status: "unknown" } } });
      expect(current["x-openrig.core-app"].result.work.edges).toContainEqual(expect.objectContaining({ from: ask.qitemId, to: work.qitemId, relation: "blocked-on", captured: true }));
      await new Promise(done => setTimeout(done, 200));
      const seq = f.bus.maxSeq(); f.db.prepare("UPDATE queue_items SET body = ? WHERE qitem_id = ?").run("Polled actual result without an event", result.qitemId);
      await waitFor(() => JSON.stringify(f.item(ask.qitemId)).includes("Polled actual result without an event"), 8000, "mandatory poll of an eventless Core result change"); expect(f.bus.maxSeq()).toBe(seq);
      expect(f.requests.filter(r => r.path === "/api/apps/v1/needs-me" || r.path.endsWith("/result")).every(r => r.query.includes(`actor=${encodeURIComponent(actor)}`))).toBe(true);
      expect(f.requests.filter(r => r.path === "/api/apps/v1/events").every(r => r.query === "" && !r.attribution)).toBe(true);
      expect((JSON.stringify(current) + JSON.stringify(caps)).includes(f.token)).toBe(false);
    } finally { await f.stop(); }
  });

  it("keeps the human answer distinct from receiving-agent permission and unknown native effect", { timeout: 30000 }, async () => {
    const f = await actualCore();
    try {
      const p = await f.permission(); await f.start();
      expect(await json(await act(await f.answer(p.askId, KEY("actual-permission"), "allow")))).toMatchObject({ status: "completed" });
      const waiting = await waitFor(() => f.item(p.askId)?.["x-openrig.core-app"]?.result?.permissionDecision?.status === "awaiting-agent" && f.item(p.askId));
      expect(waiting["x-openrig.core-app"].result.answerReturn).toMatchObject({ status: "kept-for-agent", replyQitemId: null });
      expect(waiting["x-openrig.core-app"].result.permissionDecision.nativeEffect).toBe("unknown");
      expect(p.permissions.decide(p.askId, "allow", "lead@fixture", "Fictional receiving-agent decision")).toMatchObject({ state: "answered", optionId: "allow" });
      await waitFor(() => f.item(p.askId)?.["x-openrig.core-app"]?.result?.permissionDecision?.status === "decided");
      expect(f.item(p.askId)!["x-openrig.core-app"].result.permissionDecision).toMatchObject({ status: "decided", option: "allow", decider: "lead@fixture", nativeEffect: "unknown" });
      expect(daemon.posts).toHaveLength(0);
    } finally { await f.stop(); }
  });
});
