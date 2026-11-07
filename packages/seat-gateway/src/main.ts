#!/usr/bin/env node
import { Gateway } from "./gateway.js";
import { loadConfig } from "./config.js";

function configPath(argv: string[]): string {
  const i = argv.indexOf("--config");
  const p = i >= 0 ? argv[i + 1] : process.env.SEAT_GATEWAY_CONFIG;
  if (!p) throw new Error("usage: seat-gateway --config <file>  (or SEAT_GATEWAY_CONFIG)");
  return p;
}

async function main(): Promise<void> {
  const config = loadConfig(configPath(process.argv.slice(2)));
  const gateway = new Gateway({ config, log: (m) => console.error(`seat-gateway: ${m}`) });
  const addr = await gateway.start();
  console.error(`seat-gateway: listening on http://${addr.host.includes(":") ? `[${addr.host}]` : addr.host}:${addr.port} (read-only)`);
  const stop = () => void gateway.stop().finally(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(`seat-gateway: ${err instanceof Error ? err.message : "failed to start"}`);
  process.exit(1);
});
