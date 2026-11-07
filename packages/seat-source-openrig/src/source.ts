import { DaemonClient, DaemonError, type DaemonEvent } from "./daemon.js";
import { isoOrUndefined, mapAttention, mapEvent, mapRig, mapSeat, mapWork, WORK_ACTIVE, type EventRecord } from "./map.js";
import { QUEUE_PAGE, ROUTES } from "./routes.js";
import type { Change, ExtensionKind, Features, Json, SourceKind } from "./types.js";

export interface SourceOptions {
  daemon: DaemonClient;
  onChange: (change: Change) => void;
  hostId?: string;
  hostName?: string;
  now?: () => Date;
  /** Delay before a burst of events is turned into daemon reads. Default 200. */
  debounceMs?: number;
  /** Full resync even without a gap, as a drift backstop. Default 300000; 0 disables. */
  resyncIntervalMs?: number;
  /**
   * Include the daemon's free text (held reason, error text, prompt reason or summary, event summaries) in the
   * `x-openrig` extension. Off by default: that text may hold message content or credentials.
   */
  includeText?: boolean;
  /** Declared actions attached to every seat item (the gateway passes its enabled actions). */
  seatActions?: Array<Record<string, unknown>>;
  /** Events asked for on a cold start (newest N of ALL daemon event types, not only the mapped ones). Default 2000. */
  eventReplay?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** A failed refresh is retried after this long, doubling up to retryMaxMs. Defaults 500 and 30000. */
  retryMinMs?: number;
  retryMaxMs?: number;
  /** Diagnostics only: never receives secrets. */
  log?: (message: string) => void;
}

export interface SourceStatus {
  connected: boolean;
  lastSeq: number | null;
  resyncs: number;
  reconnects: number;
  /** True once one full resync read every rig's seats; stays true after a later failure (last-known seats). */
  seatsSynced: boolean;
}

/** Newest events kept for `x-openrig.event`; older ones are deleted. */
export const EVENT_RING_CAP = 200;
export const DEFAULT_EVENT_REPLAY = 2000;
const EVENT_KIND: ExtensionKind = "x-openrig.event";

const KINDS: SourceKind[] = ["host", "rig", "seat", "attention", "work"];
const key = (k: string, id: string) => `${k}\u0000${id}`;
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * Turns daemon snapshots plus the events stream into protocol changes (upserts and deletes). The raw
 * answers are cached; every change recomputes the full projection and emits only the difference, so
 * a resync after a restart deletes what vanished and a repeated read emits nothing.
 */
export class OpenRigSource {
  private readonly daemon: DaemonClient;
  private readonly hostId: string;
  private readonly hostName: string;
  private readonly now: () => Date;
  private readonly debounceMs: number;
  private readonly opts: SourceOptions;

  private ctl = new AbortController();
  private running: Promise<void> | null = null;
  private streamCtl: AbortController | null = null;

  private feat: Features = { host: true, rig: true, seat: true, attention: true, work: true };
  private connected = false;
  private everContacted = false;
  private seatsSynced = false;
  private failedOnce = false;
  private degraded = false;
  /** Sets that came back as a full page: they may be incomplete, so nothing is deleted from them. */
  private partial = new Set<SourceKind>();
  /** What identifies the daemon's process (healthz pid), to tell a restarted daemon from a dropped link. */
  private identity: string | undefined;
  private version: string | undefined;
  private lastSeq: number | null = null;
  private resyncs = 0;
  private reconnects = 0;

  private psRaw: Json[] = [];
  private nodesRaw = new Map<string, Json[]>();
  private attentionRaw: Json[] = [];
  private queueRaw: Json[] = [];
  private eventsRaw: EventRecord[] = [];
  /** Seats currently inside a needs_input episode, by session, with the reason that opened it. */
  private promptEpisodes = new Map<string, string>();

  private emitted = new Map<string, { sig: string; data: Json }>();

  private dirtyPs = false;
  private dirtyNodes = new Set<string>();
  private dirtyAttention = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = 0;

  constructor(opts: SourceOptions) {
    this.opts = opts;
    this.daemon = opts.daemon;
    this.hostId = opts.hostId ?? "local";
    this.hostName = opts.hostName ?? "openrig";
    this.now = opts.now ?? (() => new Date());
    this.debounceMs = opts.debounceMs ?? 200;
  }

  features(): Features {
    return { ...this.feat };
  }

  status(): SourceStatus {
    return { connected: this.connected, lastSeq: this.lastSeq, resyncs: this.resyncs, reconnects: this.reconnects, seatsSynced: this.seatsSynced };
  }

  /** Current projection per kind (the source's own mirror, used by tests and the gateway's first snapshot). */
  current(kind: SourceKind | ExtensionKind): Json[] {
    return [...this.emitted.entries()].filter(([k]) => k.startsWith(kind + "\u0000")).map(([, v]) => v.data);
  }

  /**
   * Asks the daemon which routes exist. A 404 (or 405/410) turns the feature off; any other answer
   * keeps it on. A network error leaves the previous answer in place and rethrows.
   */
  async probe(): Promise<Features> {
    const off = (s: number) => s === 404 || s === 405 || s === 410;
    // The rig ids come from the answer to /api/ps given now, never from a cache: rigs that vanished since
    // would 404 on /nodes and say nothing about the route.
    let rigs: string[] = [];
    try {
      const body = await this.daemon.getJson(ROUTES.ps, this.ctl.signal);
      this.feat.rig = this.feat.host = true;
      rigs = (Array.isArray(body) ? (body as Json[]) : []).map((r) => r.rigId).filter((x): x is string => typeof x === "string");
    } catch (err) {
      if (!(err instanceof DaemonError) || err.status === undefined) throw err;
      this.feat.rig = this.feat.host = !off(err.status);
    }
    this.feat.attention = !off(await this.daemon.status(ROUTES.attention, this.ctl.signal));
    this.feat.work = !off(await this.daemon.status(ROUTES.queueProbe, this.ctl.signal));
    // A 404 for one rig means that rig is gone, not that the route is: only when every rig in the current
    // listing answers 404 is the route treated as missing.
    if (rigs.length === 0) this.feat.seat = this.feat.rig;
    else {
      let anyAnswer = false;
      for (const id of rigs) {
        if (!off(await this.daemon.status(ROUTES.nodes(id), this.ctl.signal))) {
          anyAnswer = true;
          break;
        }
      }
      this.feat.seat = anyAnswer;
    }
    return this.features();
  }

  /** Starts following the daemon. Returns immediately; call stop() to end. */
  start(): void {
    if (this.running) return;
    this.ctl = new AbortController();
    this.running = this.loop();
  }

  async stop(): Promise<void> {
    this.ctl.abort();
    this.streamCtl?.abort();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.flushTimer = null;
    this.retryTimer = null;
    await this.running?.catch(() => {});
    await this.flushing.catch(() => {});
    this.running = null;
  }

  /** Reads every enabled route and publishes the difference. Public for tests and the gateway's first load. */
  async resync(signal: AbortSignal = this.ctl.signal): Promise<void> {
    this.resyncs++;
    await this.refreshPs(signal);
    if (this.feat.seat && this.feat.rig) await this.refreshNodes([...this.psIds()], signal);
    if (this.feat.attention) await this.refreshAttention(signal);
    if (this.feat.work) await this.refreshQueue(signal);
    this.markOnline();
    this.publish();
    // Only after the complete projection is in the store (same tick): every await above can still throw.
    this.seatsSynced = true;
  }

  // ---- main loop ----

  private async loop(): Promise<void> {
    const min = this.opts.reconnectMinMs ?? 250;
    const max = this.opts.reconnectMaxMs ?? 10_000;
    let failures = 0;
    const signal = this.ctl.signal;
    while (!signal.aborted) {
      const conn = new AbortController();
      this.streamCtl = conn;
      const onAbort = () => conn.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      let timer: ReturnType<typeof setInterval> | undefined;
      try {
        // A restarted daemon has a new log: its sequence numbers say nothing about ours. When its process
        // identity differs, forget the sequence so the stream opens fresh.
        await this.checkIdentity(conn.signal);
        let opened!: () => void;
        const isOpen = new Promise<void>((resolve) => (opened = resolve));
        const events = this.daemon.events({ lastSeq: this.lastSeq, replay: this.opts.eventReplay ?? DEFAULT_EVENT_REPLAY, signal: conn.signal, onOpen: () => opened() });
        const iterator = events[Symbol.asyncIterator]();
        const first = iterator.next();
        // Attach a no-op catch so a failure while we are still snapshotting is surfaced later, not unhandled.
        first.catch(() => {});
        // The snapshot is read only once the daemon has accepted the stream: with replay=0 a change made
        // before that point would be in neither. Events after it are applied once the snapshot is in.
        await Promise.race([isOpen, first.then(() => undefined)]);
        // Every (re)connect reads everything again: events cannot tell a dropped link from a daemon that
        // restarted with an equal or lower sequence and no new events.
        await this.resync(conn.signal);
        const every = this.opts.resyncIntervalMs ?? 300_000;
        if (every > 0) timer = setInterval(() => this.queueFullResync(), every);
        failures = 0;
        let pending: Promise<IteratorResult<DaemonEvent>> = first;
        for (;;) {
          const r = await pending;
          if (r.done) break;
          const resync = this.accept(r.value);
          if (resync) await this.resync(conn.signal);
          pending = iterator.next();
        }
        throw new DaemonError("events stream ended");
      } catch (err) {
        if (signal.aborted) break;
        this.connected = false;
        this.reconnects++;
        this.opts.log?.(`daemon link lost (${err instanceof Error ? err.message : "error"}); retrying`);
        this.markOffline();
      } finally {
        if (timer) clearInterval(timer);
        signal.removeEventListener("abort", onAbort);
        conn.abort();
      }
      failures++;
      await sleep(Math.min(max, min * 2 ** (failures - 1)), signal);
    }
  }

  private async readHealth(signal: AbortSignal): Promise<void> {
    try {
      const h = (await this.daemon.getJson(ROUTES.health, signal)) as Json;
      const v = h.semver ?? h.version;
      if (typeof v === "string") this.version = v;
      const id = [h.pid, h.startedAt, h.bootId].filter((x) => x !== undefined && x !== null).join(":");
      if (id) this.identity = id;
    } catch {
      /* optional: a daemon without /healthz identity relies on the full resync at every connect */
    }
  }

  private async checkIdentity(signal: AbortSignal): Promise<void> {
    const before = this.identity;
    await this.readHealth(signal);
    if (before !== undefined && this.identity !== undefined && before !== this.identity) {
      this.opts.log?.("daemon restarted; event sequence forgotten");
      this.lastSeq = null;
      this.clearEvents();
    }
  }

  /** Returns true when the sequence says events were missed or the daemon's log restarted. */
  private accept(ev: DaemonEvent): boolean {
    const prev = this.lastSeq;
    let resync = false;
    if (prev !== null) {
      if (ev.seq === prev) return false; // duplicate delivery
      if (ev.seq < prev) {
        resync = true; // the log restarted: nothing we hold is trustworthy
        this.clearEvents();
      } else if (ev.seq > prev + 1) {
        resync = true; // a gap
      }
    }
    this.lastSeq = ev.seq;
    this.keepEvent(ev.seq, ev.event);
    this.handleEvent(ev.event);
    return resync;
  }

  private clearEvents(): void {
    this.eventsRaw = [];
    this.promptEpisodes.clear();
  }

  /**
   * Keeps the event in the bounded `x-openrig.event` ring when it is one of the mapped types. A prompt is
   * emitted once per episode: the seat leaving needs_input ends it, so the next prompt is new.
   */
  private keepEvent(seq: number, e: DaemonEvent["event"]): void {
    if (e.type === "agent.activity") {
      const session = typeof e.sessionName === "string" ? e.sessionName : "";
      const a = typeof e.activity === "object" && e.activity !== null ? (e.activity as Json) : {};
      if (session && a.state !== "needs_input") this.promptEpisodes.delete(session);
      else if (session) {
        const reason = typeof a.reason === "string" ? a.reason : "";
        if (this.promptEpisodes.get(session) === reason) return;
        this.promptEpisodes.set(session, reason);
      }
    }
    const rec = mapEvent(seq, e, this.opts.includeText === true);
    if (!rec) return;
    this.eventsRaw.push(rec);
    while (this.eventsRaw.length > EVENT_RING_CAP) this.eventsRaw.shift();
    this.publish();
  }

  private queueFullResync(): void {
    this.dirtyPs = true;
    for (const id of this.psIds()) this.dirtyNodes.add(id);
    this.dirtyAttention = true;
    this.schedule();
  }

  // ---- events ----

  private handleEvent(e: DaemonEvent["event"]): void {
    const type = typeof e.type === "string" ? e.type : "";
    const rigId = typeof e.rigId === "string" ? e.rigId : undefined;
    const nodeId = typeof e.nodeId === "string" ? e.nodeId : undefined;

    if (type === "rig.deleted" && rigId) {
      this.psRaw = this.psRaw.filter((r) => r.rigId !== rigId);
      this.nodesRaw.delete(rigId);
      this.publish();
      return;
    }
    if (type === "node.removed" && rigId && nodeId) {
      const list = this.nodesRaw.get(rigId);
      if (list) this.nodesRaw.set(rigId, list.filter((n) => n.nodeId !== nodeId));
      this.publish();
      this.dirtyPs = true; // seatCount
      this.schedule();
      return;
    }
    if (type === "agent.activity" && rigId && nodeId && typeof e.activity === "object" && e.activity !== null) {
      const node = this.nodesRaw.get(rigId)?.find((n) => n.nodeId === nodeId);
      if (node) {
        node.agentActivity = e.activity as Json;
        node.arbitratedNeedsInput = null;
        this.publish();
      }
      this.dirtyNodes.add(rigId); // the daemon's own arbitration is authoritative
      this.schedule();
      return;
    }
    if (/^(rig|bootstrap)\./.test(type) || type === "node.added" || type.startsWith("session.")) {
      this.dirtyPs = true;
      if (rigId) this.dirtyNodes.add(rigId);
      this.schedule();
      return;
    }
    if (rigId && /^(node|seat|agent|binding|continuity)\./.test(type)) {
      this.dirtyNodes.add(rigId);
      this.schedule();
      return;
    }
    if (/^(queue|qitem|inbox)\./.test(type)) {
      this.dirtyAttention = true;
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.flushTimer || this.ctl.signal.aborted) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushing = this.flushing.then(() => this.flush()).catch(() => {});
    }, this.debounceMs);
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.ctl.signal.aborted) return;
    const min = this.opts.retryMinMs ?? 500;
    const max = this.opts.retryMaxMs ?? 30_000;
    this.retryMs = this.retryMs === 0 ? min : Math.min(max, this.retryMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.flushing = this.flushing.then(() => this.flush()).catch(() => {});
    }, this.retryMs);
  }

  private async flush(): Promise<void> {
    const signal = this.ctl.signal;
    if (signal.aborted) return;
    const ps = this.dirtyPs;
    const nodes = [...this.dirtyNodes];
    const att = this.dirtyAttention;
    this.dirtyPs = false;
    this.dirtyNodes.clear();
    this.dirtyAttention = false;
    try {
      if (ps) await this.refreshPs(signal);
      if (nodes.length && this.feat.seat && this.feat.rig) await this.refreshNodes(nodes.filter((id) => this.psIds().has(id)), signal);
      if (att) {
        if (this.feat.attention) await this.refreshAttention(signal);
        if (this.feat.work) await this.refreshQueue(signal);
      }
      this.markOnline();
      this.publish();
      this.retryMs = 0;
      if (this.retryTimer && !this.dirtyPs && !this.dirtyNodes.size && !this.dirtyAttention) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
    } catch (err) {
      if (signal.aborted) return;
      // Keep the dirt until a refresh succeeds, and retry on a bounded backoff that needs neither a new
      // event nor the periodic resync.
      this.dirtyPs ||= ps;
      for (const id of nodes) this.dirtyNodes.add(id);
      this.dirtyAttention ||= att;
      this.opts.log?.(`refresh failed (${err instanceof Error ? err.message : "error"}); will retry`);
      this.scheduleRetry();
    }
  }

  // ---- reads ----

  private psIds(): Set<string> {
    return new Set(this.psRaw.map((r) => r.rigId).filter((x): x is string => typeof x === "string"));
  }

  private async read(path: string, feature: SourceKind, signal: AbortSignal, disableOn404 = true): Promise<unknown | undefined> {
    try {
      return await this.daemon.getJson(path, signal);
    } catch (err) {
      if (err instanceof DaemonError && err.status !== undefined && (err.status === 404 || err.status === 405 || err.status === 410)) {
        if (disableOn404) this.feat[feature] = false; // a missing route turns the feature off
        return undefined;
      }
      throw err;
    }
  }

  private async refreshPs(signal: AbortSignal): Promise<void> {
    if (!this.feat.rig) {
      this.psRaw = [];
      return;
    }
    const body = await this.read(ROUTES.ps, "rig", signal);
    if (body === undefined) {
      this.psRaw = [];
      return;
    }
    this.psRaw = Array.isArray(body) ? (body as Json[]) : [];
    for (const id of [...this.nodesRaw.keys()]) if (!this.psIds().has(id)) this.nodesRaw.delete(id);
    if (!this.version) await this.readHealth(signal); // best effort, until known
  }

  private async refreshNodes(rigIds: string[], signal: AbortSignal): Promise<void> {
    for (const rigId of rigIds) {
      // A 404 for one rig is that rig gone: only its seats go. The feature is switched off by the probe alone.
      const body = await this.read(ROUTES.nodes(rigId), "seat", signal, false);
      if (body === undefined) {
        this.nodesRaw.set(rigId, []);
        this.dirtyPs = true;
        this.schedule();
        continue;
      }
      this.nodesRaw.set(rigId, Array.isArray(body) ? (body as Json[]) : []);
    }
  }

  private async refreshAttention(signal: AbortSignal): Promise<void> {
    const body = await this.read(ROUTES.attention, "attention", signal);
    if (body === undefined) {
      this.attentionRaw = [];
      return;
    }
    const b = body as Json;
    const items = Array.isArray(b.items) ? (b.items as Json[]) : [];
    const sources = Array.isArray(b.sources) ? (b.sources as Json[]) : [];
    this.degraded = sources.some((s) => s.state === "unavailable");
    // A source that says it is partial (or unavailable) cannot prove an item is gone: keep what we had.
    const incomplete = sources.some((s) => s.state === "partial" || s.state === "unavailable");
    this.attentionRaw = incomplete ? mergeById(items, this.attentionRaw, (x) => String(x.id)) : items;
    this.setPartial("attention", incomplete);
  }

  private async refreshQueue(signal: AbortSignal): Promise<void> {
    const body = await this.read(ROUTES.queueActive, "work", signal);
    if (body === undefined) {
      this.queueRaw = [];
      return;
    }
    const rows = Array.isArray(body) ? (body as Json[]) : [];
    // The route cannot be paged: a full page may be only part of the set, and a partial page proves no deletion.
    const full = rows.length >= QUEUE_PAGE;
    this.queueRaw = full ? mergeById(rows, this.queueRaw, (x) => String(x.qitemId)) : rows;
    this.setPartial("work", full);
  }

  private setPartial(kind: SourceKind, on: boolean): void {
    if (on === this.partial.has(kind)) return;
    if (on) this.partial.add(kind);
    else this.partial.delete(kind);
    this.opts.log?.(on ? `${kind} may be incomplete (daemon answer is a partial page); deletions suspended` : `${kind} complete again`);
  }

  private markOnline(): void {
    this.connected = true;
    this.everContacted = true;
  }

  private markOffline(): void {
    this.failedOnce = true;
    this.publish();
  }

  // ---- projection ----

  private project(): Map<string, { kind: SourceKind | ExtensionKind; id: string; data: Json }> {
    const out = new Map<string, { kind: SourceKind | ExtensionKind; id: string; data: Json }>();
    const put = (kind: SourceKind | ExtensionKind, data: Json | null) => {
      if (!data) return;
      out.set(key(kind, String(data.id)), { kind, id: String(data.id), data });
    };

    const hostState = this.connected ? (this.degraded || this.partial.size ? "degraded" : "online") : this.failedOnce ? "offline" : "unknown";
    put("host", { id: this.hostId, name: this.hostName, title: this.hostName, state: hostState, ...(this.version ? { version: this.version } : {}), ...(this.partial.size ? { incomplete: [...this.partial].sort() } : {}) });

    if (this.feat.rig) for (const r of this.psRaw) put("rig", mapRig(r, this.hostId));

    const sessionToSeat = new Map<string, string>();
    const nodes: Json[] = [];
    if (this.feat.seat && this.feat.rig) {
      for (const [rigId, list] of this.nodesRaw) {
        if (!this.psIds().has(rigId)) continue;
        for (const n of list) {
          nodes.push(n);
          if (n.nodeKind !== "infrastructure" && typeof n.nodeId === "string") {
            if (typeof n.canonicalSessionName === "string") sessionToSeat.set(n.canonicalSessionName, n.nodeId);
            if (typeof n.logicalId === "string") sessionToSeat.set(`${n.logicalId}@${n.rigName}`, n.nodeId);
          }
        }
      }
    }
    const seatIdOf = (s: string | undefined) => (s ? sessionToSeat.get(s) : undefined);

    const attentionBySeat = new Map<string, string[]>();
    const attention: Json[] = [];
    if (this.feat.attention) {
      for (const item of this.attentionRaw) {
        const mapped = mapAttention(item, seatIdOf, this.opts.includeText === true);
        if (!mapped) continue;
        const at = isoOrUndefined((item as Json).at);
        attention.push({ ...mapped, ...(at ? { __at: at } : {}) });
        if (typeof mapped.seatId === "string") attentionBySeat.set(mapped.seatId, [...(attentionBySeat.get(mapped.seatId) ?? []), String(mapped.id)]);
      }
    }
    for (const n of nodes) {
      const id = typeof n.nodeId === "string" ? n.nodeId : "";
      const seat = mapSeat(n, attentionBySeat.get(id) ?? [], this.opts.includeText === true, this.opts.seatActions ?? []);
      if (seat) put("seat", { ...seat, ...(isoOrUndefined(n.lastActivityAt) ? { __at: isoOrUndefined(n.lastActivityAt) } : {}) });
    }
    for (const a of attention) put("attention", a);

    if (this.feat.work) {
      const waiting = new Set(attention.map((a) => String(a.id).replace(/^queue(-update)?:/, "")));
      for (const row of this.queueRaw) {
        if (!WORK_ACTIVE.has(String((row as Json).state))) continue;
        const id = String((row as Json).qitemId ?? "");
        const mapped = mapWork(row, seatIdOf, waiting.has(id), this.opts.includeText === true);
        if (mapped) put("work", { ...mapped, __at: isoOrUndefined((row as Json).tsUpdated) });
      }
    }
    for (const ev of this.eventsRaw) {
      const id = `ev-${ev.seq}`;
      const fromSeatId = seatIdOf(ev.from);
      const toSeatId = seatIdOf(ev.to);
      put(EVENT_KIND, {
        id,
        title: ev.eventType,
        summary: ev.summary,
        eventType: ev.eventType,
        daemonEvent: ev.daemonEvent,
        seq: ev.seq,
        ...(ev.from ? { fromSession: ev.from } : {}),
        ...(ev.to ? { toSession: ev.to } : {}),
        ...(fromSeatId ? { fromSeatId } : {}),
        ...(toSeatId ? { toSeatId } : {}),
        ...(ev.workId ? { workId: ev.workId } : {}),
        __at: ev.at,
      });
    }
    return out;
  }

  private publish(): void {
    const want = this.project();
    const at = this.now().toISOString();
    for (const [k, v] of want) {
      const { __at, ...data } = v.data as Json & { __at?: string };
      const sig = JSON.stringify(data);
      const prev = this.emitted.get(k);
      if (prev && prev.sig === sig) continue;
      const full = { ...data, updatedAt: (typeof __at === "string" ? __at : undefined) ?? at };
      this.emitted.set(k, { sig, data: full });
      this.opts.onChange({ kind: v.kind, id: v.id, op: "upsert", data: full });
    }
    for (const k of [...this.emitted.keys()]) {
      if (want.has(k)) continue;
      this.emitted.delete(k);
      const [kind, id] = k.split("\u0000") as [SourceKind | ExtensionKind, string];
      this.opts.onChange({ kind, id, op: "delete" });
    }
  }
}

function mergeById(fresh: Json[], old: Json[], idOf: (x: Json) => string): Json[] {
  const seen = new Set(fresh.map(idOf));
  return [...fresh, ...old.filter((x) => !seen.has(idOf(x)))];
}

export { KINDS as SOURCE_KINDS };
