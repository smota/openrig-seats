import { serve, type ServerType } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { PROTOCOL_VERSION, CORE_KINDS, OPENRIG_EVENT_KIND, OPENRIG_EXTENSION, OPENRIG_EXTENSION_VERSION, type Capabilities } from "@openrig-seats/seat-protocol";
import { DaemonClient, OpenRigSource, readSecretFile, type Features } from "@openrig-seats/seat-source-openrig";
import { isLoopbackBind, type GatewayConfig } from "./config.js";
import { SendAction, sendAction } from "./act.js";
import { IdempotencyTable } from "./idempotency.js";
import { createApp, TERMINAL_KEY_HEADER } from "./server.js";
import { TerminalBridge, terminalUpgradeUrl } from "./terminal.js";
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

/** Wires the OpenRig source to the store and the HTTP server. Never writes tmux, never opens the daemon's database. The only write is the optional `send` action over the daemon's transport route. */
export class Gateway {
  readonly store: Store;
  readonly source: OpenRigSource;
  private server: ServerType | null = null;
  private probedAt = 0;
  private activeStreams = 0;
  private streamsOpened = 0;
  private resets = 0;
  private readonly app;
  private readonly terminal: TerminalBridge | undefined;
  private readonly terminalKey = randomBytes(32).toString("hex");
  private readonly sendAction: SendAction | undefined;
  private readonly table: IdempotencyTable | undefined;

  constructor(private readonly opts: GatewayOptions) {
    const { config } = opts;
    if (!config.allowNonLoopback && !isLoopbackBind(config.listen.host)) throw new Error("refusing to bind a non-loopback address");
    const token = opts.token ?? readSecretFile(config.tokenFile, "gateway token");
    const daemonToken = opts.daemonToken ?? (config.daemonTokenFile ? readSecretFile(config.daemonTokenFile, "daemon token") : undefined);
    this.store = new Store(config.tombstoneLimit);
    const daemon = new DaemonClient({ baseUrl: config.daemonUrl, ...(daemonToken ? { token: daemonToken } : {}) });
    if (config.terminal.enabled) this.terminal = new TerminalBridge({
      config: config.terminal, daemon, daemonUrl: config.daemonUrl,
      ...(daemonToken ? { daemonToken } : {}),
      seats: () => this.store.items("seat") as Array<Record<string, unknown>>,
      synced: () => this.store.head() > 0,
    });
    const sendEnabled = config.act.send;
    if (sendEnabled) {
      if (!config.act.sender || !config.act.idempotencyFile) throw new Error("act.send needs act.sender and act.idempotencyFile");
      this.table = new IdempotencyTable(config.act.idempotencyFile, config.act.maxKeys, config.act.retentionDays * 86_400_000);
      this.sendAction = new SendAction({
        config: config.act,
        daemon,
        table: this.table,
        seats: () => this.store.items("seat") as Array<Record<string, unknown>>,
      });
    }
    this.source = new OpenRigSource({
      daemon,
      ...(sendEnabled ? { seatActions: [sendAction(config.act.maxLength)] } : {}),
      onChange: (c) => void this.store.apply(c),
      hostId: config.hostId,
      hostName: config.hostName,
      includeText: config.xOpenrig.includeText,
      eventReplay: config.xOpenrig.replay,
      ...(opts.log ? { log: opts.log } : {}),
      ...opts.source,
    });
    this.app = createApp({
      store: this.store,
      token,
      capabilities: () => this.capabilities(),
      enabledKinds: () => this.kinds(),
      ...(this.terminal ? { terminal: (id: string, signal?: AbortSignal) => this.terminal!.authorize(id, signal), terminalKey: this.terminalKey } : {}),
      ...(this.sendAction ? { act: (b: unknown) => this.sendAction!.handle(b) } : {}),
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
    return { terminalViewers: this.terminal?.activeViewers() ?? 0, activeStreams: this.activeStreams, streamsOpened: this.streamsOpened, resets: this.resets, entries: this.store.size(), head: this.store.head(), source: this.source.status() };
  }

  private kinds(): string[] {
    const f: Features = this.source.features();
    return [...CORE_KINDS.filter((k): k is Exclude<typeof k, "turn"> => k !== "turn" && f[k]), OPENRIG_EVENT_KIND];
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
    const terminal = await this.terminal?.enabled() ?? false;
    return {
      ...(terminal ? { terminal: { transport: "websocket" as const, path: "/terminal/{seatId}" as const, readOnly: true as const, output: "ansi-text" as const, clientFrames: ["scroll" as const], maxFrameBytes: this.opts.config.terminal.maxFrameBytes, maxViewers: this.opts.config.terminal.maxViewers } } : {}),
      protocol: { version: PROTOCOL_VERSION },
      kinds: this.kinds(),
      extensions: [OPENRIG_EXTENSION],
      extensionVersions: { [OPENRIG_EXTENSION]: OPENRIG_EXTENSION_VERSION },
      harnesses,
      ...(this.sendAction ? { actions: [{ kind: "seat", action: sendAction(this.opts.config.act.maxLength) }] } : {}),
      features: { attention: f.attention, work: f.work, snapshot: true, resume: true, act: this.sendAction !== undefined, terminal, "x-openrig.text": this.opts.config.xOpenrig.includeText },
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
    if (this.terminal) server.on("upgrade", (req, socket, head) => {
      this.terminal!.upgrade(req, socket, head, async (signal) => {
        const url = terminalUpgradeUrl(req.url ?? "/");
        if (!url) return new Response(null, { status: 404 });
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string" || Array.isArray(value)) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        headers.set(TERMINAL_KEY_HEADER, this.terminalKey);
        return this.app.fetch(new Request(url, { method: req.method ?? "GET", headers, signal }));
      });
    });
    else server.on("upgrade", (_req, socket) => { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy()); });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", () => resolve());
      server.once("error", reject);
    });
    const addr = server.address() as AddressInfo;
    return { host: listen.host, port: addr.port };
  }

  async stop(): Promise<void> {
    this.terminal?.stop();
    this.table?.close();
    await this.source.stop();
    const server = this.server as (ServerType & { closeAllConnections?: () => void }) | null;
    this.server = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
