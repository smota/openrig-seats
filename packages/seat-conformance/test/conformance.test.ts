import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_EVENT_FIELDS,
  REQUIRED_INPUT_PHASES,
  REQUIRED_SEND_REQUEST_FIELDS,
  REQUIRED_SEND_RESULT_FIELDS,
  extractTerminalContract,
  extractSendRequestFields,
  extractSendResult,
  REQUIRED_MOUNTS,
  REQUIRED_NODE_FIELDS,
  REQUIRED_ROUTES,
  REQUIRED_TOKENS,
  buildSnapshot,
  diffRemovals,
  extractOutcomes,
  extractRigEventTypes,
  extractEventFields,
  extractNodeFields,
  extractMounts,
  extractRoutes,
  hasToken,
  extractStatusMap,
  extractSurfaces,
  resolveOpenRigPath,
  type Snapshot,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(readFileSync(resolve(here, "../snapshots/openrig-surfaces.json"), "utf8")) as Snapshot;
const compat = JSON.parse(readFileSync(resolve(here, "../../../openrig-compat.json"), "utf8")) as {
  tested: Array<{ commit: string; role: string }>;
};
const checkout = process.env.OPENRIG_CHECKOUT;
const pinnedCommit = compat.tested.find((t) => t.role === "pinned")!.commit;
const available = !!checkout && existsSync(resolve(checkout, "packages/daemon/src/server.ts"));
const root = checkout ?? "";

describe("snapshot file", () => {
  it("is for the pinned commit listed in openrig-compat.json", () => {
    expect(snapshot.schema).toBe("openrig-seats.conformance-snapshot/v1");
    expect(snapshot.openrigCommit).toBe(pinnedCommit);
  });

  it("covers every surface the gateway depends on", () => {
    const s = snapshot.surfaces;
    expect(s.mounts).toEqual([...REQUIRED_MOUNTS].sort());
    for (const r of REQUIRED_ROUTES) {
      expect(s.routes[r.file], `${r.file} ${r.router} ${r.method} ${r.path}`).toContain(`${r.router} ${r.method.toUpperCase()} ${r.path}`);
    }
    for (const t of REQUIRED_TOKENS) expect(s.tokens[t.file]).toContain(t.token);
    expect(s.transport.outcomes).toEqual(["delivered", "failed", "rendered-unconfirmed", "retained"]);
    expect(s.transport.sendRequestFields).toEqual([...REQUIRED_SEND_REQUEST_FIELDS].sort());
    expect(s.transport.sendResultFields).toEqual([...REQUIRED_SEND_RESULT_FIELDS].sort());
    expect(s.transport.inputPhases).toEqual([...REQUIRED_INPUT_PHASES].sort());
    expect(s.transport.failureStatus.session_missing).toBe(404);
    expect(s.transport.failureStatus.tmux_unavailable).toBe(503);
    for (const v of ["agent.activity", "rig.created", "seat.model_divergence"]) expect(s.rigEventTypes).toContain(v);
  });

  it("records every daemon node field and RigEvent field the x-openrig extension reads", () => {
    const s = snapshot.surfaces;
    for (const [group, fields] of Object.entries(REQUIRED_NODE_FIELDS)) expect(s.nodeFields[group as keyof typeof s.nodeFields], group).toEqual([...fields].sort());
    for (const [event, fields] of Object.entries(REQUIRED_EVENT_FIELDS)) {
      expect(s.rigEventTypes, event).toContain(event);
      expect(s.eventFields[event], event).toEqual([...fields].sort());
    }
    for (const v of ["queue.created", "queue.claimed", "queue.handed_off", "queue.updated"]) expect(s.rigEventTypes).toContain(v);
  });
});

describe.skipIf(checkout === undefined)("OpenRig checkout", () => {
  it("an explicit OPENRIG_CHECKOUT points to a checkout", () => {
    expect(resolveOpenRigPath()).toBeTruthy();
    expect(available, "OPENRIG_CHECKOUT does not contain packages/daemon/src/server.ts").toBe(true);
  });
});

describe.skipIf(!available)("OpenRig checkout surfaces", () => {
  it("has no removed or renamed surface compared with the snapshot", () => {
    expect(diffRemovals(snapshot, extractSurfaces(root))).toEqual([]);
  });

  it("matches the snapshot exactly at the pinned commit (additions need a snapshot refresh)", () => {
    const fresh = buildSnapshot(root);
    if (fresh.openrigCommit !== snapshot.openrigCommit) return; // another checkout: only removals matter
    expect(fresh).toEqual(snapshot);
  });
});

describe("removal detection", () => {
  const base = structuredClone(snapshot.surfaces);

  it("reports a removed route, a renamed mount and a dropped token", () => {
    const cur = structuredClone(base);
    cur.routes.queue = cur.routes.queue!.filter((r) => r !== "app GET /open-human-updates");
    cur.mounts = cur.mounts.map((m) => (m === "/api/ps" ? "/api/processes" : m));
    cur.tokens.events = cur.tokens.events!.filter((t) => t !== "Last-Event-ID");
    expect(diffRemovals(snapshot, cur).sort()).toEqual([
      "mount removed: /api/ps",
      "route removed in queue: app GET /open-human-updates",
      "token removed in events: Last-Event-ID",
    ]);
  });

  it("reports a removed outcome, a changed status and a removed RigEvent variant", () => {
    const cur = structuredClone(base);
    cur.transport.outcomes = cur.transport.outcomes.filter((o) => o !== "retained");
    cur.transport.failureStatus.session_missing = 410;
    delete cur.transport.failureStatus.send_failed;
    cur.rigEventTypes = cur.rigEventTypes.filter((t) => t !== "agent.activity");
    expect(diffRemovals(snapshot, cur)).toEqual([
      "transport outcome removed: retained",
      "transport failure reason removed: send_failed",
      "transport failure status changed: session_missing 404 -> 410",
      "RigEvent variant removed: agent.activity",
    ]);
  });

  it("reports a renamed node field and a renamed event field", () => {
    const cur = structuredClone(base);
    cur.nodeFields.node = cur.nodeFields.node.map((f) => (f === "heldReason" ? "heldBecause" : f));
    cur.nodeFields.needsInput = cur.nodeFields.needsInput.filter((f) => f !== "reason");
    cur.eventFields["queue.handed_off"] = cur.eventFields["queue.handed_off"]!.filter((f) => f !== "toSession");
    delete cur.eventFields["queue.claimed"];
    expect(diffRemovals(snapshot, cur).sort()).toEqual([
      "RigEvent field removed (queue.claimed): destinationSession",
      "RigEvent field removed (queue.claimed): qitemId",
      "RigEvent field removed (queue.claimed): summary",
      "RigEvent field removed (queue.handed_off): toSession",
      "node field removed (needsInput): reason",
      "node field removed (node): heldReason",
    ]);
  });

  it("reports a removed send request field, result field and input phase", () => {
    const cur = structuredClone(base);
    cur.transport.sendRequestFields = cur.transport.sendRequestFields.filter((f) => f !== "deliveryId");
    cur.transport.sendResultFields = cur.transport.sendResultFields.filter((f) => f !== "inputPhase");
    cur.transport.inputPhases = cur.transport.inputPhases.filter((f) => f !== "not_reached");
    expect(diffRemovals(snapshot, cur)).toEqual([
      "transport send request field removed: deliveryId",
      "transport send result field removed: inputPhase",
      "transport input phase removed: not_reached",
    ]);
  });

  it("allows additions", () => {
    const cur = structuredClone(base);
    cur.rigEventTypes.push("new.event");
    cur.transport.failureStatus.brand_new = 409;
    cur.routes.queue!.push("app GET /extra");
    expect(diffRemovals(snapshot, cur)).toEqual([]);
  });
});

describe("extractors", () => {
  it("reads cast router registrations and the terminal input contract", () => {
    expect(extractRoutes(`(app as any).get("/api/terminal/:sessionName", h);`)).toEqual(["app GET /api/terminal/:sessionName"]);
    expect(extractTerminalContract(`if (msg.type === "scroll" && typeof msg.offset === "number") broker.scroll(subscriber, msg.offset);`,
      `if (deps.enableNodeWebSocket && deps.webUiEnabled === true) { registerTerminalWs(app, ws); }`,
      `router.get("/:key", c => c.json(store.resolveOne(key)));`,
      `interface ResolvedSetting { value: boolean; source: string; } const keys = ["ui.enabled"];`)).toEqual({
        frameTypes: ["scroll"], scrollFields: ["offset"], uiGate: true, configResolveOne: true, configFields: ["value"], uiSetting: true,
      });
  });

  it("reads node and event fields from type declarations, ignoring comments", () => {
    const src = `interface AgentActivity { state: string; reason: string }
      export interface NodeInventoryEntry { nodeId: string; // heldReason: string
        heldReason?: string | null; activityState?: { activity: string; needsInput: { count: number; reason: string | null } } | null }
      export type RigEvent = | { type: "queue.claimed"; qitemId: string; destinationSession: string } | { type: "rig.deleted"; rigId: string };`;
    const f = extractNodeFields(src);
    expect(f.node).toEqual(["activityState", "heldReason", "nodeId"]);
    expect(f.activityState).toEqual(["activity", "needsInput"]);
    expect(f.needsInput).toEqual(["count", "reason"]);
    expect(f.agentActivity).toEqual(["reason", "state"]);
    expect(extractEventFields(src)).toEqual({ "queue.claimed": ["destinationSession", "qitemId"], "rig.deleted": ["rigId"] });
  });
  it("reads Hono registrations and ignores context getters", () => {
    expect(extractRoutes(`app.get("/a", h); r.post("/b/:id", h); c.get("db" as never);`)).toEqual(["app GET /a", "r POST /b/:id"]);
  });
  it("keeps the router variable: the same method and path on two routers stay distinct", () => {
    expect(extractRoutes(`nodes.get("/", h); sessions.get("/", h);`)).toEqual(["nodes GET /", "sessions GET /"]);
  });
  it("ignores line and block comments", () => {
    const src = `// app.get("/gone", h)\n/* app.get("/also-gone", h); */\napp.get("/kept", h);`;
    expect(extractRoutes(src)).toEqual(["app GET /kept"]);
    expect(extractMounts(`// app.route("/api/x", r)\napp.route("/api/y", r);`)).toEqual(["/api/y"]);
    expect(hasToken(`// "Last-Event-ID"\nconst a = 1;`, "Last-Event-ID")).toBe(false);
    expect(hasToken(`c.req.header("Last-Event-ID");`, "Last-Event-ID")).toBe(true);
  });
  it("ignores a commented-out status entry and RigEvent variant", () => {
    expect(extractStatusMap(`const statusMap = {\n a: 409,\n // b: 404,\n };`)).toEqual({ a: 409 });
    expect(extractRigEventTypes(`type RigEvent =\n | { type: "a.b" }\n // | { type: "c.d" }\n;`)).toEqual(["a.b"]);
  });
  it("reads a status map", () => {
    expect(extractStatusMap(`const statusMap: Record<string, number> = {\n a_b: 409,\n c: 404,\n};`)).toEqual({ a_b: 409, c: 404 });
  });
  it("reads the send request body type and the SendResult members, ignoring comments", () => {
    const req = `const f = async (c) => { const body = await c.req.json<{ session?: string; deliveryId?: string; /* verify?: boolean */ text: string; extra?: 1 }>(); };`;
    expect(extractSendRequestFields(req)).toEqual(["deliveryId", "session", "text"]);
    const res = `export interface SendResult { ok: boolean; sessionName: string; // reason?: string
      inputPhase?: "not_reached" | "attempted" | "written"; sent?: boolean; }`;
    expect(extractSendResult(res)).toEqual({ fields: ["inputPhase", "ok", "sent", "sessionName"], inputPhases: ["attempted", "not_reached", "written"] });
  });
  it("reads an outcome union", () => {
    expect(extractOutcomes(`interface R { outcome?: "delivered" | "y-z"; }`)).toEqual(["delivered", "y-z"]);
  });
  it("reads single and multi-line RigEvent variants, including unions of names", () => {
    const src = `export type RigEvent =\n  | { type: "a.b"; x: 1 }\n  | { type: "c.d" | "e.f"; y: 2 }\n  | {\n      type: "g.h";\n      z: 3;\n    };\nexport type PersistedEvent = RigEvent;`;
    expect(extractRigEventTypes(src)).toEqual(["a.b", "c.d", "e.f", "g.h"]);
  });
});

// Mutations of the real OpenRig sources, in memory: each must be reported as a removal.
describe.skipIf(!available)("mutations of the checkout sources are detected", () => {
  it("renaming deliveryId in the send body type or dropping an inputPhase value is detected", () => {
    const t = "packages/daemon/src/routes/transport.ts";
    const sendReader = (rel: string) => {
      const text = readFileSync(resolve(root, rel), "utf8");
      return rel === t ? text.replace("deliveryId?: string;", "deliveryKey?: string;") : text;
    };
    // the body type no longer declares deliveryId, so it cannot be found at all
    expect(() => extractSurfaces(root, sendReader)).toThrow(/send request body type not found/);
    const s = "packages/daemon/src/domain/session-transport.ts";
    const reader = (rel: string) => {
      const text = readFileSync(resolve(root, rel), "utf8");
      return rel === s ? text.replace('inputPhase?: "not_reached" | "attempted" | "written";', 'inputPhase?: "attempted" | "written";') : text;
    };
    expect(diffRemovals(snapshot, extractSurfaces(root, reader))).toContain("transport input phase removed: not_reached");
  });

  const mutate = (file: string, from: string | RegExp, to: string) => {
    const reader = (rel: string) => {
      const text = readFileSync(resolve(root, rel), "utf8");
      if (rel !== file) return text;
      const out = text.replace(from, to);
      expect(out, `mutation did not apply to ${file}`).not.toBe(text);
      return out;
    };
    return diffRemovals(snapshot, extractSurfaces(root, reader));
  };

  it("detects terminal route and scroll contract removal", () => {
    const path = "packages/daemon/src/routes/terminal-ws.ts";
    expect(mutate(path, /"\/api\/terminal\/:sessionName"/g, '"/api/terminal-renamed/:sessionName"')).toContain("route removed in terminal: app GET /api/terminal/:sessionName");
    expect(mutate(path, 'msg.type === "scroll"', 'msg.type === "history"')).toContain("terminal frame type removed: scroll");
    expect(mutate(path, /msg\.offset/g, "msg.lineOffset")).toContain("terminal scroll field removed: offset");
    expect(mutate(path, 'msg.type === "keys"', 'msg.type === "key-input"')).toContain("terminal frame type removed: keys");
    expect(mutate(path, 'msg.type === "text"', 'msg.type === "paste"')).toContain("terminal frame type removed: text");
  });

  it("detects UI gate and configuration response changes", () => {
    expect(mutate("packages/daemon/src/server.ts", "deps.enableNodeWebSocket && deps.webUiEnabled === true", "deps.enableNodeWebSocket")).toContain("terminal UI gate removed");
    expect(mutate("packages/daemon/src/routes/config.ts", 'router.get("/:key",', 'router.get("/changed/:key",')).toContain("route removed in config: router GET /:key");
    expect(mutate("packages/daemon/src/routes/config.ts", "c.json(store.resolveOne(key))", "c.json({ enabled: true })")).toContain("terminal config resolver changed");
    expect(mutate("packages/daemon/src/domain/user-settings/settings-store.ts", /"ui.enabled"/g, '"ui.available"')).toContain("terminal ui.enabled setting removed");
    expect(mutate("packages/daemon/src/domain/user-settings/settings-store.ts", "export interface ResolvedSetting {\n  value:", "export interface ResolvedSetting {\n  settingValue:")).toContain("terminal config field removed: value");
  });

  it("commenting out the events mount fails", () => {
    const problems = mutate("packages/daemon/src/server.ts", 'app.route("/api/events", eventsRoute);', '// app.route("/api/events", eventsRoute);');
    expect(problems).toContain("mount removed: /api/events");
  });

  it("renaming the sessions GET / on the nodes router fails although the sessions router also has GET /", () => {
    const problems = mutate("packages/daemon/src/routes/sessions.ts", 'nodesRoutes.get("/", ', 'nodesRoutes.get("/all", ');
    expect(problems).toContain("route removed in sessions: nodesRoutes GET /");
  });

  it("removing a failure reason fails", () => {
    const problems = mutate("packages/daemon/src/routes/transport.ts", /^\s*session_missing: 404,\n/m, "");
    expect(problems).toContain("transport failure reason removed: session_missing");
  });

  it("renaming a node field or an event field in the daemon types fails", () => {
    const types = "packages/daemon/src/domain/types.ts";
    expect(mutate(types, "  heldReason?: string | null;", "  heldReasonX?: string | null;")).toContain("node field removed (node): heldReason");
    expect(mutate(types, "needsInput: { count: number; reason: string | null };", "needsInput: { total: number; reason: string | null };")).toContain("node field removed (needsInput): count");
    expect(mutate(types, 'type: "queue.handed_off"; qitemId: string; fromSession: string;', 'type: "queue.handed_off"; qitemId: string; from: string;')).toContain("RigEvent field removed (queue.handed_off): fromSession");
    expect(mutate(types, '{ type: "queue.claimed";', '{ type: "queue.taken";')).toContain("RigEvent variant removed: queue.claimed");
  });

  it("commenting out a route registration fails", () => {
    const problems = mutate("packages/daemon/src/routes/queue.ts", 'app.get("/open-human-updates"', '// app.get("/open-human-updates"');
    expect(problems.some((p) => p.includes("GET /open-human-updates"))).toBe(true);
  });
});
