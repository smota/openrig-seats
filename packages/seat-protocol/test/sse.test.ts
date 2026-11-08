import { describe, expect, it } from "vitest";
import { parseSSE, type SSEMessage } from "../src/index.js";

function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}
async function all(chunks: string[]): Promise<SSEMessage[]> {
  const out: SSEMessage[] = [];
  for await (const m of parseSSE(bodyOf(chunks))) out.push(m);
  return out;
}

describe("parseSSE", () => {
  it("parses id, event and data", async () => {
    expect(await all(["id: 7\nevent: tick\ndata: {\"a\":1}\n\n"])).toEqual([{ event: "tick", data: '{"a":1}', lastEventId: "7" }]);
  });
  it("joins multi-line data and strips one leading space", async () => {
    expect((await all(["data: a\ndata:  b\n\n"]))[0]!.data).toBe("a\n b");
  });
  it("handles CRLF, CR, comments and chunks split anywhere", async () => {
    const msgs = await all([": hi\r\nid: 1\r\nda", "ta: x\r", "\n\r\ndata: y\r\r"]);
    expect(msgs.map((m) => [m.data, m.lastEventId])).toEqual([["x", "1"], ["y", "1"]]);
  });
  it("an empty chunk does not clear a pending CR", async () => {
    const msgs = await all(["data: a\r", "", "\ndata: b\n\n"]);
    expect(msgs.map((m) => m.data)).toEqual(["a\nb"]);
  });
  it("reports retry as soon as it is read, even in a block without data", async () => {
    const seen: number[] = [];
    const out: SSEMessage[] = [];
    for await (const m of parseSSE(bodyOf(["retry: 1500\n\n", "retry: nope\n\n"]), { onRetry: (ms) => seen.push(ms) })) out.push(m);
    expect(seen).toEqual([1500]);
    expect(out).toEqual([]);
  });
  it("cancels the underlying body when the consumer stops early", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(new TextEncoder().encode("data: x\n\n")); },
      cancel() { cancelled = true; },
    });
    for await (const _ of parseSSE(body)) break;
    expect(cancelled).toBe(true);
  });
  it("keeps the last id across messages and honours retry", async () => {
    const msgs = await all(["id: 1\ndata: a\n\ndata: b\nretry: 500\n\n"]);
    expect(msgs[1]).toEqual({ event: "message", data: "b", lastEventId: "1", retry: 500 });
  });
  it("drops an event without data and one cut off mid-event", async () => {
    expect(await all(["id: 1\n\n", "data: partial"])).toEqual([]);
  });
  it("strips a BOM and decodes UTF-8 split across chunks", async () => {
    const enc = new TextEncoder().encode("﻿data: café\n\n");
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.slice(0, 10)); c.enqueue(enc.slice(10)); c.close(); } });
    const out: SSEMessage[] = [];
    for await (const m of parseSSE(body)) out.push(m);
    expect(out[0]!.data).toBe("café");
  });
});

for (const [name, chunks, options] of [
  ["unterminated line", ["data: ", "ééé"], { maxLineBytes: 10 }],
  ["terminated line", ["data: abcdef\n\n"], { maxLineBytes: 10 }],
  ["event", ["data: ab\ndata: cd\n\n"], { maxEventBytes: 4 }],
] as const) {
  it(`rejects an oversized ${name} and cancels the source`, async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({ start(c) { for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk)); }, cancel() { cancelled = true; } });
    const consume = async () => { for await (const _ of parseSSE(source, options)) { /* consume */ } };
    await expect(consume()).rejects.toThrow(/limit/i);
    expect(cancelled).toBe(true);
  });
}
it("resets event limits and preserves normal multi-byte data", async () => {
  const messages = [];
  for await (const message of parseSSE(bodyOf(["data: é\n\ndata: ab\n\n"]), { maxLineBytes: 8, maxEventBytes: 2 })) messages.push(message.data);
  expect(messages).toEqual(["é", "ab"]);
});

it("keeps both line and event sizes unlimited when limits are omitted", async () => {
  const payload = "x".repeat(5 * 1024 * 1024);
  expect((await all([`data: ${payload}\n\n`]))[0]!.data).toBe(payload);
});
