import { createAgyReader } from "./agy-jsonl.js";
import { createPiReader } from "./pi-jsonl.js";
import { createClaudeJsonlReader } from "./claude-jsonl.js";
import { createCodexRolloutReader } from "./codex-rollout.js";
import { createPlainTextReader } from "./plain-text.js";
import type { ReaderOptions, SeatReader, SeatRef } from "./types.js";

/** Every reader for one seat, most specific first; the plain-text fallback is last and always matches. */
export function createReaders(options: ReaderOptions): SeatReader[] {
  return [createClaudeJsonlReader(options), createCodexRolloutReader(options), createAgyReader(options), createPiReader(options), createPlainTextReader(options)];
}

export function selectReader(seat: SeatRef, readers: SeatReader[]): SeatReader {
  const found = readers.find((r) => r.detect(seat));
  if (!found) throw new Error("no reader detects this seat (include the plain-text fallback)");
  return found;
}
