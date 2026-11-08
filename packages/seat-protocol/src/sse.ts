export class SSELimitError extends RangeError {}

/** One parsed server-sent event (WHATWG SSE field semantics, as EventSource exposes them). */
export interface SSEMessage {
  /** `event:` field; "message" when absent. */
  event: string;
  data: string;
  /** Last `id:` seen on this connection so far (EventSource's lastEventId); "" when none. */
  lastEventId: string;
  /** `retry:` in ms when the server sent a valid one. */
  retry?: number;
}

/**
 * Parses a byte stream into SSE messages: LF, CR and CRLF line ends, comments, multi-line data,
 * a leading BOM, ids that persist across messages, and the rule that an event without data is dropped.
 */
export interface ParseSSEOptions {
  /** Called as soon as a valid `retry:` field is read, including in blocks that carry no data. */
  onRetry?: (ms: number) => void;
  /** Maximum UTF-8 bytes per line, excluding its terminator. Default 1 MiB. */
  maxLineBytes?: number;
  /** Maximum UTF-8 bytes in joined event data. Default 4 MiB. */
  maxEventBytes?: number;
}

export async function* parseSSE(body: ReadableStream<Uint8Array>, options: ParseSSEOptions = {}): AsyncGenerator<SSEMessage> {
  const maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
  const maxEventBytes = options.maxEventBytes ?? 4 * 1024 * 1024;
  if (![maxLineBytes, maxEventBytes].every((n) => Number.isSafeInteger(n) && n > 0)) throw new RangeError("SSE limits must be positive integers");
  const encoder = new TextEncoder();
  let lineBytes = 0;
  let eventBytes = 0;
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let first = true;
  let lastEventId = "";
  let event = "";
  let data: string[] = [];
  let retry: number | undefined;
  let pendingCR = false;

  const flush = (): SSEMessage | null => {
    const had = data.length > 0;
    const msg: SSEMessage | null = had
      ? { event: event || "message", data: data.join("\n"), lastEventId, ...(retry !== undefined ? { retry } : {}) }
      : null;
    event = "";
    data = [];
    eventBytes = 0;
    retry = undefined;
    return msg;
  };

  const processLine = (line: string): SSEMessage | null => {
    if (line === "") return flush();
    if (line.startsWith(":")) return null;
    const idx = line.indexOf(":");
    const field = idx < 0 ? line : line.slice(0, idx);
    let value = idx < 0 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") {
      eventBytes += encoder.encode(value).byteLength + (data.length ? 1 : 0);
      if (eventBytes > maxEventBytes) throw new SSELimitError("SSE event byte limit exceeded");
      data.push(value);
    }
    else if (field === "id") {
      if (!value.includes("\0")) lastEventId = value;
    } else if (field === "retry" && /^\d+$/.test(value)) {
      retry = Number(value);
      options.onRetry?.(retry);
    }
    return null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Count raw bytes before decoding or retaining any unterminated text.
      for (const byte of value) {
        if (byte === 10 || byte === 13) lineBytes = 0;
        else if (++lineBytes > maxLineBytes) throw new SSELimitError("SSE line byte limit exceeded");
      }
      let text = decoder.decode(value, { stream: true });
      if (text.length === 0) continue; // an empty chunk changes nothing, in particular not a pending CR
      if (first) {
        text = text.replace(/^﻿/, "");
        first = false;
      }
      if (pendingCR && text.startsWith("\n")) text = text.slice(1);
      pendingCR = false;
      buffer += text;
      for (;;) {
        const m = /\r\n|\n|\r/.exec(buffer);
        if (!m) break;
        if (m[0] === "\r" && m.index === buffer.length - 1) {
          // A CR at the very end may be the first half of CRLF: take the line, skip a following LF.
          pendingCR = true;
        }
        const line = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        const msg = processLine(line);
        if (msg) yield msg;
      }
    }
    // A stream that ends mid-event never dispatches it (as EventSource).
  } finally {
    // Ending early (the consumer broke out, or an error): close the underlying connection.
    void reader.cancel().catch(() => {});
    reader.releaseLock?.();
  }
}
