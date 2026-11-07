import type { StreamEnvelope } from "./types.generated.js";

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

/** Minimal in-memory mirror of the stream: upsert replaces, delete removes, unknown kinds are kept. */
export class Mirror {
  private readonly items = new Map<string, Map<string, Record<string, unknown>>>();

  apply(envelope: Pick<StreamEnvelope, "kind" | "id" | "op" | "data">): void {
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
