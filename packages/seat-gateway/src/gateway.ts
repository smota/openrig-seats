import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { PROTOCOL_VERSION, CORE_KINDS, type Capabilities } from "@openrig-seats/seat-protocol";
import { DaemonClient, OpenRigSource, readSecretFile, type Features } from "@openrig-seats/seat-source-openrig";
import { isLoopbackBind, type GatewayConfig } from "./config.js";
import { createApp } from "./server.js";
import { Store } from "./store.js";

export interface GatewayOptions {
  config: GatewayConfig;
  /** Tests inject a token; the CLI reads it from config.tokenFile. */
  token?: string;
  daemonToken?: string;
  /** How long a capabilities probe is reused. Default 30000. */
  probeTtlMs?: number;
  /** Source tuning, for tests. */
  source?: { debounceMs?: number; reconnectMinMs?: number; reconnectMaxMs?: number; resyncIntervalMs?: number };
  heartbeatMs?: number;
  writeTimeoutMs?: number;
  log?: (message: string) => void;
}

/** Wires the OpenRig source to the store and the HTTP server. Never writes tmux, never opens the daemon's database. */
export class Gateway {
  readonly store: Store;
  readonly source: OpenRigSource;
  private server: ServerType | null = null;
  private probedAt = 0;
  private activeStreams = 0;
  private streamsOpened = 0;
  private resets = 0;
  private readonly app;

  constructor(private readonly opts: GatewayOptions) {
    const { config } = opts;
    if (!config.allowNonLoopback && !isLoopbackBind(config.listen.host)) throw new Error("refusing to bind a non-loopback address");
    const token = opts.token ?? readSecretFile(config.tokenFile, "gateway token");
    const daemonToken = opts.daemonToken ?? (config.daemonTokenFile ? readSecretFile(config.daemonTokenFile, "daemon token") : undefined);
    this.store = new Store(config.tombstoneLimit);
    this.source = new OpenRigSource({
      daemon: new DaemonClient({ baseUrl: config.daemonUrl, ...(daemonToken ? { token: daemonToken } : {}) }),
      onChange: (c) => void this.store.apply(c),
      hostId: config.hostId,
      hostName: config.hostName,
      ...(opts.log ? { log: opts.log } : {}),
      ...opts.source,
    });
    this.app = createApp({
      store: this.store,
      token,
      capabilities: () => this.capabilities(),
      enabledKinds: () => this.kinds(),
      allowedOrigins: config.allowedOrigins,
      allowedHosts: config.allowedHosts,
      ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
      ...(opts.writeTimeoutMs !== undefined ? { writeTimeoutMs: opts.writeTimeoutMs } : {}),
      onStream: (event, info) => {
        if (event === "open") {
          this.activeStreams++;
          this.streamsOpened++;
          if (info.reset) this.resets++;
        } else this.activeStreams--;
      },
    });
  }

  get fetch() {
    return this.app.fetch;
  }

  stats() {
    return { activeStreams: this.activeStreams, streamsOpened: this.streamsOpened, resets: this.resets, entries: this.store.size(), head: this.store.head(), source: this.source.status() };
  }

  private kinds(): string[] {
    const f: Features = this.source.features();
    return CORE_KINDS.filter((k): k is Exclude<typeof k, "turn"> => k !== "turn" && f[k]);
  }

  /** Features are probed against the daemon (a 404 turns one off) and the answer is reused for a while. */
  async capabilities(): Promise<Capabilities> {
    const ttl = this.opts.probeTtlMs ?? 30_000;
    if (Date.now() - this.probedAt > ttl) {
      try {
        await this.source.probe();
        this.probedAt = Date.now();
      } catch {
        /* daemon unreachable: keep the previous answer */
      }
    }
    const f = this.source.features();
    const harnesses = [...new Set(this.store.items("seat").map((s) => s.harness).filter((h): h is string => typeof h === "string"))].sort();
    return {
      protocol: { version: PROTOCOL_VERSION },
      kinds: this.kinds(),
      extensions: [],
      harnesses,
      features: { attention: f.attention, work: f.work, snapshot: true, resume: true, act: false, terminal: false },
    };
  }

  async start(): Promise<{ host: string; port: number }> {
    const { listen } = this.opts.config;
    try {
      await this.source.probe();
      this.probedAt = Date.now();
    } catch {
      this.opts.log?.("daemon not reachable at start; features assumed on until it answers");
    }
    this.source.start();
    const server = serve({ fetch: this.app.fetch, hostname: listen.host, port: listen.port });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    const addr = server.address() as AddressInfo;
    return { host: listen.host, port: addr.port };
  }

  async stop(): Promise<void> {
    await this.source.stop();
    const server = this.server as (ServerType & { closeAllConnections?: () => void }) | null;
    this.server = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
