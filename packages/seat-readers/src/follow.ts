import type { Turn } from "@openrig-seats/seat-protocol";
import type { FollowResult, GenerationRecord, ReaderCursor, ReaderOptions } from "./types.js";

export interface LineContext {
  /** Turn-id prefix, unique per record file. */
  idBase: string;
  /** Byte offset of this line's first byte in the record. */
  offset: number;
  cursor: ReaderCursor;
  options: ReaderOptions;
  generationId: string | null;
}

export type LineParser = (value: unknown, ctx: LineContext) => Turn[];

const MAX_PENDING = 256;

/** Pending-call table access that never sees inherited properties ("toString", "__proto__") and never writes the prototype. */
export const pendingGet = (cursor: ReaderCursor, key: string): string | undefined =>
  cursor.pending && Object.hasOwn(cursor.pending, key) ? cursor.pending[key] : undefined;
export function pendingSet(cursor: ReaderCursor, key: string, value: string): void {
  cursor.pending = { ...(cursor.pending ?? {}) };
  Object.defineProperty(cursor.pending, key, { value, enumerable: true, writable: true, configurable: true });
}
export function pendingDelete(cursor: ReaderCursor, key: string): void {
  if (cursor.pending && Object.hasOwn(cursor.pending, key)) delete cursor.pending[key];
}

/** Stable short hash (FNV-1a, 32 bit) so ids stay short and carry no path. */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * The cursor rule shared by every reader: advance by the UTF-8 byte length of complete lines only. A trailing
 * partial line (including a multi-byte character cut at the 8 MiB boundary, which the daemon decodes to U+FFFD)
 * is held back and re-read from the cursor next time. A changed generationId restarts at 0.
 */
export function followLines(record: GenerationRecord, cursor: ReaderCursor, options: ReaderOptions, parse: LineParser, rawLines = false): FollowResult {
  const requested = record.sinceBytes ?? cursor.offset;
  const replaced = cursor.generationId !== null && record.generationId !== null && cursor.generationId !== record.generationId;
  if (replaced && requested !== 0) {
    return { turns: [], cursor: { generationId: record.generationId, offset: 0 }, skipped: 0, lines: 0, refetch: true, restarted: true };
  }
  const base: ReaderCursor = replaced
    ? { generationId: record.generationId, offset: 0 }
    : { generationId: record.generationId ?? cursor.generationId, offset: cursor.offset, ...(cursor.pending ? { pending: cursor.pending } : {}) };
  if (requested !== base.offset) {
    return { turns: [], cursor: base, skipped: 0, lines: 0, refetch: true, ...(replaced ? { restarted: true } : {}) };
  }

  const text = record.suffix;
  const lastNewline = text.lastIndexOf("\n");
  const complete = lastNewline < 0 ? "" : text.slice(0, lastNewline + 1);
  const next: ReaderCursor = { ...base, pending: { ...(base.pending ?? {}) } };
  const turns: Turn[] = [];
  let skipped = 0;
  let lines = 0;
  let offset = base.offset;
  const idBase = shortHash(record.generationId ?? "none");

  for (const raw of complete === "" ? [] : complete.split("\n")) {
    // split leaves one empty tail after the final newline; the bytes of each line include its "\n".
    const lineBytes = Buffer.byteLength(raw, "utf8") + 1;
    if (!rawLines && raw.trim().length === 0) {
      offset += lineBytes;
      continue;
    }
    lines++;
    let value: unknown;
    try {
      value = rawLines ? raw : JSON.parse(raw);
    } catch {
      skipped++;
      offset += lineBytes;
      continue;
    }
    // One bad line must never block the seat: a parser exception skips and counts the line, and rolls back its pending changes.
    const savedPending = next.pending;
    try {
      turns.push(...parse(value, { idBase, offset, cursor: next, options, generationId: record.generationId }));
    } catch {
      skipped++;
      if (savedPending) next.pending = savedPending;
      else delete next.pending;
    }
    offset += lineBytes;
  }
  // The final split element is the empty string after the last newline: it added one phantom byte.
  if (complete.length > 0) offset -= 1;
  next.offset = offset;

  const keys = Object.keys(next.pending ?? {});
  if (keys.length > MAX_PENDING) for (const k of keys.slice(0, keys.length - MAX_PENDING)) pendingDelete(next, k);
  if (keys.length === 0) delete next.pending;

  const stalled = complete.length === 0 && record.truncated === true;
  return { turns, cursor: next, skipped, lines, ...(replaced ? { restarted: true } : {}), ...(stalled ? { stalled: true } : {}) };
}

const SUMMARY_MAX = 160;

/** One short line: collapse whitespace, cap length with an ellipsis. Very long tool output never reaches a turn whole. */
export function summarize(text: string, max = SUMMARY_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${Array.from(flat).slice(0, max - 1).join("")}…`;
}

export function turnTime(timestamp: unknown, options: ReaderOptions): string {
  if (typeof timestamp === "string" && !Number.isNaN(Date.parse(timestamp))) return new Date(timestamp).toISOString();
  return (options.now ?? (() => new Date()))().toISOString();
}

export const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
