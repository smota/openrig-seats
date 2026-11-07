import { randomBytes } from "node:crypto";
import type { Change } from "@openrig-seats/seat-source-openrig";

export interface Entry {
  seq: number;
  kind: string;
  id: string;
  op: "upsert" | "delete";
  data?: Record<string, unknown>;
}

export interface Resolved {
  /** Send every entry with seq greater than this. */
  from: number;
  /** True when the client's cursor cannot be honoured: it gets the full state after a `reset` event. */
  reset: boolean;
  reason?: "cursor-unknown" | "cursor-pruned" | "cursor-ahead";
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The gateway's cache: the latest operation per (kind, id), each stamped with a monotonic sequence
 * number. A client that resumes after sequence N receives exactly the entries newer than N, in order:
 * no gap (every change after N is represented by its latest state) and no duplicate (sequence numbers
 * are never reused). Deletes are kept as tombstones up to a limit; a cursor older than the oldest
 * dropped tombstone gets a `reset` and the full state instead.
 *
 * A slow client never queues anything: it reads the newest state when it catches up, so memory is
 * bounded by the number of live items plus the tombstone limit, whatever the clients do.
 *
 * The cursor is `<epoch>.<seq>`; the epoch is new on every start, so a cursor from before a gateway
 * restart is recognised and answered with a reset. Clients treat cursors as opaque.
 */
export class Store {
  readonly epoch: string;
  private seq = 0;
  private floor = 0;
  /** seq -> entry, in ascending seq order (a Map iterates in insertion order). */
  private readonly bySeq = new Map<number, Entry>();
  private readonly byKey = new Map<string, number>();
  private tombstones = 0;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly tombstoneLimit = 5000, epoch?: string) {
    this.epoch = epoch ?? randomBytes(6).toString("hex");
  }

  cursor(seq: number): string {
    return `${this.epoch}.${seq}`;
  }

  head(): number {
    return this.seq;
  }

  /** Highest sequence number of a pruned tombstone: a client that has processed less than this missed a delete. */
  floorSeq(): number {
    return this.floor;
  }

  size(): number {
    return this.bySeq.size;
  }

  /** Applies a change from the source. Returns the new entry, or null when it changes nothing. */
  apply(change: Change): Entry | null {
    const k = `${change.kind}\u0000${change.id}`;
    const prevSeq = this.byKey.get(k);
    const prev = prevSeq === undefined ? undefined : this.bySeq.get(prevSeq);
    if (change.op === "delete") {
      if (!prev || prev.op === "delete") return null;
    } else if (prev && prev.op === "upsert" && same(prev.data, change.data)) {
      return null;
    }
    if (prevSeq !== undefined) {
      this.bySeq.delete(prevSeq);
      if (prev?.op === "delete") this.tombstones--;
    }
    const entry: Entry = { seq: ++this.seq, kind: change.kind, id: change.id, op: change.op, ...(change.op === "upsert" ? { data: change.data ?? {} } : {}) };
    this.bySeq.set(entry.seq, entry);
    this.byKey.set(k, entry.seq);
    if (change.op === "delete") {
      this.tombstones++;
      this.pruneTombstones();
    }
    for (const w of [...this.waiters]) w();
    return entry;
  }

  private pruneTombstones(): void {
    if (this.tombstones <= this.tombstoneLimit) return;
    for (const [seq, e] of this.bySeq) {
      if (this.tombstones <= this.tombstoneLimit) break;
      if (e.op !== "delete") continue;
      this.bySeq.delete(seq);
      this.byKey.delete(`${e.kind}\u0000${e.id}`);
      this.tombstones--;
      if (seq > this.floor) this.floor = seq;
    }
  }

  resolve(cursor: string | undefined | null): Resolved {
    if (cursor === undefined || cursor === null || cursor === "") return { from: 0, reset: false };
    const m = /^([0-9a-f]+)\.(\d+)$/.exec(cursor);
    if (!m || m[1] !== this.epoch) return { from: 0, reset: true, reason: "cursor-unknown" };
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n) || n > this.seq) return { from: 0, reset: true, reason: "cursor-ahead" };
    if (n < this.floor) return { from: 0, reset: true, reason: "cursor-pruned" };
    return { from: n, reset: false };
  }

  /** Entries newer than `seq`, oldest first. */
  since(seq: number): Entry[] {
    const out: Entry[] = [];
    for (const e of this.bySeq.values()) if (e.seq > seq) out.push(e);
    return out;
  }

  /** Current items of a kind (tombstones excluded). */
  items(kind: string): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const e of this.bySeq.values()) if (e.kind === kind && e.op === "upsert" && e.data) out.push(e.data);
    return out;
  }

  kinds(): string[] {
    return [...new Set([...this.bySeq.values()].filter((e) => e.op === "upsert").map((e) => e.kind))];
  }

  /** Resolves when the head is beyond `seq` (callers pass the head they have already processed), on abort, or after `timeoutMs`. */
  waitAfter(seq: number, signal: AbortSignal, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.seq > seq || signal.aborted) return resolve();
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const t = setTimeout(done, timeoutMs);
      this.waiters.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }
}

export function envelope(store: Store, e: Entry) {
  return { cursor: store.cursor(e.seq), kind: e.kind, id: e.id, op: e.op, ...(e.op === "upsert" ? { data: e.data } : {}) };
}
