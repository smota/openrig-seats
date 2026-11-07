import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** Route files the gateway depends on, relative to the OpenRig checkout. */
const SRC = "packages/daemon/src";
const ROUTE_FILES = {
  events: `${SRC}/routes/events.ts`,
  attention: `${SRC}/routes/attention.ts`,
  ps: `${SRC}/routes/ps.ts`,
  rigs: `${SRC}/routes/rigs.ts`,
  sessions: `${SRC}/routes/sessions.ts`,
  queue: `${SRC}/routes/queue.ts`,
  transport: `${SRC}/routes/transport.ts`,
  senderIdentity: `${SRC}/routes/require-sender-identity.ts`,
  config: `${SRC}/routes/config.ts`,
  terminal: `${SRC}/routes/terminal-ws.ts`,
} as const;

/**
 * Routes the gateway calls: file key, the Hono router variable they are registered on, method and
 * path. The router is part of the identity: sessions.ts registers `GET /` on both the nodes and the
 * sessions router, and only the nodes one is used.
 */
export const REQUIRED_ROUTES: ReadonlyArray<{ file: keyof typeof ROUTE_FILES; router: string; method: string; path: string }> = [
  { file: "config", router: "router", method: "get", path: "/:key" },
  { file: "terminal", router: "app", method: "get", path: "/api/terminal/:sessionName" },
  { file: "events", router: "eventsRoute", method: "get", path: "/" },
  { file: "attention", router: "app", method: "get", path: "/" },
  { file: "ps", router: "psRoutes", method: "get", path: "/" },
  { file: "rigs", router: "rigsRoutes", method: "get", path: "/" },
  { file: "rigs", router: "rigsRoutes", method: "get", path: "/:id" },
  { file: "sessions", router: "nodesRoutes", method: "get", path: "/" },
  { file: "sessions", router: "sessionAdminRoutes", method: "get", path: "/:sessionName/generation-record" },
  { file: "queue", router: "app", method: "get", path: "/list" },
  { file: "queue", router: "app", method: "get", path: "/open-human-updates" },
  { file: "transport", router: "router", method: "post", path: "/send" },
];

/** Daemon mounts in server.ts (`app.route(prefix, ...)`) the gateway depends on. */
export const REQUIRED_MOUNTS: readonly string[] = [
  "/api/events",
  "/api/attention",
  "/api/ps",
  "/api/rigs",
  "/api/rigs/:rigId/nodes",
  "/api/rigs/:rigId/sessions",
  "/api/sessions",
  "/api/queue",
  "/api/transport",
  "/api/config",
];

/** Names that must keep appearing in the code (string literals and identifiers, never comments) of a route file. */
export const REQUIRED_TOKENS: ReadonlyArray<{ file: keyof typeof ROUTE_FILES; token: string; why: string }> = [
  { file: "terminal", token: "Authorization", why: "terminal bearer header" },
  { file: "terminal", token: "keys", why: "input frame type that the gateway must drop" },
  { file: "terminal", token: "text", why: "input frame type that the gateway must drop" },
  { file: "terminal", token: "scroll", why: "read-only terminal scroll frame" },
  { file: "terminal", token: "offset", why: "terminal scroll offset field" },
  { file: "events", token: "Last-Event-ID", why: "SSE resume header" },
  { file: "events", token: "replay", why: "bounded replay (replay=0)" },
  { file: "events", token: "rigId", why: "rig-scoped stream" },
  { file: "sessions", token: "sinceBytes", why: "generation-record byte cursor" },
  { file: "transport", token: "deliveryId", why: "send idempotency key" },
  { file: "senderIdentity", token: "x-openrig-session", why: "sender header of transport/send (an unverified claim: the gateway sends a fixed principal)" },
];

/** Fields of the `POST /api/transport/send` body the gateway's send action sends. */
export const REQUIRED_SEND_REQUEST_FIELDS: readonly string[] = ["session", "text", "deliveryId", "verify"];

/** Members of the send result (`SendResult`) the gateway reads to map an outcome to an act response. */
export const REQUIRED_SEND_RESULT_FIELDS: readonly string[] = ["ok", "sessionName", "outcome", "reason", "sent", "inputPhase", "verified"];

/** `inputPhase` values: only `not_reached` establishes that nothing was typed. */
export const REQUIRED_INPUT_PHASES: readonly string[] = ["attempted", "not_reached", "written"];

/**
 * Daemon node fields (`NodeInventoryEntry` in domain/types.ts, served by /api/rigs/:id/nodes) that the
 * source and the `x-openrig` seat extension read, with the nested `activityState`, `needsInput` and
 * `agentActivity` members. A rename upstream removes the name and fails the diff.
 */
export const REQUIRED_NODE_FIELDS: Readonly<Record<NodeFieldGroup, readonly string[]>> = {
  node: [
    "nodeId", "rigId", "rigName", "logicalId", "canonicalSessionName", "nodeKind", "runtime", "podNamespace", "sessionStatus",
    "intentionallyStopped", "startupStatus", "lifecycleState", "latestError", "needsAttention", "arbitratedNeedsInput", "agentActivity",
    "activityState", "lastActivityAt", "pendingWorkCount", "inProgressWorkCount", "heldReason",
  ],
  activityState: ["activity", "display", "needsInput"],
  needsInput: ["count", "reason"],
  agentActivity: ["state", "reason"],
};

/** Fields of the RigEvent variants the source maps to `x-openrig.event` (and uses for resync decisions). */
export const REQUIRED_EVENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "queue.created": ["qitemId", "sourceSession", "destinationSession", "summary"],
  "queue.claimed": ["qitemId", "destinationSession", "summary"],
  "queue.handed_off": ["qitemId", "fromSession", "toSession", "summary"],
  "queue.updated": ["qitemId", "fromState", "toState", "closureReason", "actorSession", "summary"],
  "agent.activity": ["rigId", "nodeId", "sessionName", "activity"],
  "node.removed": ["rigId", "nodeId"],
  "rig.deleted": ["rigId"],
};

export type NodeFieldGroup = "node" | "activityState" | "needsInput" | "agentActivity";

export interface TerminalContract {
  frameTypes: string[];
  scrollFields: string[];
  uiGate: boolean;
  configResolveOne: boolean;
  configFields: string[];
  uiSetting: boolean;
}

export interface OpenRigSurfaces {
  /** Terminal input discriminants, UI gating, and config response shape read by the gateway. */
  terminal?: TerminalContract;
  /** Daemon mounts found in server.ts, as `app.route` / `app.get` prefixes. */
  mounts: string[];
  /** Every `<router>.<METHOD> <path>` registration in each required route file, as `router METHOD path`. */
  routes: Record<string, string[]>;
  /** Required tokens present per file. */
  tokens: Record<string, string[]>;
  transport: {
    /** `outcome?:` union on the send result. */
    outcomes: string[];
    /** Failure reason to HTTP status, from the `statusMap` in routes/transport.ts. */
    failureStatus: Record<string, number>;
    /** Required members of the `POST /send` request body type (see REQUIRED_SEND_REQUEST_FIELDS), sorted. */
    sendRequestFields: string[];
    /** Required members of `SendResult` (see REQUIRED_SEND_RESULT_FIELDS), sorted. */
    sendResultFields: string[];
    /** `inputPhase?:` union of `SendResult`, sorted. */
    inputPhases: string[];
  };
  /** `RigEvent` discriminant names (`type: "..."`), sorted. */
  rigEventTypes: string[];
  /** Required daemon node fields found per group (see REQUIRED_NODE_FIELDS), sorted. */
  nodeFields: Record<NodeFieldGroup, string[]>;
  /** Required fields found per RigEvent variant (see REQUIRED_EVENT_FIELDS), sorted. */
  eventFields: Record<string, string[]>;
}

/** Reads a file of the checkout; replaceable so tests can mutate real sources in memory. */
export type ReadSource = (rel: string) => string;

function sorted<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort();
}

/** Parsed with the TypeScript compiler, so comments never count. */
function parse(source: string): ts.SourceFile {
  return ts.createSourceFile("x.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (c) => walk(c, visit));
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function stringArg(call: ts.CallExpression): string | null {
  const a = call.arguments[0];
  return a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) ? a.text : null;
}

/** `router.method("/path", ...)` calls: [router variable, method, path]. */
function routerCalls(source: string, methods: ReadonlySet<string>): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  walk(parse(source), (n) => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
    let target: ts.Expression = n.expression.expression;
    while (ts.isParenthesizedExpression(target) || ts.isAsExpression(target) || ts.isTypeAssertionExpression(target)) target = target.expression;
    const method = n.expression.name.text;
    const path = stringArg(n);
    if (!ts.isIdentifier(target) || !methods.has(method) || path === null || !path.startsWith("/")) return;
    out.push([target.text, method, path]);
  });
  return out;
}

export function extractMounts(serverSource: string): string[] {
  return sorted(
    routerCalls(serverSource, new Set(["route", ...HTTP_METHODS]))
      .filter(([router, , path]) => router === "app" && path.startsWith("/api/"))
      .map(([, , path]) => path),
  );
}

export function extractRoutes(source: string): string[] {
  return sorted(routerCalls(source, HTTP_METHODS).map(([router, method, path]) => `${router} ${method.toUpperCase()} ${path}`));
}

/** True when `token` is a string literal or identifier somewhere in the code (comments excluded). */
export function hasToken(source: string, token: string): boolean {
  let found = false;
  walk(parse(source), (n) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === token) found = true;
    if (ts.isIdentifier(n) && n.text === token) found = true;
  });
  return found;
}

export function extractStatusMap(transportSource: string): Record<string, number> {
  let map: Record<string, number> | null = null;
  walk(parse(transportSource), (n) => {
    if (map || !ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.name.text !== "statusMap") return; // the send handler's map is the first
    if (!n.initializer || !ts.isObjectLiteralExpression(n.initializer)) return;
    map = {};
    for (const p of n.initializer.properties) {
      if (ts.isPropertyAssignment(p) && ts.isNumericLiteral(p.initializer) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
        map[p.name.text] = Number(p.initializer.text);
      }
    }
  });
  if (!map || Object.keys(map).length === 0) throw new Error("transport.ts: statusMap not found or empty");
  return Object.fromEntries(Object.entries(map as Record<string, number>).sort(([a], [b]) => a.localeCompare(b)));
}

function literalNames(t: ts.TypeNode): string[] {
  if (ts.isUnionTypeNode(t)) return t.types.flatMap(literalNames);
  if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) return [t.literal.text];
  return [];
}

export function extractOutcomes(sessionTransportSource: string): string[] {
  let names: string[] = [];
  walk(parse(sessionTransportSource), (n) => {
    if (ts.isPropertySignature(n) && ts.isIdentifier(n.name) && n.name.text === "outcome" && n.type) {
      const l = literalNames(n.type);
      if (l.includes("delivered") && l.length > names.length) names = l;
    }
  });
  if (names.length === 0) throw new Error("session-transport.ts: SendResult outcome union not found");
  return sorted(names);
}

/** Members of the body type of `c.req.json<{...}>()` in the send handler (the literal that declares `deliveryId`), filtered to the required ones. */
export function extractSendRequestFields(transportSource: string): string[] {
  let names: string[] | null = null;
  walk(parse(transportSource), (n) => {
    if (names || !ts.isCallExpression(n) || !n.typeArguments?.length) return;
    const t = n.typeArguments[0]!;
    if (!ts.isTypeLiteralNode(t)) return;
    const members = memberNames(t.members);
    if (members.includes("deliveryId")) names = members;
  });
  if (!names) throw new Error("transport.ts: send request body type not found");
  return sorted(REQUIRED_SEND_REQUEST_FIELDS.filter((f) => (names as string[]).includes(f)));
}

/** Required members of the `SendResult` interface and the values of its `inputPhase` union. */
export function extractSendResult(sessionTransportSource: string): { fields: string[]; inputPhases: string[] } {
  let out: { fields: string[]; inputPhases: string[] } | null = null;
  walk(parse(sessionTransportSource), (n) => {
    if (out || !ts.isInterfaceDeclaration(n) || n.name.text !== "SendResult") return;
    const phase = n.members.find((m): m is ts.PropertySignature => ts.isPropertySignature(m) && ts.isIdentifier(m.name) && m.name.text === "inputPhase");
    out = {
      fields: sorted(REQUIRED_SEND_RESULT_FIELDS.filter((f) => memberNames(n.members).includes(f))),
      inputPhases: phase?.type ? sorted(literalNames(phase.type)) : [],
    };
  });
  if (!out) throw new Error("session-transport.ts: SendResult interface not found");
  return out;
}

export function extractRigEventTypes(typesSource: string): string[] {
  const names: string[] = [];
  walk(parse(typesSource), (n) => {
    if (!ts.isTypeAliasDeclaration(n) || n.name.text !== "RigEvent") return;
    const members = ts.isUnionTypeNode(n.type) ? n.type.types : [n.type];
    for (const m of members) {
      if (!ts.isTypeLiteralNode(m)) continue;
      for (const p of m.members) {
        if (ts.isPropertySignature(p) && ts.isIdentifier(p.name) && p.name.text === "type" && p.type) names.push(...literalNames(p.type));
      }
    }
  });
  if (names.length === 0) throw new Error("domain/types.ts: no RigEvent variants found");
  return sorted(names);
}

function memberNames(members: ts.NodeArray<ts.TypeElement>): string[] {
  return members.flatMap((m) => (ts.isPropertySignature(m) && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? [m.name.text] : []));
}

function literalMembers(t: ts.TypeNode | undefined, prop: string): ts.TypeNode | undefined {
  // `T | null` and parenthesised forms: look through to the type literal.
  if (!t) return undefined;
  if (ts.isUnionTypeNode(t)) return t.types.map((x) => literalMembers(x, prop)).find(Boolean) ?? t.types.find(ts.isTypeLiteralNode);
  if (ts.isParenthesizedTypeNode(t)) return literalMembers(t.type, prop);
  return t;
}

/** Property names of `NodeInventoryEntry`, of its `activityState` and `activityState.needsInput` literals, and of `AgentActivity`. */
export function extractNodeFields(typesSource: string): Record<NodeFieldGroup, string[]> {
  const out: Record<NodeFieldGroup, string[]> = { node: [], activityState: [], needsInput: [], agentActivity: [] };
  let found = false;
  walk(parse(typesSource), (n) => {
    if (!ts.isInterfaceDeclaration(n)) return;
    if (n.name.text === "AgentActivity") out.agentActivity = memberNames(n.members);
    if (n.name.text !== "NodeInventoryEntry") return;
    found = true;
    out.node = memberNames(n.members);
    const activity = n.members.find((m): m is ts.PropertySignature => ts.isPropertySignature(m) && ts.isIdentifier(m.name) && m.name.text === "activityState");
    const lit = literalMembers(activity?.type, "activityState");
    if (lit && ts.isTypeLiteralNode(lit)) {
      out.activityState = memberNames(lit.members);
      const needs = lit.members.find((m): m is ts.PropertySignature => ts.isPropertySignature(m) && ts.isIdentifier(m.name) && m.name.text === "needsInput");
      if (needs?.type && ts.isTypeLiteralNode(needs.type)) out.needsInput = memberNames(needs.type.members);
    }
  });
  if (!found) throw new Error("domain/types.ts: NodeInventoryEntry not found");
  const pick = (g: NodeFieldGroup) => sorted(REQUIRED_NODE_FIELDS[g].filter((f) => out[g].includes(f)));
  return { node: pick("node"), activityState: pick("activityState"), needsInput: pick("needsInput"), agentActivity: pick("agentActivity") };
}

/** For each RigEvent variant in `names`, which of `fields` its type literal declares. */
export function extractEventFields(typesSource: string, wanted: Readonly<Record<string, readonly string[]>> = REQUIRED_EVENT_FIELDS): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  walk(parse(typesSource), (n) => {
    if (!ts.isTypeAliasDeclaration(n) || n.name.text !== "RigEvent") return;
    const members = ts.isUnionTypeNode(n.type) ? n.type.types : [n.type];
    for (const m of members) {
      if (!ts.isTypeLiteralNode(m)) continue;
      const names = m.members.flatMap((p) => (ts.isPropertySignature(p) && ts.isIdentifier(p.name) && p.name.text === "type" && p.type ? literalNames(p.type) : []));
      const props = memberNames(m.members);
      for (const name of names) if (wanted[name]) out[name] = sorted(wanted[name]!.filter((f) => props.includes(f)));
    }
  });
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

export function openrigCommit(root: string): string | null {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Extract terminal contracts from syntax rather than comments or unrelated mentions. */
export function extractTerminalContract(terminalSource: string, serverSource: string, configSource: string, settingsSource: string): TerminalContract {
  const frameTypes: string[] = [];
  const scrollFields: string[] = [];
  walk(parse(terminalSource), (n) => {
    if (!ts.isIfStatement(n)) return;
    let frame: string | undefined;
    walk(n.expression, (condition) => {
      if (ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        && ts.isPropertyAccessExpression(condition.left) && condition.left.expression.getText() === "msg"
        && condition.left.name.text === "type" && ts.isStringLiteral(condition.right)) frame = condition.right.text;
    });
    if (!frame) return;
    frameTypes.push(frame);
    if (frame === "scroll") walk(n.expression, (condition) => {
      if (ts.isPropertyAccessExpression(condition) && condition.expression.getText() === "msg" && condition.name.text !== "type") scrollFields.push(condition.name.text);
    });
  });
  let uiGate = false;
  walk(parse(serverSource), (n) => {
    if (!ts.isIfStatement(n)) return;
    let registration = false;
    walk(n.thenStatement, (child) => {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === "registerTerminalWs") registration = true;
    });
    if (!registration || !ts.isBinaryExpression(n.expression) || n.expression.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) return;
    const condition = n.expression.right;
    if (n.expression.left.getText() === "deps.enableNodeWebSocket" && ts.isBinaryExpression(condition)
      && condition.left.getText() === "deps.webUiEnabled" && condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      && condition.right.kind === ts.SyntaxKind.TrueKeyword) uiGate = true;
  });
  let configResolveOne = false;
  walk(parse(configSource), (n) => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== "json") return;
    const arg = n.arguments[0];
    if (arg && ts.isCallExpression(arg) && ts.isPropertyAccessExpression(arg.expression)
      && arg.expression.expression.getText() === "store" && arg.expression.name.text === "resolveOne"
      && arg.arguments[0]?.getText() === "key") configResolveOne = true;
  });
  let configFields: string[] = [];
  walk(parse(settingsSource), (n) => {
    if (ts.isInterfaceDeclaration(n) && n.name.text === "ResolvedSetting") configFields = memberNames(n.members).filter((f) => f === "value");
  });
  return { frameTypes: sorted(frameTypes), scrollFields: sorted(scrollFields), uiGate, configResolveOne, configFields, uiSetting: hasToken(settingsSource, "ui.enabled") };
}

export function extractSurfaces(root: string, read: ReadSource = (rel) => readFileSync(join(root, rel), "utf8")): OpenRigSurfaces {
  const routes: Record<string, string[]> = {};
  const tokens: Record<string, string[]> = {};
  for (const [key, rel] of Object.entries(ROUTE_FILES)) {
    const source = read(rel);
    routes[key] = extractRoutes(source);
    tokens[key] = REQUIRED_TOKENS.filter((t) => t.file === key && hasToken(source, t.token)).map((t) => t.token).sort();
  }
  const sendResult = extractSendResult(read(`${SRC}/domain/session-transport.ts`));
  return {
    terminal: extractTerminalContract(read(ROUTE_FILES.terminal), read(`${SRC}/server.ts`), read(ROUTE_FILES.config), read(`${SRC}/domain/user-settings/settings-store.ts`)),
    mounts: extractMounts(read(`${SRC}/server.ts`)).filter((m) => REQUIRED_MOUNTS.includes(m)),
    routes,
    tokens,
    transport: {
      outcomes: extractOutcomes(read(`${SRC}/domain/session-transport.ts`)),
      failureStatus: extractStatusMap(read(ROUTE_FILES.transport)),
      sendRequestFields: extractSendRequestFields(read(ROUTE_FILES.transport)),
      sendResultFields: sendResult.fields,
      inputPhases: sendResult.inputPhases,
    },
    rigEventTypes: extractRigEventTypes(read(`${SRC}/domain/types.ts`)),
    nodeFields: extractNodeFields(read(`${SRC}/domain/types.ts`)),
    eventFields: extractEventFields(read(`${SRC}/domain/types.ts`)),
  };
}

export interface Snapshot {
  schema: "openrig-seats.conformance-snapshot/v1";
  openrigCommit: string | null;
  surfaces: OpenRigSurfaces;
  /** Routes, mounts and tokens the gateway depends on (checked for removal, not for addition). */
  required: {
    routes: Array<{ file: string; router: string; method: string; path: string }>;
    mounts: string[];
    tokens: Array<{ file: string; token: string; why: string }>;
  };
}

export function buildSnapshot(root: string, read?: ReadSource): Snapshot {
  return {
    schema: "openrig-seats.conformance-snapshot/v1",
    openrigCommit: openrigCommit(root),
    surfaces: extractSurfaces(root, read),
    required: {
      routes: REQUIRED_ROUTES.map((r) => ({ ...r })),
      mounts: [...REQUIRED_MOUNTS],
      tokens: REQUIRED_TOKENS.map((t) => ({ ...t })),
    },
  };
}

/**
 * Everything in `snapshot` that is missing or changed in `current`. Additions in `current` are
 * allowed; removals, renames and changed status codes are reported.
 */
export function diffRemovals(snapshot: Snapshot, current: OpenRigSurfaces): string[] {
  const problems: string[] = [];
  const s = snapshot.surfaces;
  if (s.terminal) {
    for (const f of s.terminal.frameTypes) if (!current.terminal?.frameTypes.includes(f)) problems.push(`terminal frame type removed: ${f}`);
    for (const f of s.terminal.scrollFields) if (!current.terminal?.scrollFields.includes(f)) problems.push(`terminal scroll field removed: ${f}`);
    for (const f of s.terminal.configFields) if (!current.terminal?.configFields.includes(f)) problems.push(`terminal config field removed: ${f}`);
    if (s.terminal.uiGate && !current.terminal?.uiGate) problems.push("terminal UI gate removed");
    if (s.terminal.configResolveOne && !current.terminal?.configResolveOne) problems.push("terminal config resolver changed");
    if (s.terminal.uiSetting && !current.terminal?.uiSetting) problems.push("terminal ui.enabled setting removed");
  }
  for (const m of s.mounts) if (!current.mounts.includes(m)) problems.push(`mount removed: ${m}`);
  for (const [file, list] of Object.entries(s.routes)) {
    for (const r of list) if (!(current.routes[file] ?? []).includes(r)) problems.push(`route removed in ${file}: ${r}`);
  }
  for (const [file, list] of Object.entries(s.tokens)) {
    for (const t of list) if (!(current.tokens[file] ?? []).includes(t)) problems.push(`token removed in ${file}: ${t}`);
  }
  for (const o of s.transport.outcomes) if (!current.transport.outcomes.includes(o)) problems.push(`transport outcome removed: ${o}`);
  for (const f of s.transport.sendRequestFields ?? []) if (!(current.transport.sendRequestFields ?? []).includes(f)) problems.push(`transport send request field removed: ${f}`);
  for (const f of s.transport.sendResultFields ?? []) if (!(current.transport.sendResultFields ?? []).includes(f)) problems.push(`transport send result field removed: ${f}`);
  for (const f of s.transport.inputPhases ?? []) if (!(current.transport.inputPhases ?? []).includes(f)) problems.push(`transport input phase removed: ${f}`);
  for (const [reason, status] of Object.entries(s.transport.failureStatus)) {
    const now = current.transport.failureStatus[reason];
    if (now === undefined) problems.push(`transport failure reason removed: ${reason}`);
    else if (now !== status) problems.push(`transport failure status changed: ${reason} ${status} -> ${now}`);
  }
  for (const t of s.rigEventTypes) if (!current.rigEventTypes.includes(t)) problems.push(`RigEvent variant removed: ${t}`);
  for (const [group, list] of Object.entries(s.nodeFields ?? {})) {
    for (const f of list) if (!(current.nodeFields?.[group as NodeFieldGroup] ?? []).includes(f)) problems.push(`node field removed (${group}): ${f}`);
  }
  for (const [event, list] of Object.entries(s.eventFields ?? {})) {
    for (const f of list) if (!(current.eventFields?.[event] ?? []).includes(f)) problems.push(`RigEvent field removed (${event}): ${f}`);
  }
  return problems;
}
