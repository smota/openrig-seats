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

export function mapSeat(node: unknown, attentionIds: string[]): Json | null {
  const n = rec(node);
  if (n.nodeKind === "infrastructure") return null;
  const id = str(n.nodeId);
  const rigId = str(n.rigId);
  if (!id || !rigId) return null;
  const name = str(n.logicalId) ?? id;
  const state = seatState(n);
  const activity = str(rec(n.activityState).display) ?? str(rec(n.agentActivity).reason);
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
  };
}

const SEVERITY: Record<string, "info" | "warning" | "critical"> = { routine: "info", urgent: "warning", critical: "critical" };

export function mapAttention(item: unknown, seatIdOf: (session: string | undefined) => string | undefined): Json | null {
  const i = rec(item);
  const id = str(i.id);
  if (!id) return null;
  const seatId = seatIdOf(str(i.asker));
  const title = (str(i.summary) ?? "Request summary unavailable").slice(0, 300);
  return {
    id,
    title,
    severity: SEVERITY[str(i.urgency) ?? ""] ?? "info",
    state: "open",
    reason: i.kind === "update" ? "An update addressed to a person is open" : "A request addressed to a person is open",
    ...(str(i.unblocks) ? { impact: str(i.unblocks)!.slice(0, 500) } : {}),
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

export function mapWork(row: unknown, seatIdOf: (session: string | undefined) => string | undefined, waitingOnHuman: boolean): Json | null {
  const r = rec(row);
  const id = str(r.qitemId);
  const state = WORK_STATE[str(r.state) ?? ""];
  if (!id || !state) return null;
  const assignee = seatIdOf(str(r.destinationSession));
  const creator = seatIdOf(str(r.sourceSession));
  return {
    id,
    // Never derived from the request body: only the summary, else a fixed label with the id.
    title: (str(r.summary) ?? `Queue item ${id}`).slice(0, 300),
    state,
    ...(assignee ? { assigneeSeatId: assignee } : {}),
    ...(creator ? { creatorSeatId: creator } : {}),
    ...(waitingOnHuman ? { waitingOnHuman: true } : {}),
    ...(isoOrUndefined(r.tsCreated) ? { createdAt: isoOrUndefined(r.tsCreated) } : {}),
    ...(str(r.priority) ? { priority: r.priority } : {}),
  };
}

export const WORK_ACTIVE = new Set(["pending", "in-progress", "blocked"]);
