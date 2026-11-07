import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_MOUNTS,
  REQUIRED_ROUTES,
  REQUIRED_TOKENS,
  buildSnapshot,
  diffRemovals,
  extractOutcomes,
  extractRigEventTypes,
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
    expect(s.transport.failureStatus.session_missing).toBe(404);
    expect(s.transport.failureStatus.tmux_unavailable).toBe(503);
    for (const v of ["agent.activity", "rig.created", "seat.model_divergence"]) expect(s.rigEventTypes).toContain(v);
  });
});

describe("OpenRig checkout", () => {
  it("OPENRIG_CHECKOUT is set to a checkout", () => {
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

  it("allows additions", () => {
    const cur = structuredClone(base);
    cur.rigEventTypes.push("new.event");
    cur.transport.failureStatus.brand_new = 409;
    cur.routes.queue!.push("app GET /extra");
    expect(diffRemovals(snapshot, cur)).toEqual([]);
  });
});

describe("extractors", () => {
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

  it("commenting out a route registration fails", () => {
    const problems = mutate("packages/daemon/src/routes/queue.ts", 'app.get("/open-human-updates"', '// app.get("/open-human-updates"');
    expect(problems.some((p) => p.includes("GET /open-human-updates"))).toBe(true);
  });
});
