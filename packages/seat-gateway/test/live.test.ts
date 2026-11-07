// Opt-in live check: GET requests only, skipped unless OPENRIG_SEATS_LIVE=1.
// OPENRIG_SEATS_LIVE_URL is the daemon (a literal loopback IP; default http://127.0.0.1:7433).
// OPENRIG_SEATS_LIVE_TOKEN_FILE (optional) is a 0600 file with the daemon's bearer token; its value is never printed.
// Prefer a daemon started on a temporary OPENRIG_HOME.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { DaemonClient, OpenRigSource, readSecretFile, type Change } from "@openrig-seats/seat-source-openrig";
import { describe, expect, it } from "vitest";
import { Gateway, parseConfig } from "../src/index.js";

const enabled = process.env.OPENRIG_SEATS_LIVE === "1";
const url = process.env.OPENRIG_SEATS_LIVE_URL ?? "http://127.0.0.1:7433";
const tokenFile = process.env.OPENRIG_SEATS_LIVE_TOKEN_FILE;

const schemaDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../seat-protocol/schemas");
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
addFormats.default(ajv);
for (const f of readdirSync(schemaDir).filter((x) => x.endsWith(".v1.schema.json"))) ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, f), "utf8")));

describe.skipIf(!enabled)("live daemon (GET only)", () => {
  const token = enabled && tokenFile ? readSecretFile(tokenFile, "daemon token") : undefined;

  it("a snapshot read maps to valid protocol items", async () => {
    const changes: Change[] = [];
    const source = new OpenRigSource({ daemon: new DaemonClient({ baseUrl: url, ...(token ? { token } : {}) }), onChange: (c) => changes.push(c) });
    const features = await source.probe();
    await source.resync();
    expect(changes.find((c) => c.kind === "host")?.data?.state).toBe("online");
    for (const c of changes) {
      if (c.op !== "upsert") continue;
      const v = ajv.getSchema(`https://smota.github.io/openrig-seats/schemas/${c.kind}.v1.schema.json`)!;
      expect(v(c.data), `${c.kind}: ${JSON.stringify(v.errors)}`).toBe(true);
    }
    console.info(`live: features ${JSON.stringify(features)}; ${changes.length} items`);
  });

  it("the gateway serves capabilities and snapshots from it", async () => {
    const gw = new Gateway({
      config: parseConfig({ daemonUrl: url, tokenFile: "unused", listen: { host: "127.0.0.1", port: 0 } }),
      token: "live-test-token",
      ...(token ? { daemonToken: token } : {}),
    });
    const addr = await gw.start();
    try {
      const h = { authorization: "Bearer live-test-token" };
      const caps = await (await fetch(`http://${addr.host}:${addr.port}/capabilities`, { headers: h })).json();
      expect(caps.protocol.version).toBe("1.0");
      expect(caps.features.act).toBe(false);
      const res = await fetch(`http://${addr.host}:${addr.port}/snapshot/host`, { headers: h });
      expect(res.status).toBe(200);
    } finally {
      await gw.stop();
    }
  });
});
