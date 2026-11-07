import type { Part, Turn } from "@openrig-seats/seat-protocol";
import { followLines, turnTime } from "./follow.js";
import type { ReaderOptions, SeatReader } from "./types.js";

/**
 * Fallback for seats whose runtime has no record (agy, pi: OpenRig answers 409 `unsupported_runtime`).
 * The caller supplies text it already obtained elsewhere as `record.suffix` (for example a terminal snapshot
 * delta from the source layer); this reader reads nothing from disk. The complete lines of one `follow` call
 * become one assistant turn holding one `text` part; blank lines are kept inside it, an all-blank block
 * produces no turn. It never produces tool, question or status parts. Same cursor rule as the JSONL readers
 * (complete lines only, UTF-8 byte offsets), so a missing trailing newline holds the last line back.
 */
export function createPlainTextReader(options: ReaderOptions): SeatReader {
  return {
    name: "plain-text",
    detect: () => true,
    follow: (record, cursor) => {
      const lines: string[] = [];
      let firstOffset = -1;
      const result = followLines(
        record,
        cursor,
        options,
        (value, ctx) => {
          if (firstOffset < 0) firstOffset = ctx.offset;
          lines.push(value as string);
          return [];
        },
        true,
      );
      const text = lines.join("\n").replace(/\s+$/, "");
      if (!text.trim()) return result;
      const turn = {
        id: `${record.sessionId ?? "text"}-${firstOffset}`,
        updatedAt: turnTime(undefined, options),
        seatId: options.seatId,
        ...(record.generationId ? { generationId: record.generationId } : {}),
        role: "assistant",
        state: "completed",
        parts: [{ type: "text", id: `${record.sessionId ?? "text"}-${firstOffset}:0`, phase: "end", text } as Part],
      } as Turn;
      return { ...result, turns: [turn] };
    },
  };
}
