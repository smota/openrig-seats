import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockEnvelope { cursor: string; kind: string; id: string; op: "upsert" | "delete"; data?: object }

/** In-memory seat server: /capabilities, /stream (SSE with cursor resume) and /act (idempotent). */
export class MockSeatServer {
  readonly log: MockEnvelope[] = [];
  readonly streamRequests: Array<{ lastEventId: string | undefined; cursorQuery: string | null; auth: string | undefined }> = [];
  readonly actCalls: Array<{ key: string; body: Record<string, unknown> }> = [];
  actResults = new Map<string, object>();
  failActOnce = 0;
  private readonly live = new Set<ServerResponse>();
  private server!: Server;
  url = "";
  token: string | undefined;

  async start(token?: string): Promise<this> {
    this.token = token;
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.dropStreams();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Appends to the log and pushes to connected streams. */
  push(e: Omit<MockEnvelope, "cursor">): MockEnvelope {
    const env = { cursor: String(this.log.length + 1), ...e } as MockEnvelope;
    this.log.push(env);
    for (const res of this.live) res.write(this.frame(env));
    return env;
  }

  /** Writes raw SSE text to every open stream. */
  raw(text: string): void {
    for (const res of this.live) res.write(text);
  }

  /** Simulates a network drop on every open stream. */
  dropStreams(): void {
    for (const res of this.live) res.destroy();
    this.live.clear();
  }

  get openStreams(): number { return this.live.size; }

  private frame(e: MockEnvelope): string { return `id: ${e.cursor}\ndata: ${JSON.stringify(e)}\n\n`; }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://x");
    if (this.token && req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (url.pathname === "/capabilities" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        protocol: { version: "1.0" }, kinds: ["host", "rig", "seat", "turn", "attention", "work"],
        extensions: [], harnesses: ["claude-code"], features: { terminal: false },
      }));
      return;
    }
    if (url.pathname === "/stream" && req.method === "GET") return this.stream(req, res, url);
    if (url.pathname === "/act" && req.method === "POST") return this.act(req, res);
    res.writeHead(404).end();
  }

  private stream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const lastEventId = req.headers["last-event-id"] as string | undefined;
    this.streamRequests.push({ lastEventId, cursorQuery: url.searchParams.get("cursor"), auth: req.headers.authorization });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const after = Number(lastEventId ?? url.searchParams.get("cursor") ?? 0);
    res.write(": open\n\n");
    for (const e of this.log) if (Number(e.cursor) > after) res.write(this.frame(e));
    this.live.add(res);
    req.on("close", () => this.live.delete(res));
  }

  private act(req: IncomingMessage, res: ServerResponse): void {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      const key = String(body.idempotencyKey);
      this.actCalls.push({ key, body });
      if (this.failActOnce > 0) {
        this.failActOnce--;
        res.writeHead(503).end();
        return;
      }
      const seen = this.actResults.get(key);
      const reply = seen
        ? { ...seen, replayed: true }
        : { idempotencyKey: key, status: body.action === "nope" ? "rejected" : "completed", replayed: false,
            ...(body.action === "nope" ? { error: { code: "unknown_action", message: "No such action" } } : {}) };
      if (!seen) this.actResults.set(key, reply);
      res.writeHead(body.action === "nope" ? 409 : 200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    });
  }
}
