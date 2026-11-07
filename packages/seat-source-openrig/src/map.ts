import type { Json } from "./types.js";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const rec = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});

/** A valid RFC 3339 timestamp or undefined. */
export function isoOrUndefined(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

export function mapRig(ps: unknown, hostId: string): Json | null {
  const e = rec(ps);
  const id = str(e.rigId);
  if (!id) return null;
  const status = str(e.status);
  return {
    id,
    hostId,
    name: str(e.name) ?? str(e.rigName) ?? id,
    state: status === "running" || status === "partial" || status === "stopped" ? status : "unknown",
    ...(Number.isInteger(e.nodeCount) && (e.nodeCount as number) >= 0 ? { seatCount: e.nodeCount } : {}),
    ...(Number.isInteger(e.attentionCount) ? { attentionCount: e.attentionCount } : {}),
  };
}

export function seatState(n: Json): "active" | "idle" | "needs-input" | "blocked" | "stopped" | "unknown" {
  const life = str(n.lifecycleState);
  if (life === "detached" || life === "recoverable") return "stopped";
  if (life === "attention_required") return "blocked";
  const activity = str(rec(n.agentActivity).state);
  if (n.arbitratedNeedsInput === true || activity === "needs_input") return "needs-input";
  if (activity === "running") return "active";
  if (activity === "idle") return "idle";
  return "unknown";
}

/** Occupant generation lives only in modelObservation.generation on the nodes route. */
export function generationOf(n: Json): string | undefined {
  const g = rec(n.modelObservation).generation;
  if (typeof g === "string" && g) return g;
  if (typeof g === "number" && Number.isFinite(g)) return String(g);
  return undefined;
}

/** Version of the `x-openrig` extension this source emits (matches seat-protocol's OPENRIG_EXTENSION_VERSION). */
export const X_OPENRIG_VERSION = "1.0";
export const HELD_MAX = 300;
export const EVENT_SUMMARY_MAX = 140;

/**
 * Untrusted daemon text made safe to carry: control characters and runs of whitespace become one space,
 * the result is at most `max` characters, empty becomes undefined. Not a redaction: consumers decide that.
 */
export function shortText(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const flat = v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length <= max ? flat : flat.slice(0, max);
}

const HELD_CODES = new Set(["excluded_from_subset"]);
const LAUNCH_UNCONFIRMED = "Harness launch requires attention";

/** The raw latestError text (a string, or an object's `message`/`error`), or undefined. Only used when text is opted in. */
function errorText(n: Json): string | undefined {
  const e = n.latestError;
  if (typeof e === "string") return shortText(e, HELD_MAX);
  const o = rec(e);
  return shortText(o.message, HELD_MAX) ?? shortText(o.error, HELD_MAX);
}

/** Category from known statuses and known daemon prefixes only; any other error is "unknown". Never reflects daemon text. */
function errorCategory(n: Json): "startup_failed" | "launch_unconfirmed" | "unknown" | undefined {
  const raw = typeof n.latestError === "string" ? n.latestError : (rec(n.latestError).message ?? rec(n.latestError).error);
  const has = typeof raw === "string" ? raw.trim() !== "" : n.latestError !== null && n.latestError !== undefined && typeof n.latestError === "object";
  if (typeof raw === "string" && raw.trim().startsWith(LAUNCH_UNCONFIRMED)) return "launch_unconfirmed";
  if (n.startupStatus === "failed") return "startup_failed";
  if (n.startupStatus === "attention_required" && !has) return "launch_unconfirmed";
  return has ? "unknown" : undefined;
}

/** Allowlisted prompt kind from the daemon's needs-input reason. */
export function promptKind(reason: unknown): "permission_prompt" | "selection_prompt" | "other" {
  const r = typeof reason === "string" ? reason.toLowerCase() : "";
  if (/^selection[ _]prompt$/.test(r)) return "selection_prompt";
  if (/^permission[ _]prompt$/.test(r)) return "permission_prompt";
  return "other";
}

const STARTUP = new Set(["pending", "ready", "attention_required", "failed"]);
const count = (v: unknown): number | undefined => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : undefined);

/**
 * The `x-openrig` seat extension: daemon node fields beyond the core seat. By default only structured values
 * (booleans, counts, allowlisted codes and categories). With `includeText` the daemon's own free text (held
 * reason, error text, prompt reason or summary) is added, bounded and on one line: it is sensitive and untrusted.
 * Never a message body, transcript content or the raw needs-input prompt.
 */
export function mapSeatExtension(n: Json, includeText = false): Json {
  const a = rec(n.activityState);
  const needs = rec(a.needsInput);
  const needsCount = count(needs.count);
  const waiting = n.arbitratedNeedsInput === true || (needsCount ?? 0) > 0;
  const heldRaw = shortText(n.heldReason, HELD_MAX);
  const category = errorCategory(n);
  const text = (v: unknown) => str(v);
  const out: Json = {
    version: X_OPENRIG_VERSION,
    ...(text(n.canonicalSessionName) ? { sessionName: n.canonicalSessionName } : {}),
    ...(text(n.rigName) ? { rigName: n.rigName } : {}),
    ...(text(n.podNamespace) ? { podNamespace: n.podNamespace } : {}),
    ...(text(n.sessionStatus) ? { sessionStatus: n.sessionStatus } : {}),
    ...(text(n.lifecycleState) ? { lifecycleState: n.lifecycleState } : {}),
    ...(STARTUP.has(String(n.startupStatus)) ? { startupStatus: n.startupStatus } : {}),
    ...(typeof n.intentionallyStopped === "boolean" ? { intentionallyStopped: n.intentionallyStopped } : {}),
    ...(typeof n.needsAttention === "boolean" ? { needsAttention: n.needsAttention } : {}),
    ...(typeof n.arbitratedNeedsInput === "boolean" ? { arbitratedNeedsInput: n.arbitratedNeedsInput } : {}),
    ...(text(a.activity) ? { activity: a.activity } : {}),
    ...(text(a.display) ? { display: a.display } : {}),
    ...(needsCount !== undefined ? { needsInputCount: needsCount } : {}),
    ...(waiting ? { promptKind: promptKind(needs.reason) } : {}),
    ...(heldRaw ? { held: true, heldReasonCode: HELD_CODES.has(heldRaw) ? heldRaw : "other" } : {}),
    ...(category ? { errorCategory: category } : {}),
    ...(count(n.pendingWorkCount) !== undefined ? { pendingWorkCount: n.pendingWorkCount } : {}),
    ...(count(n.inProgressWorkCount) !== undefined ? { inProgressWorkCount: n.inProgressWorkCount } : {}),
  };
  if (includeText) {
    if (heldRaw) out.heldReason = heldRaw;
    const err = errorText(n);
    if (err) out.lastError = err;
    const summary = waiting ? (shortText(needs.summary, HELD_MAX) ?? shortText(needs.reason, HELD_MAX)) : undefined;
    if (summary) out.promptSummary = summary;
  }
  return out;
}

export function mapSeat(node: unknown, attentionIds: string[], includeText = false, actions: Json[] = []): Json | null {
  const n = rec(node);
  if (n.nodeKind === "infrastructure") return null;
  const id = str(n.nodeId);
  const rigId = str(n.rigId);
  if (!id || !rigId) return null;
  const name = str(n.logicalId) ?? id;
  const state = seatState(n);
  // The daemon's activity reason is free text: only with the text opt-in.
  const activity = str(rec(n.activityState).display) ?? (includeText ? str(rec(n.agentActivity).reason) : undefined);
  const generationId = generationOf(n);
  return {
    id,
    rigId,
    name,
    title: name,
    ...(str(n.runtime) ? { harness: n.runtime } : {}),
    state,
    ...(activity ? { activity: activity.slice(0, 200) } : {}),
    ...(generationId ? { generationId } : {}),
    ...(attentionIds.length ? { attentionIds } : {}),
    ...(actions.length ? { actions } : {}),
    "x-openrig": mapSeatExtension(n, includeText),
  };
}

const SEVERITY: Record<string, "info" | "warning" | "critical"> = { routine: "info", urgent: "warning", critical: "critical" };

/**
 * Daemon free text (summary, unblocks) only with `includeText`; otherwise a fixed label from the kind and the id
 * and no impact.
 */
export function mapAttention(item: unknown, seatIdOf: (session: string | undefined) => string | undefined, includeText = false): Json | null {
  const i = rec(item);
  const id = str(i.id);
  if (!id) return null;
  const seatId = seatIdOf(str(i.asker));
  const label = `${i.kind === "update" ? "Update" : "Request"} for a person: ${id}`;
  const title = ((includeText ? str(i.summary) : undefined) ?? label).slice(0, 300);
  return {
    id,
    title,
    severity: SEVERITY[str(i.urgency) ?? ""] ?? "info",
    state: "open",
    reason: i.kind === "update" ? "An update addressed to a person is open" : "A request addressed to a person is open",
    ...(includeText && str(i.unblocks) ? { impact: str(i.unblocks)!.slice(0, 500) } : {}),
    ...(isoOrUndefined(i.at) ? { since: isoOrUndefined(i.at) } : {}),
    ...(seatId ? { seatId } : {}),
  };
}

const WORK_STATE: Record<string, string> = {
  pending: "pending",
  "in-progress": "in-progress",
  blocked: "blocked",
  done: "done",
  "handed-off": "done",
  failed: "failed",
  denied: "failed",
  canceled: "cancelled",
};

export function mapWork(row: unknown, seatIdOf: (session: string | undefined) => string | undefined, waitingOnHuman: boolean, includeText = false): Json | null {
  const r = rec(row);
  const id = str(r.qitemId);
  const state = WORK_STATE[str(r.state) ?? ""];
  if (!id || !state) return null;
  const assignee = seatIdOf(str(r.destinationSession));
  const creator = seatIdOf(str(r.sourceSession));
  return {
    id,
    // Never derived from the request body; the daemon's summary only with includeText, else a fixed label with the id.
    title: ((includeText ? str(r.summary) : undefined) ?? `Queue item ${id}`).slice(0, 300),
    state,
    ...(assignee ? { assigneeSeatId: assignee } : {}),
    ...(creator ? { creatorSeatId: creator } : {}),
    ...(waitingOnHuman ? { waitingOnHuman: true } : {}),
    ...(isoOrUndefined(r.tsCreated) ? { createdAt: isoOrUndefined(r.tsCreated) } : {}),
    ...(str(r.priority) ? { priority: r.priority } : {}),
  };
}

export const WORK_ACTIVE = new Set(["pending", "in-progress", "blocked"]);

export type EventType = "message" | "claim" | "handoff" | "answer" | "close" | "prompt";

/** A daemon event worth keeping, before session names are resolved to seats. */
export interface EventRecord {
  seq: number;
  at: string;
  eventType: EventType;
  daemonEvent: string;
  summary: string;
  from?: string;
  to?: string;
  workId?: string;
}

/**
 * Maps one daemon event (queue.created, queue.claimed, queue.handed_off, queue.updated to done, agent.activity
 * needs_input) to a record. Only identifiers are read, plus the daemon's short `summary` or reason when
 * `includeText` is set; request bodies and any other field are ignored. Anything else is null.
 *
 * A closed item is always `close`: the pinned daemon closes a human reply with closureReason `no-follow-on`
 * like any other close, and the event carries no answer marker, so `answer` is never inferred.
 */
export function mapEvent(seq: number, e: Json, includeText = false): EventRecord | null {
  const at = isoOrUndefined(e.createdAt);
  if (!at) return null;
  const type = str(e.type) ?? "";
  const workId = str(e.qitemId);
  const summary = (eventType: EventType, text: unknown): string =>
    (includeText ? shortText(text, EVENT_SUMMARY_MAX) : undefined) ?? shortText(workId ? `${eventType} ${workId}` : eventType, EVENT_SUMMARY_MAX)!;
  const make = (eventType: EventType, text: unknown, from?: unknown, to?: unknown): EventRecord => ({
    seq, at, daemonEvent: type, eventType, summary: summary(eventType, text),
    ...(workId ? { workId } : {}), ...(str(from) ? { from: from as string } : {}), ...(str(to) ? { to: to as string } : {}),
  });
  switch (type) {
    case "queue.created": return make("message", e.summary, e.sourceSession, e.destinationSession);
    case "queue.claimed": return make("claim", e.summary, e.destinationSession);
    case "queue.handed_off": return make("handoff", e.summary, e.fromSession, e.toSession);
    case "queue.updated": return e.toState === "done" && e.fromState !== "done" ? make("close", e.summary, e.actorSession) : null;
    case "agent.activity": {
      const a = rec(e.activity);
      return a.state === "needs_input" ? make("prompt", a.reason, e.sessionName) : null;
    }
    default: return null;
  }
}
