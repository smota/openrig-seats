import type { StreamControl, StreamEnvelope } from "./types.generated.js";

export const CORE_KINDS = ["host", "rig", "seat", "turn", "attention", "work"] as const;
export type CoreKind = (typeof CORE_KINDS)[number];

export const EXTENSION_KIND = /^x-[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$/;

export function isCoreKind(kind: string): kind is CoreKind {
  return (CORE_KINDS as readonly string[]).includes(kind);
}

export function isExtensionKind(kind: string): boolean {
  return EXTENSION_KIND.test(kind);
}

/** What any UI can draw for a kind it does not know. */
export interface GenericCard {
  kind: string;
  id: string;
  title: string;
  summary?: string;
  actions: Array<{ id: string; label: string; input?: object; danger?: boolean }>;
}

/** Unknown kinds (x-<ns>.* or a core kind from a newer minor version) become a generic card. */
export function toGenericCard(envelope: { kind: string; id: string; data?: unknown; op?: string }): GenericCard {
  const d = (envelope.data ?? {}) as Record<string, unknown>;
  const actions = Array.isArray(d.actions)
    ? (d.actions as unknown[]).filter(
        (a): a is GenericCard["actions"][number] =>
          typeof a === "object" && a !== null && typeof (a as { id?: unknown }).id === "string" && typeof (a as { label?: unknown }).label === "string",
      )
    : [];
  return {
    kind: envelope.kind,
    id: envelope.id,
    title: typeof d.title === "string" && d.title ? d.title : envelope.id,
    ...(typeof d.summary === "string" ? { summary: d.summary } : {}),
    actions,
  };
}

/** What GET /stream yields: envelopes, and control messages such as `reset`. */
export type StreamItem = StreamEnvelope | StreamControl;

/** A control message has `type` and no `kind`; envelopes always have `kind`. */
export function isStreamControl(item: StreamItem): item is StreamControl {
  return typeof (item as { type?: unknown }).type === "string" && (item as { kind?: unknown }).kind === undefined;
}

/** Minimal in-memory mirror of the stream: upsert replaces, delete removes, unknown kinds are kept. */
export class Mirror {
  private readonly items = new Map<string, Map<string, Record<string, unknown>>>();

  /** Forgets everything held. Applied before the replay that follows a `reset`. */
  clear(): void {
    this.items.clear();
  }

  /** A `reset` control message clears the mirror; other control types are ignored. */
  apply(envelope: Pick<StreamEnvelope, "kind" | "id" | "op" | "data"> | StreamControl): void {
    if (isStreamControl(envelope as StreamItem)) {
      if ((envelope as StreamControl).type === "reset") this.clear();
      return;
    }
    envelope = envelope as Pick<StreamEnvelope, "kind" | "id" | "op" | "data">;
    let byId = this.items.get(envelope.kind);
    if (envelope.op === "delete") {
      byId?.delete(envelope.id);
      return;
    }
    if (!byId) this.items.set(envelope.kind, (byId = new Map()));
    byId.set(envelope.id, (envelope.data ?? {}) as Record<string, unknown>);
  }

  get(kind: string, id: string): Record<string, unknown> | undefined {
    return this.items.get(kind)?.get(id);
  }

  list(kind: string): Array<Record<string, unknown>> {
    return [...(this.items.get(kind)?.values() ?? [])];
  }

  kinds(): string[] {
    return [...this.items.keys()].filter((k) => (this.items.get(k)?.size ?? 0) > 0);
  }
}
