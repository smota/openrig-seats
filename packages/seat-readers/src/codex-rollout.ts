import type { Part, Turn } from "@openrig-seats/seat-protocol";
import { asRecord, followLines, pendingDelete, pendingGet, pendingSet, summarize, turnTime, type LineContext } from "./follow.js";
import type { ReaderOptions, SeatReader } from "./types.js";

/**
 * Reader for Codex rollout JSONL (`~/.codex/sessions/.../rollout-*.jsonl`).
 *
 * Line shape: {timestamp, type, payload}. `type` is `session_meta`, `turn_context`, `compacted`,
 * `response_item` or `event_msg`.
 *   response_item payloads: `message {role, content:[{type:input_text|output_text, text}]}`,
 *   `function_call {name, arguments, call_id}`, `function_call_output {call_id, output}`,
 *   `custom_tool_call {name, input, call_id}` (+ `_output`), `local_shell_call {call_id, action}`, `reasoning`.
 *   event_msg payloads used: `task_started`, `task_complete`, `turn_aborted`, `error`,
 *   `exec_approval_request`, `apply_patch_approval_request` (the `user_message` and `agent_message` events
 *   duplicate response_item messages and are ignored; token counts and metadata are ignored).
 *
 * Mapping as in the Claude reader (tool parts merge by call id). Approval requests become question parts with
 * id `q-<call_id>` and options `approved` (allow_once), `approved_for_session` (allow_always), `denied`
 * (reject_once); the rollout does not record the answer, so consumers close the question when the tool part
 * with the same call id ends.
 */
export const CODEX_HARNESSES = ["codex"] as const;

function argsSummary(args: unknown): string {
  let value = args;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return summarize(value as string);
    }
  }
  const obj = asRecord(value);
  if (!obj) return "";
  const cmd = obj.command ?? obj.cmd;
  if (Array.isArray(cmd)) return summarize(cmd.filter((c) => typeof c === "string").join(" "));
  if (typeof cmd === "string") return summarize(cmd);
  for (const k of ["path", "file_path", "query", "url"]) if (typeof obj[k] === "string") return summarize(obj[k] as string);
  return summarize(JSON.stringify(obj));
}

/** Plain-text exit lines Codex emits: `Exit code: N` (shell tool) and `Process exited with code N` (unified exec). */
const EXIT_LINE = /^(?:Exit code:|Process exited with code)\s*(-?\d+)/im;

function outputInfo(output: unknown): { text: string; failed: boolean } {
  let text = "";
  let failed = false;
  let value = output;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{")) {
      try {
        value = JSON.parse(trimmed);
      } catch {
        /* plain text */
      }
    }
  }
  if (typeof value === "string") {
    text = value;
    const m = EXIT_LINE.exec(value);
    if (m && Number(m[1]) !== 0) failed = true;
  } else {
    const obj = asRecord(value);
    if (obj) {
      const body = obj.output ?? obj.content;
      text = typeof body === "string" ? body : "";
      const meta = asRecord(obj.metadata);
      const structured = [meta?.exit_code, obj.exit_code].find((c) => typeof c === "number") as number | undefined;
      if (structured !== undefined) failed = structured !== 0;
      else {
        if (obj.success === false) failed = true;
        const m = EXIT_LINE.exec(text);
        if (m && Number(m[1]) !== 0) failed = true;
      }
    }
  }
  return { text: summarize(text), failed };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => asRecord(p))
    .filter((p) => p && (p.type === "input_text" || p.type === "output_text" || p.type === "text") && typeof p.text === "string")
    .map((p) => p!.text as string)
    .join("\n");
}

const INJECTED = /^\s*<(environment_context|user_instructions|permissions instructions)\b/;

function codexLine(value: unknown, ctx: LineContext): Turn[] {
  const rec = asRecord(value);
  const payload = asRecord(rec?.payload);
  if (!rec || !payload) return [];
  const id = `${ctx.idBase}-${ctx.offset}`;
  const updatedAt = turnTime(rec.timestamp, ctx.options);
  const make = (role: Turn["role"], state: Turn["state"], parts: Part[]): Turn[] => [
    { id, updatedAt, seatId: ctx.options.seatId, ...(ctx.generationId ? { generationId: ctx.generationId } : {}), role, state, parts } as Turn,
  ];
  const callId = typeof payload.call_id === "string" && payload.call_id ? payload.call_id : id;
  const QPREFIX = "q:";
  /** Close the approval question of this call, if open. The rollout never records the answer, so the outcome is unknown. */
  const closeQuestion = (cid: string): Part[] => {
    const prompt = pendingGet(ctx.cursor, `${QPREFIX}${cid}`);
    if (prompt === undefined) return [];
    pendingDelete(ctx.cursor, `${QPREFIX}${cid}`);
    return [{ type: "question", id: `q-${cid}`, phase: "end", prompt, options: [], outcome: "unknown" } as Part];
  };
  const start = (name: string, summary: string): Turn[] => {
    const closed = closeQuestion(callId);
    pendingSet(ctx.cursor, callId, name);
    return make("assistant", "running", [...closed, { type: "tool", id: callId, phase: "start", name, summary, status: "running" } as Part]);
  };
  const end = (output: unknown): Turn[] => {
    const info = outputInfo(output);
    const closed = closeQuestion(callId);
    const name = pendingGet(ctx.cursor, callId) ?? "tool";
    pendingDelete(ctx.cursor, callId);
    return make("assistant", info.failed ? "failed" : "completed", [
      ...closed,
      { type: "tool", id: callId, phase: "end", name, ...(info.text ? { summary: info.text } : {}), status: info.failed ? "failed" : "completed" } as Part,
    ]);
  };

  if (rec.type === "response_item") {
    switch (payload.type) {
      case "message": {
        const text = messageText(payload.content);
        if (!text.trim() || (payload.role !== "user" && payload.role !== "assistant")) return [];
        const role: Turn["role"] = payload.role === "user" ? (INJECTED.test(text) ? "system" : "user") : "assistant";
        return make(role, "completed", [{ type: "text", id: `${id}:0`, phase: "end", text } as Part]);
      }
      case "function_call":
        return start(typeof payload.name === "string" && payload.name ? payload.name : "tool", argsSummary(payload.arguments));
      case "custom_tool_call":
        return start(typeof payload.name === "string" && payload.name ? payload.name : "tool", summarize(typeof payload.input === "string" ? payload.input : ""));
      case "local_shell_call":
        return start("shell", argsSummary(payload.action));
      case "function_call_output":
      case "custom_tool_call_output":
        return end(payload.output);
      case "reasoning":
        return make("assistant", "running", [{ type: "status", id: `${id}:r`, phase: "start", state: "thinking" } as Part]);
      default:
        return [];
    }
  }

  if (rec.type === "event_msg") {
    switch (payload.type) {
      case "task_started":
        return make("system", "running", [{ type: "status", id: `${id}:s`, phase: "start", state: "working" } as Part]);
      case "task_complete": {
        const open = Object.keys(ctx.cursor.pending ?? {}).filter((k) => k.startsWith(QPREFIX)).flatMap((k) => closeQuestion(k.slice(QPREFIX.length)));
        return make("system", "completed", [...open, { type: "status", id: `${id}:s`, phase: "end", state: "idle" } as Part]);
      }
      case "turn_aborted":
        return make("system", "completed", [{ type: "status", id: `${id}:s`, phase: "end", state: "idle", label: "aborted" } as Part]);
      case "error":
        return make("system", "failed", [
          { type: "status", id: `${id}:s`, phase: "end", state: "error", label: summarize(typeof payload.message === "string" ? payload.message : "error") } as Part,
        ]);
      case "exec_approval_request":
      case "apply_patch_approval_request": {
        const what = payload.type === "exec_approval_request" ? `Run: ${argsSummary({ command: payload.command })}` : "Apply patch";
        const reason = typeof payload.reason === "string" && payload.reason ? ` (${summarize(payload.reason, 80)})` : "";
        const prompt = `${what}${reason}?`;
        pendingSet(ctx.cursor, `${QPREFIX}${callId}`, prompt);
        return make("assistant", "running", [
          {
            type: "question",
            id: `q-${callId}`,
            phase: "start",
            prompt,
            options: [
              { optionId: "approved", name: "Approve once", kind: "allow_once" },
              { optionId: "approved_for_session", name: "Approve for session", kind: "allow_always" },
              { optionId: "denied", name: "Deny", kind: "reject_once" },
            ],
          } as Part,
        ]);
      }
      default:
        return [];
    }
  }
  return [];
}

export function createCodexRolloutReader(options: ReaderOptions): SeatReader {
  return {
    name: "codex-rollout",
    detect: (seat) => CODEX_HARNESSES.includes((seat.harness ?? "").toLowerCase() as (typeof CODEX_HARNESSES)[number]),
    follow: (record, cursor) => followLines(record, cursor, options, codexLine),
  };
}
