import { describe, expect, it } from "vitest";
import type { Part, Turn } from "@openrig-seats/seat-protocol";
import { createClaudeJsonlReader, createCodexRolloutReader, createPlainTextReader, createReaders, initialCursor, selectReader } from "../src/index.js";
import { followLines } from "../src/follow.js";
import { assertValid, fixture, serve } from "./helpers.js";

const parts = (turns: Turn[]) => turns.flatMap((t) => t.parts as (Part & Record<string, unknown>)[]);
const byType = (turns: Turn[], type: string) => parts(turns).filter((p) => p.type === type);

describe("claude-jsonl", () => {
  const reader = createClaudeJsonlReader({ seatId: "seat-acme" });
  const run = () => reader.follow(serve(fixture("claude-session.jsonl"), 0), initialCursor());

  it("detects Claude seats only", () => {
    expect(reader.detect({ id: "s", harness: "claude-code" })).toBe(true);
    expect(reader.detect({ id: "s", harness: "codex" })).toBe(false);
    expect(reader.detect({ id: "s" })).toBe(false);
  });

  it("maps prompts, text, tools, questions and status", () => {
    const r = run();
    assertValid(r.turns);
    expect(r.skipped).toBe(1);
    const user = r.turns.find((t) => t.id === "u1")!;
    expect(user.role).toBe("user");
    expect((user.parts[0] as { text: string }).text).toContain("café ☕");
    expect(r.turns.find((t) => t.id === "a1")!.state).toBe("running");
    expect(byType(r.turns, "text").map((p) => p.text)).toContain("I will read the module.");
    expect(byType(r.turns, "status").map((p) => p.state)).toEqual(expect.arrayContaining(["thinking", "idle", "error"]));
  });

  it("pairs tool calls with their results by part id, with name, summary and status", () => {
    const tools = byType(run().turns, "tool").filter((p) => p.id === "toolu_acme_1" || p.id === "toolu_acme_2");
    expect(tools).toEqual([
      expect.objectContaining({ id: "toolu_acme_1", phase: "start", name: "Read", summary: "src/billing/invoice.ts", status: "running" }),
      expect.objectContaining({ id: "toolu_acme_1", phase: "end", name: "Read", status: "completed" }),
      expect.objectContaining({ id: "toolu_acme_2", phase: "start", name: "Bash", summary: "npm test", status: "running" }),
      expect.objectContaining({ id: "toolu_acme_2", phase: "end", name: "Bash", summary: "3 tests failed", status: "failed" }),
    ]);
  });

  it("keeps the tool name across polls through the cursor", () => {
    const file = fixture("claude-session.jsonl");
    const cut = file.indexOf(Buffer.from('{"type":"user","uuid":"u2"'));
    const first = reader.follow(serve(file.subarray(0, cut), 0), initialCursor());
    const second = reader.follow(serve(file, first.cursor.offset), first.cursor);
    const end = byType(second.turns, "tool").find((p) => p.id === "toolu_acme_1")!;
    expect(end).toMatchObject({ phase: "end", name: "Read" });
  });

  it("maps AskUserQuestion to a question with options and closes it on the result", () => {
    const qs = byType(run().turns, "question");
    expect(qs[0]).toMatchObject({ id: "toolu_acme_3", phase: "start", prompt: "Which acme environment should I deploy to?" });
    expect((qs[0]!.options as { name: string; kind: string }[]).map((o) => [o.name, o.kind])).toEqual([["staging", "allow_once"], ["production", "allow_once"]]);
    expect(qs[1]).toMatchObject({ id: "toolu_acme_3", phase: "end" });
  });

  it("summarizes very long tool output", () => {
    const long = "x".repeat(50_000) + "\n" + "tail";
    const call = { type: "assistant", uuid: "a", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "y".repeat(5000) } }] } };
    const res = { type: "user", uuid: "b", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: long }] } };
    const file = Buffer.from(JSON.stringify(call) + "\n" + JSON.stringify(res) + "\n");
    const r = reader.follow(serve(file, 0), initialCursor());
    for (const p of byType(r.turns, "tool")) expect((p.summary as string).length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(r.turns).length).toBeLessThan(2000);
    assertValid(r.turns);
  });

  it("ignores meta records and empty messages", () => {
    const file = Buffer.from('{"type":"user","isMeta":true,"message":{"role":"user","content":"hidden"}}\n{"type":"summary","summary":"x"}\n{"type":"user","message":{"role":"user","content":"  "}}\n');
    const r = reader.follow(serve(file, 0), initialCursor());
    expect(r.turns).toEqual([]);
    expect(r.cursor.offset).toBe(file.length);
  });
});

describe("codex-rollout", () => {
  const reader = createCodexRolloutReader({ seatId: "seat-acme" });
  const run = () => reader.follow(serve(fixture("codex-rollout.jsonl"), 0), initialCursor());

  it("detects Codex seats only", () => {
    expect(reader.detect({ id: "s", harness: "codex" })).toBe(true);
    expect(reader.detect({ id: "s", harness: "claude-code" })).toBe(false);
  });

  it("maps messages, tools, approvals and task status; skips metadata and counts bad lines", () => {
    const r = run();
    assertValid(r.turns);
    expect(r.skipped).toBe(1);
    expect(r.turns.filter((t) => t.role === "user").map((t) => (t.parts[0] as { text: string }).text)).toEqual(["Add a retry to the acme client"]);
    expect(r.turns.some((t) => t.role === "system" && t.parts.some((p) => p.type === "text"))).toBe(true); // injected environment context
    expect(byType(r.turns, "text").map((p) => p.text)).toContain("Looking at the client.");
    expect(byType(r.turns, "status").map((p) => p.state)).toEqual(["working", "thinking", "idle"]);
  });

  it("pairs tool calls and results, reading failure from exit code", () => {
    const tools = byType(run().turns, "tool");
    expect(tools).toEqual([
      expect.objectContaining({ id: "call_acme_1", phase: "start", name: "shell", summary: "bash -lc cat src/client.ts" }),
      expect.objectContaining({ id: "call_acme_1", phase: "end", name: "shell", summary: "export class Client {}", status: "completed" }),
      expect.objectContaining({ id: "call_acme_2", phase: "start", name: "shell", summary: "rm -rf build" }),
      expect.objectContaining({ id: "call_acme_2", phase: "end", summary: "Operation not permitted", status: "failed" }),
      expect.objectContaining({ id: "call_acme_3", phase: "start", name: "apply_patch" }),
      expect.objectContaining({ id: "call_acme_3", phase: "end", name: "apply_patch", status: "completed" }),
    ]);
  });

  it("maps an exec approval request to a question with options", () => {
    const q = byType(run().turns, "question")[0]!;
    expect(q).toMatchObject({ id: "q-call_acme_2", phase: "start", prompt: "Run: rm -rf build (cleanup)?" });
    expect((q.options as { optionId: string; kind: string }[]).map((o) => [o.optionId, o.kind])).toEqual([
      ["approved", "allow_once"], ["approved_for_session", "allow_always"], ["denied", "reject_once"],
    ]);
  });

  it("summarizes very long output", () => {
    const row = (payload: object) => JSON.stringify({ timestamp: "2026-11-07T11:00:00Z", type: "response_item", payload }) + "\n";
    const file = Buffer.from(row({ type: "function_call", name: "shell", arguments: "{}", call_id: "c" }) + row({ type: "function_call_output", call_id: "c", output: "z".repeat(100_000) }));
    const r = reader.follow(serve(file, 0), initialCursor());
    assertValid(r.turns);
    expect(JSON.stringify(r.turns).length).toBeLessThan(2000);
  });
});

describe("plain-text fallback", () => {
  const reader = createPlainTextReader({ seatId: "seat-acme", now: () => new Date("2026-11-07T12:00:00Z") });

  it("detects any seat and produces text parts only", () => {
    expect(reader.detect({ id: "s", harness: "agy" })).toBe(true);
    const file = Buffer.from("hello acme\nsecond line ☕\n\nthird\npartial");
    const r = reader.follow(serve(file, 0, null as unknown as string), initialCursor());
    assertValid(r.turns);
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]!.parts.map((p) => p.type)).toEqual(["text"]);
    expect((r.turns[0]!.parts[0] as { text: string }).text).toBe("hello acme\nsecond line ☕\n\nthird");
    expect(r.cursor.offset).toBe(Buffer.byteLength("hello acme\nsecond line ☕\n\nthird\n"));
  });

  it("makes no turn from blank blocks and resumes after the cursor", () => {
    const a = reader.follow({ generationId: null, suffix: "\n\n", sinceBytes: 0 }, initialCursor());
    expect(a.turns).toEqual([]);
    expect(a.cursor.offset).toBe(2);
    const b = reader.follow({ generationId: null, suffix: "next\n", sinceBytes: 2 }, a.cursor);
    expect((b.turns[0]!.parts[0] as { text: string }).text).toBe("next");
  });
});

describe("reader selection", () => {
  const readers = createReaders({ seatId: "s" });
  it("picks by harness and falls back to plain text", () => {
    expect(selectReader({ id: "s", harness: "claude-code" }, readers).name).toBe("claude-jsonl");
    expect(selectReader({ id: "s", harness: "codex" }, readers).name).toBe("codex-rollout");
    expect(selectReader({ id: "s", harness: "agy" }, readers).name).toBe("plain-text");
    expect(selectReader({ id: "s", harness: "pi" }, readers).name).toBe("plain-text");
  });
});

describe("poison input ids", () => {
  const claude = createClaudeJsonlReader({ seatId: "seat-acme" });
  const codex = createCodexRolloutReader({ seatId: "seat-acme" });
  const names = ["toString", "__proto__", "constructor", "hasOwnProperty"];

  it("claude: inherited-property names as tool_use_id are plain unknown ids", () => {
    const rows = names.map((n) => JSON.stringify({ type: "user", uuid: `u-${n}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: n, content: "ok" }] } }));
    const file = Buffer.from(rows.join("\n") + "\n");
    const r = claude.follow(serve(file, 0), initialCursor());
    expect(r.skipped).toBe(0);
    expect(r.turns).toHaveLength(names.length);
    expect(r.cursor.offset).toBe(file.length);
  });

  it("codex: same for call ids", () => {
    const rows = names.map((n) => JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: n, output: "x" } }));
    const r = codex.follow(serve(Buffer.from(rows.join("\n") + "\n"), 0), initialCursor());
    expect(r.turns).toHaveLength(names.length);
    expect(byType(r.turns, "tool").every((p) => p.name === "tool")).toBe(true);
  });

  it("follow contains a throwing parser: the line is skipped and counted, the cursor advances", () => {
    const file = Buffer.from('{"a":1}\n{"a":2}\n{"a":3}\n');
    const r = followLines(serve(file, 0), initialCursor(), { seatId: "s" }, (v) => {
      if ((v as { a: number }).a === 2) throw new Error("boom");
      return [];
    });
    expect(r.skipped).toBe(1);
    expect(r.lines).toBe(3);
    expect(r.cursor.offset).toBe(file.length);
  });
});

describe("codex failure detection", () => {
  const codex = createCodexRolloutReader({ seatId: "seat-acme" });
  const status = (output: unknown) => {
    const row = (payload: object) => JSON.stringify({ type: "response_item", payload }) + "\n";
    const r = codex.follow(serve(Buffer.from(row({ type: "function_call", name: "shell", arguments: "{}", call_id: "c" }) + row({ type: "function_call_output", call_id: "c", output })), 0), initialCursor());
    return byType(r.turns, "tool").find((p) => p.phase === "end")!.status;
  };
  it("reads Process exited with code N", () => {
    expect(status("Chunk ID: a1\nWall time: 0.1 seconds\nProcess exited with code 2\nOutput:\nboom")).toBe("failed");
    expect(status("Process exited with code 0\nOutput:\nfine")).toBe("completed");
  });
  it("reads Exit code N and any non-zero", () => {
    expect(status("Exit code: 127\nWall time: 1 seconds\nOutput:\nnope")).toBe("failed");
    expect(status("Exit code: 0\nOutput:\nok")).toBe("completed");
  });
  it("prefers structured exit codes", () => {
    expect(status(JSON.stringify({ output: "x", metadata: { exit_code: 3 } }))).toBe("failed");
    expect(status(JSON.stringify({ output: "Process exited with code 0", metadata: { exit_code: 0 } }))).toBe("completed");
    expect(status({ content: "x", exit_code: 4 })).toBe("failed");
  });
});

describe("codex approval question lifecycle", () => {
  const codex = createCodexRolloutReader({ seatId: "seat-acme" });
  const ends = (turns: Turn[]) => byType(turns, "question").filter((p) => p.phase === "end");
  it("closes the question when its tool starts, with an unknown outcome", () => {
    const r = codex.follow(serve(fixture("codex-rollout.jsonl"), 0), initialCursor());
    assertValid(r.turns);
    const q = byType(r.turns, "question");
    expect(q.map((p) => p.phase)).toEqual(["start", "end"]);
    expect(q[1]).toMatchObject({ id: "q-call_acme_2", outcome: "unknown" });
    expect(r.cursor.pending).toBeUndefined();
  });
  it("closes a still-open question on task completion and when the tool completes", () => {
    const row = (type: string, payload: object) => JSON.stringify({ type, payload }) + "\n";
    const ask = row("event_msg", { type: "exec_approval_request", call_id: "k", command: ["ls"] });
    const done = codex.follow(serve(Buffer.from(ask + row("event_msg", { type: "task_complete" })), 0), initialCursor());
    expect(ends(done.turns)).toHaveLength(1);
    const split = codex.follow(serve(Buffer.from(ask), 0), initialCursor());
    expect(ends(split.turns)).toHaveLength(0);
    const out = Buffer.from(ask + row("response_item", { type: "function_call_output", call_id: "k", output: "x" }));
    const after = codex.follow(serve(out, Buffer.byteLength(ask)), split.cursor);
    expect(ends(after.turns)).toHaveLength(1);
  });
});
