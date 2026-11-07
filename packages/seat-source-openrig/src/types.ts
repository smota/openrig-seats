/** One protocol-level change produced by the source. */
export interface Change {
  kind: SourceKind | ExtensionKind;
  id: string;
  op: "upsert" | "delete";
  data?: Record<string, unknown>;
}

/** Core kinds the source reads from daemon routes; each can be switched off when its route is missing. */
export type SourceKind = "host" | "rig" | "seat" | "attention" | "work";
/** Extension kinds the source emits (namespace `x-openrig`). */
export type ExtensionKind = "x-openrig.event";
export type Features = Record<SourceKind, boolean>;

export type Json = Record<string, unknown>;
