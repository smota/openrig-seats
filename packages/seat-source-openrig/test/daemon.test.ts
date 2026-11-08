import { describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon.js";

function clientWithEvent(data: string): DaemonClient {
  return new DaemonClient({
    baseUrl: "http://127.0.0.1:7433",
    fetch: async () => new Response(`id: 7\ndata: ${JSON.stringify({ seq: 7, type: "large", data })}\n\n`),
  });
}

describe("daemon events SSE limits", () => {
  it("preserves unlimited default parsing for a 2 MiB event", async () => {
    const data = "x".repeat(2 * 1024 * 1024);
    const events = [];
    for await (const event of clientWithEvent(data).events()) events.push(event);
    expect(events).toEqual([{ seq: 7, event: { seq: 7, type: "large", data } }]);
  });

  it("passes explicitly selected limits to the SSE parser", async () => {
    const read = async () => {
      for await (const _event of clientWithEvent("x".repeat(2048)).events({ limits: { maxEventBytes: 1024 } })) { /* exhaust the stream */ }
    };
    await expect(read()).rejects.toThrow("SSE event byte limit exceeded");
  });
});
