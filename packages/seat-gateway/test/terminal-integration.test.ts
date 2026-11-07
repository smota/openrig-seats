import { createRequire } from "node:module";
import type { TerminalSocket } from "@openrig-seats/seat-source-openrig";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auth, MockDaemon, startGateway, waitFor, type Running } from "./helpers.js";

const Client = createRequire(import.meta.url)("ws") as new (url: string, options: { headers: Record<string, string> }) => TerminalSocket;
const terminal = { enabled: true, principal: "viewer@acme" };
let daemon: MockDaemon;
let running: Running | undefined;
let peers: TerminalSocket[];
beforeEach(async () => { peers = []; daemon = await new MockDaemon().start(); daemon.uiEnabled = true; });
afterEach(async () => { for (const peer of peers) peer.terminate(); await running?.stop(); running = undefined; await daemon?.stop(); });
async function start(config: Record<string, unknown> = {}) {
  running = await startGateway(daemon, { daemonToken: "daemon-secret" }, { terminal, ...config });
  await waitFor(() => running!.gateway.store.items("seat").length > 0);
  return running;
}
function connect(url: string, headers: Record<string, string> = auth) {
  const peer = new Client(url.replace(/^http/, "ws"), { headers });
  peers.push(peer);
  const output: string[] = [];
  peer.on("message", (data: Buffer) => output.push(data.toString()));
  peer.on("error", () => {});
  return { peer, output };
}

describe("terminal over a fake daemon", () => {
  it("proxies output and scroll only with fixed daemon authentication", async () => {
    const r = await start();
    const seat = r.gateway.store.items("seat")[0]!;
    const { peer, output } = connect(`${r.url}/terminal/${encodeURIComponent(String(seat.id))}`, { ...auth, "x-openrig-session": "attacker@acme", "x-openrig-occupant-generation": "spoofed" });
    await waitFor(() => output.length > 0);
    expect(output[0]).toBe(daemon.terminalSeed);
    for (const frame of [{ type: "keys", keys: ["Enter"] }, { type: "text", text: "secret" }, { type: "paste", text: "secret" }, { type: "resize", rows: 20, cols: 80, text: "secret" }]) peer.send(JSON.stringify(frame));
    peer.send(JSON.stringify({ type: "scroll", offset: 10, text: "secret" }));
    await waitFor(() => daemon.terminalFrames.length > 0);
    expect(daemon.terminalFrames).toEqual(['{"type":"scroll","offset":10}']);
    expect(daemon.terminalHeaders[0]).toMatchObject({ authorization: "Bearer daemon-secret", "x-openrig-session": "viewer@acme" });
    expect(daemon.terminalHeaders[0]?.["x-openrig-occupant-generation"]).toBeUndefined();
    expect(daemon.terminalHeaders[0]?.origin).toBeUndefined();
    expect(r.logs.join(" ")).not.toContain(daemon.terminalSeed);
    peer.terminate();
    await waitFor(() => r.gateway.stats().terminalViewers === 0 && daemon.terminalConnections.size === 0);
  });
  it("refuses terminal authorization after a partial initial load", async () => {
    const rig2 = JSON.parse(JSON.stringify(daemon.nodes.get("rig-acme-2")))[0].canonicalSessionName as string;
    daemon.broken.add("/api/rigs/rig-acme-2/nodes");
    const r = await start({ terminal: { ...terminal, principal: rig2 } });
    expect(r.gateway.stats().source.connected).toBe(false);
    const seat = r.gateway.store.items("seat")[0]!;
    const refused = await new Promise<string>((resolve) => {
      const { peer } = connect(`${r.url}/terminal/${encodeURIComponent(String(seat.id))}`);
      peer.on("error", (e: Error) => resolve(e.message));
      peer.on("open", () => resolve("open"));
    });
    expect(refused).toContain("403");
  });
  it("advertises only with both flags on and disables on probe failure", async () => {
    const r = await start();
    const caps = () => fetch(`${r.url}/capabilities`, { headers: auth }).then((res) => res.json());
    expect(await caps()).toMatchObject({ features: { terminal: true }, terminal: { readOnly: true, output: "ansi-text", clientFrames: ["scroll"] } });
    daemon.uiEnabled = false;
    expect((await caps()).features.terminal).toBe(false);
    expect((await caps()).terminal).toBeUndefined();
    daemon.broken.add("/api/config");
    expect((await caps()).features.terminal).toBe(false);
    await r.stop(); running = undefined;
    const disabled = await start({ terminal: { enabled: false } });
    expect((await fetch(`${disabled.url}/capabilities`, { headers: auth }).then((res) => res.json())).features.terminal).toBe(false);
    expect((await fetch(`${disabled.url}/terminal/s1`, { headers: auth })).status).toBe(404);
  });
  it("bounds viewers, closes oversized output, and releases the slot", async () => {
    const r = await start({ terminal: { ...terminal, maxViewers: 1, maxFrameBytes: 128 } });
    const seat = r.gateway.store.items("seat")[0]!;
    const url = `${r.url}/terminal/${encodeURIComponent(String(seat.id))}`;
    const first = connect(url);
    await waitFor(() => first.output.length > 0);
    const refused = connect(url);
    const status = await new Promise<number>((resolve) => { refused.peer.on("unexpected-response", (_req: unknown, res: { statusCode: number; resume(): void }) => { res.resume(); resolve(res.statusCode); }); });
    expect(status).toBe(503);
    for (const upstream of daemon.terminalConnections) upstream.send("x".repeat(129));
    await waitFor(() => r.gateway.stats().terminalViewers === 0);
    const next = connect(url);
    await waitFor(() => next.output.length > 0);
    expect(r.gateway.stats().terminalViewers).toBe(1);
  });
  it("never follows a daemon WebSocket redirect", async () => {
    const r = await start();
    daemon.terminalRedirect = "http://127.0.0.1:1/steal";
    const seat = r.gateway.store.items("seat")[0]!;
    const c = connect(`${r.url}/terminal/${encodeURIComponent(String(seat.id))}`);
    await waitFor(() => daemon.terminalHeaders.length === 1);
    await waitFor(() => r.gateway.stats().terminalViewers === 0);
    expect(c.output).toEqual([]);
  });
});
