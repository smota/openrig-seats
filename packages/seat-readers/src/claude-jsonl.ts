import type { Part, Turn } from "@openrig-seats/seat-protocol";
import { asRecord, followLines, pendingDelete, pendingGet, pendingSet, summarize, turnTime, type LineContext } from "./follow.js";
import type { ReaderOptions, SeatReader } from "./types.js";

/**
 * Reader for Claude Code session JSONL (`~/.claude/projects/<project>/<session>.jsonl`).
 *
 * Line shape (as read by OpenRig's `parseJsonlExchanges` and its restore-packet parser):
 *   {type:"user"|"assistant", uuid, timestamp, sessionId, message:{role, content}}
 * where content is a string or blocks of `text`, `thinking`, `tool_use {id,name,input}` and
 * `tool_result {tool_use_id,content,is_error}`. Other record types (summary, permission-mode, titles) carry
 * no conversation and are ignored; `system` records of subtype `api_error` and `turn_duration` become status.
 *
 * Mapping: user text -> user turn; assistant text -> text part; thinking -> status `thinking`; tool_use -> tool
 * part `start`/`running` and its tool_result -> a tool part with the same id, `end`/`completed|failed` (merge by
 * part id); `AskUserQuestion` tool calls -> question parts (options become `allow_once` choices) closed by the
 * result. Permission prompts of the terminal UI are not written to this file, so none can be produced.
 */
export const CLAUDE_HARNESSES = ["claude-code", "claude", "claude_code"] as const;

const SUMMARY_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"];

function toolSummary(input: unknown): string {
  const obj = asRecord(input);
  if (!obj) return typeof input === "string" ? summarize(input) : "";
  for (const key of SUMMARY_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return summarize(v);
  }
  return summarize(JSON.stringify(obj));
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (typeof p === "string" ? p : typeof asRecord(p)?.text === "string" ? (asRecord(p)!.text as string) : ""))
    .filter(Boolean)
    .join("\n");
}

function questionParts(callId: string, input: unknown): { parts: Part[]; prompts: string[] } {
  const questions = Array.isArray(asRecord(input)?.questions) ? (asRecord(input)!.questions as unknown[]) : [];
  const parts: Part[] = [];
  const prompts: string[] = [];
  questions.forEach((q, i) => {
    const rec = asRecord(q);
    const prompt = typeof rec?.question === "string" && rec.question.trim() ? rec.question : undefined;
    if (!prompt) return;
    const options = (Array.isArray(rec?.options) ? (rec!.options as unknown[]) : []).flatMap((o, j) => {
      const label = typeof o === "string" ? o : asRecord(o)?.label;
      return typeof label === "string" && label ? [{ optionId: `o${j}`, name: label, kind: "allow_once" as const }] : [];
    });
    const id = i === 0 ? callId : `${callId}:${i}`;
    prompts.push(prompt);
    parts.push({ type: "question", id, phase: "start", prompt, options } as Part);
  });
  return { parts, prompts };
}

function claudeLine(value: unknown, ctx: LineContext): Turn[] {
  const rec = asRecord(value);
  if (!rec) return [];
  const type = rec.type;
  const uuid = typeof rec.uuid === "string" && rec.uuid ? rec.uuid : `${ctx.idBase}-${ctx.offset}`;
  const updatedAt = turnTime(rec.timestamp, ctx.options);
  const make = (role: Turn["role"], state: Turn["state"], parts: Part[]): Turn[] =>
    parts.length === 0 ? [] : [{ id: uuid, updatedAt, seatId: ctx.options.seatId, ...(ctx.generationId ? { generationId: ctx.generationId } : {}), role, state, parts } as Turn];

  if (type === "system") {
    if (rec.subtype === "api_error") {
      const label = summarize(typeof rec.content === "string" ? rec.content : "API error");
      return make("system", "failed", [{ type: "status", id: `${uuid}:s`, phase: "end", state: "error", label } as Part]);
    }
    if (rec.subtype === "turn_duration") return make("system", "completed", [{ type: "status", id: `${uuid}:s`, phase: "end", state: "idle" } as Part]);
    return [];
  }
  if (type !== "user" && type !== "assistant") return [];
  if (rec.isMeta === true) return [];
  const message = asRecord(rec.message);
  if (!message) return [];
  const content = message.content;

  if (typeof content === "string") {
    return content.trim() ? make(type === "user" ? "user" : "assistant", "completed", [{ type: "text", id: `${uuid}:0`, phase: "end", text: content } as Part]) : [];
  }
  if (!Array.isArray(content)) return [];

  const parts: Part[] = [];
  let running = false;
  let failed = false;
  content.forEach((block, i) => {
    const b = asRecord(block);
    if (!b) return;
    const pid = `${uuid}:${i}`;
    switch (b.type) {
      case "text":
        if (typeof b.text === "string" && b.text.trim()) parts.push({ type: "text", id: pid, phase: "end", text: b.text } as Part);
        break;
      case "thinking":
        parts.push({ type: "status", id: pid, phase: "start", state: "thinking" } as Part);
        break;
      case "tool_use": {
        const id = typeof b.id === "string" && b.id ? b.id : pid;
        const name = typeof b.name === "string" && b.name ? b.name : "tool";
        running = true;
        if (name === "AskUserQuestion") {
          const q = questionParts(id, b.input);
          if (q.parts.length > 0) {
            parts.push(...q.parts);
            pendingSet(ctx.cursor, id, `?${JSON.stringify(q.prompts)}`);
            break;
          }
        }
        pendingSet(ctx.cursor, id, name);
        parts.push({ type: "tool", id, phase: "start", name, summary: toolSummary(b.input), status: "running" } as Part);
        break;
      }
      case "tool_result": {
        const id = typeof b.tool_use_id === "string" && b.tool_use_id ? b.tool_use_id : pid;
        const known = pendingGet(ctx.cursor, id);
        const isError = b.is_error === true;
        if (known?.startsWith("?")) {
          const prompts = JSON.parse(known.slice(1)) as string[];
          prompts.forEach((prompt, n) => parts.push({ type: "question", id: n === 0 ? id : `${id}:${n}`, phase: "end", prompt, options: [] } as Part));
        } else {
          if (isError) failed = true;
          const text = summarize(resultText(b.content));
          parts.push({ type: "tool", id, phase: "end", name: known ?? "tool", ...(text ? { summary: text } : {}), status: isError ? "failed" : "completed" } as Part);
        }
        pendingDelete(ctx.cursor, id);
        break;
      }
      default:
        break;
    }
  });
  if (type === "assistant" && message.stop_reason === "end_turn") parts.push({ type: "status", id: `${uuid}:end`, phase: "end", state: "idle" } as Part);
  const hasText = parts.some((p) => p.type === "text");
  const onlyResults = type === "user" && !hasText && parts.length > 0;
  const role: Turn["role"] = onlyResults ? "assistant" : type === "user" ? "user" : "assistant";
  return make(role, running ? "running" : failed ? "failed" : "completed", parts);
}

export function createClaudeJsonlReader(options: ReaderOptions): SeatReader {
  return {
    name: "claude-jsonl",
    detect: (seat) => CLAUDE_HARNESSES.includes((seat.harness ?? "").toLowerCase() as (typeof CLAUDE_HARNESSES)[number]),
    follow: (record, cursor) => followLines(record, cursor, options, claudeLine),
  };
}
