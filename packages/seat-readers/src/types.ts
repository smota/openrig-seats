import type { Turn } from "@openrig-seats/seat-protocol";

/** What a reader needs to know about a seat. `harness` is the seat protocol's open-set harness name. */
export interface SeatRef {
  id: string;
  harness?: string;
}

/**
 * The body of OpenRig `GET /api/sessions/:name/generation-record?sinceBytes=N`, plus the offset that was
 * requested (`sinceBytes`, default 0). `suffix` is already decoded UTF-8 text, capped at 8 MiB per read.
 */
export interface GenerationRecord {
  /** JSON-string array `[occupantGen, sessionId, path, dev, ino, birthtimeMs]`; compare whole, identify the occupant by element 0 only. */
  generationId: string | null;
  sessionId?: string;
  runtime?: string;
  totalBytes?: number;
  suffix: string;
  /** True when more bytes remain after this suffix (the 8 MiB cap was hit). */
  truncated?: boolean;
  /** The `sinceBytes` the caller sent. Defaults to the cursor offset. */
  sinceBytes?: number;
}

/** Opaque to callers: store it, pass it back. */
export interface ReaderCursor {
  generationId: string | null;
  /** UTF-8 byte offset of the first byte not yet consumed (always at a line start). */
  offset: number;
  /** Tool call id -> tool name for calls whose result has not been seen yet (bounded). */
  pending?: Record<string, string>;
}

export interface FollowResult {
  turns: Turn[];
  cursor: ReaderCursor;
  /** Complete lines that were not valid JSON (skipped, never thrown). */
  skipped: number;
  /** Complete lines consumed. */
  lines: number;
  /**
   * The suffix cannot be applied at this cursor (the file was replaced, or the record was read from another
   * offset): nothing was consumed; fetch again with `sinceBytes = cursor.offset` (0 after a replacement).
   */
  refetch?: boolean;
  /** The occupant generation (`generationId[0]`) changed or the file was replaced: a new conversation segment starts. */
  restarted?: boolean;
  /** One line is longer than the 8 MiB cap, so the cursor cannot advance; the reader needs a bigger window. */
  stalled?: boolean;
}

export interface SeatReader {
  /** Reader name, for example `claude-jsonl`. */
  readonly name: string;
  /** True when this reader understands the seat's record. */
  detect(seat: SeatRef): boolean;
  follow(record: GenerationRecord, cursor: ReaderCursor): FollowResult;
}

export const initialCursor = (): ReaderCursor => ({ generationId: null, offset: 0 });

/** OpenRig answers 409 `record_truncated` when `sinceBytes` is past the end: restart that generation from 0. */
export const restartCursor = (cursor: ReaderCursor): ReaderCursor => ({ generationId: cursor.generationId, offset: 0 });

/**
 * `generationId[0]`: the occupant generation. It, not the whole id, identifies the occupant of a seat: the rest
 * (session id, path, dev, ino, birthtime) changes whenever the record file is replaced, which restarts the
 * cursor but does not change who sits in the seat. Leases must compare this value only.
 */
export function occupantGeneration(generationId: string | null | undefined): string | null {
  if (!generationId) return null;
  try {
    const parsed: unknown = JSON.parse(generationId);
    const first = Array.isArray(parsed) ? parsed[0] : undefined;
    return typeof first === "string" && first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

export interface ReaderOptions {
  /** Agy/Pi only: include user/assistant prose (default false). Never includes tool payloads or thoughts. */
  includeText?: boolean;
  seatId: string;
  /** Clock for turns whose line carries no timestamp. */
  now?: () => Date;
}
