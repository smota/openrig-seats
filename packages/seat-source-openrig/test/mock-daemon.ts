import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));

export interface RecordedPost {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  lastEventId: string | undefined;
  authorization: string | undefined;
  origin: string | undefined;
  at: number;
}

/**
 * A stand-in OpenRig daemon built from recorded-shape fixtures: /api/ps, /api/rigs/:id/nodes,
 * /api/attention, /api/queue/list, /healthz and /api/events (SSE with Last-Event-ID and replay=0).
 * It binds 127.0.0.1 only, like the real one, and refuses a foreign Origin.
 */
export class MockDaemon {
  ps: Array<Record<string, unknown>> = fixture("ps.json");
  nodes = new Map<string, Array<Record<string, unknown>>>([
    ["rig-acme-1", fixture("nodes-rig-acme-1.json")],
    ["rig-acme-2", fixture("nodes-rig-acme-2.json")],
  ]);
  attention: Record<string, unknown> = fixture("attention.json");
  queue: Array<Record<string, unknown>> = fixture("queue.json");
  /** POST /api/transport/send requests received, with every header. */
  readonly posts: RecordedPost[] = [];
  /** Answer to a send; default is a verified delivery. May be async (to hold a send open). */
  sendReply: (body: Record<string, unknown>) => { status: number; body: unknown } | { redirect: string } | Promise<{ status: number; body: unknown }> = (b) => ({
    status: 200,
    body: { ok: true, sessionName: b.session, outcome: "delivered", verified: true, sent: true },
  });
  /** Path prefixes answered with 404. */
  missing = new Set<string>();
  /** Path prefixes answered with 500. */
  broken = new Set<string>();
  readonly requests: RecordedRequest[] = [];
  log: Array<{ seq: number } & Record<string, unknown>> = [];
  nextSeq = 1;
  /** Process identity reported by /healthz; a restart with resetLog gives a new one. */
  pid = 4242;
  /** Delay before the events stream's headers are written (a daemon slow to subscribe). */
  openDelayMs = 0;
  /** When each events stream was opened (headers written). */
  readonly opens: number[] = [];
  url = "";
  private live = new Set<ServerResponse>();
  private server!: Server;
  private port = 0;

  async start(port = 0): Promise<this> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(port, "127.0.0.1", r));
    this.port = (this.server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${this.port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.dropStreams();
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  /** Simulates a daemon restart on the same port; `resetLog` models a database that starts over. */
  async restart(opts: { resetLog?: boolean } = {}): Promise<void> {
    await this.stop();
    if (opts.resetLog) {
      this.log = [];
      this.nextSeq = 1;
      this.pid++;
    }
    await this.start(this.port);
  }

  dropStreams(): void {
    for (const res of this.live) res.end();
    this.live.clear();
  }

  get streamCount(): number {
    return this.live.size;
  }

  /** Appends an event to the persisted log and pushes it to connected streams. */
  emit(event: Record<string, unknown>): number {
    const seq = this.nextSeq++;
    const full = { ...event, seq, createdAt: "2026-11-07T12:00:00.000Z" };
    this.log.push(full);
    for (const res of this.live) res.write(`id: ${seq}\ndata: ${JSON.stringify(full)}\n\n`);
    return seq;
  }

  /** Skips sequence numbers without logging them (a gap, as after a restart that lost history). */
  skipSeq(n: number): void {
    this.nextSeq += n;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    this.requests.push({
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.search,
      lastEventId: req.headers["last-event-id"] as string | undefined,
      authorization: req.headers.authorization,
      origin: req.headers.origin,
      at: Date.now(),
    });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.origin) return json(403, { error: "foreign origin" });
    if (req.method === "POST" && url.pathname === "/api/transport/send") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        this.posts.push({ path: url.pathname, headers: { ...req.headers }, body });
        void Promise.resolve(this.sendReply(body)).then((r) => {
          if ("redirect" in r) {
            res.writeHead(302, { location: r.redirect });
            res.end();
          } else json(r.status, r.body);
        });
      });
      return;
    }
    if (req.method !== "GET") return json(405, { error: "read only mock" });
    const p = url.pathname;
    for (const m of this.missing) if (p.startsWith(m)) return json(404, { error: "not found" });
    for (const b of this.broken) if (p.startsWith(b)) return json(500, { error: "broken" });

    if (p === "/healthz") return json(200, { status: "ok", semver: "0.0.0-mock", pid: this.pid });
    if (p === "/api/ps") return json(200, this.ps);
    const nodes = /^\/api\/rigs\/([^/]+)\/nodes$/.exec(p);
    if (nodes) {
      const list = this.nodes.get(decodeURIComponent(nodes[1]!));
      return list ? json(200, list) : json(404, { error: "rig not found" });
    }
    if (p === "/api/attention") return json(200, this.attention);
    if (p === "/api/queue/list") {
      const active = url.searchParams.get("activeOnly") === "1";
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      const rows = this.queue.filter((q) => !active || ["pending", "in-progress", "blocked"].includes(String(q.state)));
      return json(200, rows.slice(0, limit));
    }
    if (p === "/api/events") return this.events(req, res, url);
    return json(404, { error: "not found" });
  }

  private events(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (this.openDelayMs > 0) {
      const t = setTimeout(() => this.openStream(req, res, url), this.openDelayMs);
      req.on("close", () => clearTimeout(t));
      return;
    }
    this.openStream(req, res, url);
  }

  private openStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const header = req.headers["last-event-id"];
    const replay = url.searchParams.get("replay");
    let from: number;
    const newest = this.log[this.log.length - 1]?.seq ?? 0;
    if (header !== undefined) from = Number.parseInt(String(header), 10) || 0;
    else if (replay !== null && /^\d+$/.test(replay)) {
      const n = Number(replay);
      from = n === 0 ? newest : (this.log[this.log.length - n - 1]?.seq ?? 0);
    } else from = 0; // the real daemon replays the whole log here
    this.opens.push(Date.now());
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(": open\n\n");
    for (const e of this.log) if (e.seq > from) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
    this.live.add(res);
    req.on("close", () => this.live.delete(res));
  }
}
