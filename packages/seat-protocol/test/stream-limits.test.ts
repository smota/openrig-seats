import { expect, it } from "vitest";
import { createSeatClient } from "../src/index.js";

function clientWithPayload(payload: string) {
  const envelope = { cursor: "1", kind: "seat", id: "large", op: "upsert", data: { payload } };
  return createSeatClient({ baseUrl: "http://source.test", maxAttempts: 1,
    fetch: async () => new Response(`data: ${JSON.stringify(envelope)}\n\n`) });
}

it("SeatClient.stream parses a 2 MiB event without limits by default", async () => {
  const payload = "x".repeat(2 * 1024 * 1024);
  const stream = clientWithPayload(payload).stream();
  try { expect((await stream.next()).value).toMatchObject({ data: { payload } }); }
  finally { await stream.return(undefined); }
});

it("SeatClient.stream passes opt-in line and event limits through", async () => {
  const client = clientWithPayload("x".repeat(256));
  await expect(client.stream({ maxLineBytes: 128 }).next()).rejects.toThrow(/line byte limit/);
  await expect(client.stream({ maxEventBytes: 128 }).next()).rejects.toThrow(/event byte limit/);
});
