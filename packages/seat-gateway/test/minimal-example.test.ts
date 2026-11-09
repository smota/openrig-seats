import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createFixtureExample, DEMO_BEARER, startExample } from "../../../examples/minimal/main.mjs";
import { readFrames } from "./helpers.js";

describe("minimal fixture example", () => {
  it("starts both servers on configured ports and routes the UI to the gateway", async () => {
    const example = await startExample({ gatewayPort: 0, uiPort: 0 });
    try {
      expect(example.gatewayUrl).not.toMatch(/:0$/);
      expect(example.uiUrl).not.toMatch(/:0$/);
      const response = await fetch(`${example.uiUrl}/gateway/snapshot`, { headers: { authorization: `Bearer ${DEMO_BEARER}` } });
      expect(response.status).toBe(200);
      expect((await response.json()).kinds.seat).toHaveLength(1);
    } finally {
      await example.stop();
    }
  });

  it.each(["GATEWAY_PORT", "PORT"])("fails with a one-line %s hint when that port is occupied", async (variable) => {
    const blocker = createServer();
    blocker.listen(0, "127.0.0.1");
    await once(blocker, "listening");
    const port = (blocker.address() as { port: number }).port;
    try {
      await expect(promisify(execFile)(process.execPath, [fileURLToPath(new URL("../../../examples/minimal/main.mjs", import.meta.url))], {
        env: { ...process.env, GATEWAY_PORT: "0", PORT: "0", [variable]: String(port) }, timeout: 4000,
      })).rejects.toMatchObject({
        code: 1,
        stderr: `minimal example: port ${port} is in use; set ${variable} to an unused port.\n`,
      });
    } finally {
      await new Promise<void>((done) => blocker.close(() => done()));
    }
  });

  it("serves the real gateway through seat-ui with auth, snapshot and cursor streaming", async () => {
    const { handle, store } = createFixtureExample({ rootDir: fileURLToPath(new URL("../../seat-ui", import.meta.url)) });
    const request = (path: string, headers: Record<string, string> = {}) =>
      handle(new Request(`http://127.0.0.1:5173${path}`, { headers }));
    const auth = { authorization: `Bearer ${DEMO_BEARER}` };
    const html = await request("/");
    expect(html.status).toBe(200);
    expect(await html.text()).toContain('<div id="app">');
    expect((await request("/gateway/snapshot")).status).toBe(401);
    expect((await request("/gateway/snapshot", { authorization: "Bearer wrong" })).status).toBe(401);
    const caps = await (await request("/gateway/capabilities", auth)).json();
    expect(caps.features).toMatchObject({ act: false, terminal: false, snapshot: true, resume: true });
    const snapshot = await (await request("/gateway/snapshot", auth)).json();
    expect(Object.keys(snapshot.kinds).sort()).toEqual(caps.kinds.toSorted());
    expect(snapshot.kinds.seat).toHaveLength(1);
    expect(snapshot.kinds.turn[0].seatId).toBe(snapshot.kinds.seat[0].id);
    expect(snapshot.kinds.seat[0].rigId).toBe(snapshot.kinds.rig[0].id);
    expect(snapshot.kinds.rig[0].hostId).toBe(snapshot.kinds.host[0].id);
    expect((await request("/gateway/snapshot", { ...auth, origin: "https://foreign.example.test" })).status).toBe(403);
    const frames = await readFrames(await request("/gateway/stream", auth), (f) => f.filter((x) => x.id).length === store.size());
    expect(frames.filter((f) => f.id)).toHaveLength(store.size());
    expect(frames.filter((f) => f.id).map((f) => JSON.parse(f.data).kind).sort()).toEqual(caps.kinds.toSorted());
    const updated = { ...snapshot.kinds.seat[0], state: "idle" };
    store.apply({ kind: "seat", id: updated.id, op: "upsert", data: updated });
    const resumed = await readFrames(await request("/gateway/stream", { ...auth, "last-event-id": snapshot.cursor }), (f) => f.some((x) => x.id !== undefined));
    expect(resumed.filter((f) => f.id).map((f) => JSON.parse(f.data))).toEqual([
      expect.objectContaining({ kind: "seat", data: updated }),
    ]);
    expect((await handle(new Request("http://127.0.0.1:5173/gateway/act", {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}",
    }))).status).toBe(405);
  });
});
