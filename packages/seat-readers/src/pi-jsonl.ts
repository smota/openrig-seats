import type { Part, Turn } from "@openrig-seats/seat-protocol";
import {
  asRecord,
  followLines,
  pendingDelete,
  pendingGet,
  pendingSet,
  turnTime,
  type LineContext,
} from "./follow.js";
import type { ReaderOptions, SeatReader } from "./types.js";
import { readNativeSession } from "./native-file.js";

/** Read a path returned by discoverPiSessions before passing its text to follow. */
export const readPiSession = readNativeSession;

/** Pi session v3 JSONL: message entries hold user/assistant/toolResult messages.
 * Metadata, branch summaries, custom records, tool arguments/results and thinking text are omitted.
 */
export const PI_HARNESSES = ["pi"] as const;
function piLine(value: unknown, ctx: LineContext): Turn[] {
  const rec = asRecord(value);
  const msg = asRecord(rec?.message);
  if (
    rec?.type !== "message" ||
    !msg ||
    !["user", "assistant", "toolResult"].includes(String(msg.role))
  )
    return [];
  const id =
    typeof rec.id === "string" && rec.id
      ? rec.id
      : `${ctx.idBase}-${ctx.offset}`;
  const parts: Part[] = [];
  const failed = msg.stopReason === "error" || msg.isError === true;
  if (msg.role === "toolResult") {
    const callId =
      typeof msg.toolCallId === "string" && msg.toolCallId
        ? msg.toolCallId
        : `${id}:tool`;
    const name =
      pendingGet(ctx.cursor, callId) ??
      (typeof msg.toolName === "string" && msg.toolName
        ? msg.toolName
        : "tool");
    pendingDelete(ctx.cursor, callId);
    parts.push({
      type: "tool",
      id: callId,
      name,
      phase: "end",
      status: failed ? "failed" : "completed",
    } as Part);
  } else {
    const content =
      typeof msg.content === "string"
        ? [{ type: "text", text: msg.content }]
        : Array.isArray(msg.content)
          ? msg.content
          : [];
    content.forEach((item, i) => {
      const block = asRecord(item);
      if (!block) return;
      const pid = `${id}:${i}`;
      if (
        block.type === "text" &&
        ctx.options.includeText &&
        typeof block.text === "string" &&
        block.text.trim()
      )
        parts.push({
          type: "text",
          id: pid,
          phase: "end",
          text: block.text,
        } as Part);
      if (block.type === "thinking")
        parts.push({
          type: "status",
          id: pid,
          phase: "start",
          state: "thinking",
        } as Part);
      if (block.type === "toolCall" && msg.role === "assistant") {
        const callId =
          typeof block.id === "string" && block.id ? block.id : pid;
        const name =
          typeof block.name === "string" && block.name ? block.name : "tool";
        pendingSet(ctx.cursor, callId, name);
        parts.push({
          type: "tool",
          id: callId,
          phase: "start",
          name,
          status: "running",
        } as Part);
      }
    });
    if (
      msg.role === "assistant" &&
      (failed || msg.stopReason === "stop" || msg.stopReason === "aborted")
    )
      parts.push({
        type: "status",
        id: `${id}:end`,
        phase: "end",
        state: failed ? "error" : "idle",
      } as Part);
  }
  if (!parts.length) return [];
  return [
    {
      id,
      seatId: ctx.options.seatId,
      updatedAt: turnTime(rec.timestamp, ctx.options),
      ...(ctx.generationId ? { generationId: ctx.generationId } : {}),
      role: msg.role === "user" ? "user" : "assistant",
      state: failed
        ? "failed"
        : parts.some((p) => p.type === "tool" && p.phase === "start")
          ? "running"
          : "completed",
      parts,
    } as Turn,
  ];
}
export function createPiReader(options: ReaderOptions): SeatReader {
  return {
    name: "pi-jsonl",
    detect: (seat) =>
      PI_HARNESSES.includes(
        (seat.harness ?? "").toLowerCase() as (typeof PI_HARNESSES)[number],
      ),
    follow: (record, cursor) => followLines(record, cursor, options, piLine),
  };
}
