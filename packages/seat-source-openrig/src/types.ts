/** One protocol-level change produced by the source. */
export interface Change {
  kind: "host" | "rig" | "seat" | "attention" | "work";
  id: string;
  op: "upsert" | "delete";
  data?: Record<string, unknown>;
}

export type SourceKind = Change["kind"];
export type Features = Record<SourceKind, boolean>;

export type Json = Record<string, unknown>;
