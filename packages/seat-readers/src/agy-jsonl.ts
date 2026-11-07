import type { Part, Turn } from "@openrig-seats/seat-protocol";
import { asRecord, followLines, turnTime, type LineContext } from "./follow.js";
import type { ReaderOptions, SeatReader } from "./types.js";

/** Antigravity CLI's brain/<session>/.system_generated/logs/transcript.jsonl.
 * GENERIC content is opaque tool output, not assistant prose. Tool calls have no native ids/results; planner status does not prove execution or result.
 */
export const AGY_HARNESSES = ["agy", "antigravity"] as const;

function agyLine(value: unknown, ctx: LineContext): Turn[] {
  const rec = asRecord(value);
  if (!rec) return [];
  const id = `${ctx.idBase}-${ctx.offset}`;
  const parts: Part[] = [];
  let role: Turn["role"] = "assistant";
  const failed = rec.status === "ERROR" || rec.type === "ERROR_MESSAGE";
  const running = rec.status === "RUNNING";
  const status = (state: "working" | "idle" | "error" | "thinking") =>
    parts.push({
      type: "status",
      id: `${id}:s`,
      phase: running ? "start" : "end",
      state,
    } as Part);
  if (rec.type === "USER_INPUT" && rec.source === "USER_EXPLICIT") {
    role = "user";
    if (
      ctx.options.includeText &&
      typeof rec.content === "string" &&
      rec.content.trim()
    )
      parts.push({
        type: "text",
        id: `${id}:text`,
        phase: "end",
        text: rec.content,
      } as Part);
  } else if (rec.type === "PLANNER_RESPONSE" && rec.source === "MODEL") {
    if (
      ctx.options.includeText &&
      typeof rec.content === "string" &&
      rec.content.trim()
    )
      parts.push({
        type: "text",
        id: `${id}:text`,
        phase: "end",
        text: rec.content,
      } as Part);
    if (typeof rec.thinking === "string") status("thinking");
    if (Array.isArray(rec.tool_calls))
      rec.tool_calls.forEach((call, i) => {
        const tool = asRecord(call);
        if (typeof tool?.name === "string" && tool.name)
          parts.push({
            type: "tool",
            id: `${id}:tool:${i}`,
            phase: "start",
            name: tool.name,
            status: "pending",
          } as Part);
      });
    if (parts.length === 0)
      status(failed ? "error" : running ? "working" : "idle");
  } else if (rec.type === "GENERIC" && rec.source === "MODEL") {
    status(failed ? "error" : running ? "working" : "idle");
  } else if (rec.type === "ERROR_MESSAGE") {
    role = "system";
    status("error");
  } else return [];
  if (parts.length === 0) return [];
  return [
    {
      id,
      seatId: ctx.options.seatId,
      updatedAt: turnTime(rec.created_at, ctx.options),
      ...(ctx.generationId ? { generationId: ctx.generationId } : {}),
      role,
      state: failed
        ? "failed"
        : running || parts.some((p) => p.type === "tool")
          ? "running"
          : "completed",
      parts,
    } as Turn,
  ];
}

export function createAgyReader(options: ReaderOptions): SeatReader {
  return {
    name: "agy-jsonl",
    detect: (seat) =>
      AGY_HARNESSES.includes(
        (seat.harness ?? "").toLowerCase() as (typeof AGY_HARNESSES)[number],
      ),
    follow: (record, cursor) => followLines(record, cursor, options, agyLine),
  };
}
