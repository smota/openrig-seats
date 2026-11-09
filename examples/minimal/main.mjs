import { readFileSync } from "node:fs";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { PROTOCOL_VERSION } from "../../packages/seat-protocol/dist/index.js";
import { createApp } from "../../packages/seat-gateway/dist/server.js";
import { Store } from "../../packages/seat-gateway/dist/store.js";
import { createSeatUIHandler, startSeatUI } from "../../packages/seat-ui/server.mjs";

// Public fictional fixture value. Never use this bearer for a real deployment.
export const DEMO_BEARER = "fictional-demo-bearer";

/** Reuse the gateway's authenticated HTTP surface and cursor store without a daemon. */
export function createFixtureExample({ rootDir } = {}) {
  const store = new Store();
  const kinds = ["host", "rig", "seat", "turn", "attention", "work"];
  for (const kind of kinds) {
    const name = kind === "turn" ? "text" : "minimal";
    const path = new URL(`../../packages/seat-protocol/schemas/fixtures/valid/${kind}/${name}.json`, import.meta.url);
    const data = JSON.parse(readFileSync(path, "utf8"));
    store.apply({ kind, id: data.id, op: "upsert", data });
  }
  const capabilities = {
    protocol: { version: PROTOCOL_VERSION }, kinds, extensions: [], harnesses: [],
    features: { attention: true, work: true, snapshot: true, resume: true, act: false, terminal: false },
  };
  const app = createApp({ store, token: DEMO_BEARER, capabilities: async () => capabilities, enabledKinds: () => kinds });
  const handle = createSeatUIHandler({
    ...(rootDir ? { rootDir } : {}),
    fetch: (url, init) => app.fetch(new Request(url, init)),
  });
  return { app, store, handle };
}

const portNumber = (value, name) => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${name} must be an integer 0-65535`);
  return port;
};

/** Start only the example's two loopback HTTP servers. */
export async function startExample({ gatewayPort = 8088, uiPort = 5173 } = {}) {
  const { app } = createFixtureExample();
  const gateway = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: portNumber(gatewayPort, "GATEWAY_PORT") });
  let ui;
  const stop = async () => {
    await Promise.all([ui, gateway].filter(Boolean).map((server) => new Promise((done) => {
      server.closeAllConnections();
      server.close(done);
    })));
  };
  try {
    await once(gateway, "listening");
    const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
    ui = startSeatUI({ port: portNumber(uiPort, "PORT"), gatewayUrl });
    await once(ui, "listening");
    return { gatewayUrl, uiUrl: `http://127.0.0.1:${ui.address().port}`, stop };
  } catch (error) {
    await stop();
    if (error.code === "EADDRINUSE") {
      throw new Error(`port ${error.port} is in use; set ${ui ? "PORT" : "GATEWAY_PORT"} to an unused port.`);
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const example = await startExample({ gatewayPort: process.env.GATEWAY_PORT ?? 8088, uiPort: process.env.PORT ?? 5173 });
    console.error(`Fixture gateway: ${example.gatewayUrl}. Open ${example.uiUrl} and connect to /gateway.`);
    console.error("Use the public fictional demo bearer documented in examples/minimal/README.md. Ctrl-C stops both servers.");
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void example.stop(); });
  } catch (error) {
    console.error(`minimal example: ${error.message}`);
    process.exitCode = 1;
  }
}
