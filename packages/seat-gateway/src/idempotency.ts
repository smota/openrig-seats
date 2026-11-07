import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { ActResponse } from "@openrig-seats/seat-protocol";

interface Entry {
  /** Hash of what the key was used for (never the text itself). */
  fingerprint: string;
  at: string;
  /** Absent while the send is in flight. */
  response?: ActResponse;
}

interface FileShape {
  version: 1;
  entries: Record<string, Entry>;
}

export const DEFAULT_RETENTION_MS = 7 * 24 * 3600 * 1000;

/** Thrown by `begin` when the key could not be recorded durably or the table is full: nothing may be sent. */
export class TableUnavailableError extends Error {
  constructor(readonly code: "idempotency_table_full" | "idempotency_unavailable", message: string) {
    super(message);
  }
}

export interface TableIo {
  fsync: (fd: number) => void;
}

/**
 * The gateway's own idempotency table, keyed by the client's idempotency key. OpenRig's `deliveryId` does not
 * de-duplicate in draft-aware mode, so this table is what guarantees at-most-once. An entry is written (pending)
 * BEFORE the daemon is called and completed after, in a 0600 file, so a restart in between can never send again:
 * a pending entry found at load becomes a stored `failed` outcome that a person must resolve with a new key.
 * Message text is never stored, only a hash of the request.
 *
 * Every key is kept for `retentionMs` (default 7 days), whatever the count; only expired keys are dropped. When the
 * table holds `maxKeys` unexpired keys, new sends are refused (503) rather than evicting one, since a retry of an
 * evicted key would type again. A new or changed entry is durable (fsync of file, rename, fsync of directory)
 * before `begin` returns; if that fails nothing is sent. One process owns the table: an exclusive lock file
 * `<path>.lock` (created O_EXCL with the owner's pid, held until `close`) makes a second gateway refuse to start;
 * a lock whose pid is no longer alive is taken over.
 */
export class IdempotencyTable {
  private readonly entries = new Map<string, Entry>();

  private lockFd: number | null = null;
  private readonly lockPath: string;
  private readonly io: TableIo;

  constructor(private readonly path: string, private readonly maxKeys = 5000, private readonly retentionMs = DEFAULT_RETENTION_MS, io?: Partial<TableIo>) {
    this.io = { fsync: io?.fsync ?? fsyncSync };
    this.lockPath = `${path}.lock`;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.lock();
    try {
      this.load();
    } catch (err) {
      this.close();
      throw err;
    }
  }

  private lock(): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.lockPath, "wx", 0o600);
        writeSync(fd, String(process.pid));
        this.lockFd = fd;
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("idempotency lock file cannot be created");
      }
      let pid = NaN;
      try {
        pid = Number(readFileSync(this.lockPath, "utf8").trim());
      } catch {
        /* vanished: retry */
      }
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          throw new Error("another gateway process holds the idempotency table lock; refusing to start (one gateway per table file)");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EPERM") throw new Error("another gateway process holds the idempotency table lock; refusing to start (one gateway per table file)");
          if (e instanceof Error && e.message.startsWith("another gateway")) throw e;
        }
      }
      try {
        unlinkSync(this.lockPath); // stale: its owner is gone
      } catch {
        /* lost the race: the next attempt decides */
      }
    }
    throw new Error("another gateway process holds the idempotency table lock; refusing to start (one gateway per table file)");
  }

  /** Releases the lock. The table must not be used afterwards. */
  close(): void {
    if (this.lockFd === null) return;
    closeSync(this.lockFd);
    this.lockFd = null;
    try {
      unlinkSync(this.lockPath);
    } catch {
      /* already gone */
    }
  }

  private load(): void {
    const path = this.path;
    if (!existsSync(path)) return;
    const st = statSync(path);
    if (!st.isFile()) throw new Error("idempotency file is not a regular file");
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) throw new Error("idempotency file must not be accessible by group or others (chmod 600)");
    let parsed: FileShape;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as FileShape;
    } catch {
      throw new Error("idempotency file is not valid JSON");
    }
    if (parsed?.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) throw new Error("idempotency file has an unknown format");
    let changed = false;
    for (const [key, e] of Object.entries(parsed.entries)) {
      if (!e.response) {
        e.response = {
          idempotencyKey: key,
          status: "failed",
          replayed: false,
          result: { outcome: "indeterminate" },
          error: { code: "gateway_restarted_during_send", message: "The gateway stopped while this send was in flight; the text may or may not have been typed. Check the seat, then send again with a new key if needed." },
        };
        changed = true;
      }
      this.entries.set(key, e);
    }
    if (this.expire() || changed) this.persist();
  }

  /** Drops completed keys older than the retention window. True when something was dropped. */
  private expire(): boolean {
    const cutoff = Date.now() - this.retentionMs;
    let dropped = false;
    for (const [k, e] of this.entries) {
      if (e.response && Date.parse(e.at) < cutoff) {
        this.entries.delete(k);
        dropped = true;
      }
    }
    return dropped;
  }

  get(key: string): Entry | undefined {
    return this.entries.get(key);
  }

  size(): number {
    return this.entries.size;
  }

  /** Records the key as in flight, durably, before anything is sent. Throws TableUnavailableError: then do not send. */
  begin(key: string, fingerprint: string): void {
    this.expire();
    if (this.entries.size >= this.maxKeys) {
      throw new TableUnavailableError("idempotency_table_full", `the idempotency table holds ${this.maxKeys} unexpired keys; sending is refused until some expire`);
    }
    this.entries.set(key, { fingerprint, at: new Date().toISOString() });
    try {
      this.persist();
    } catch {
      this.entries.delete(key);
      throw new TableUnavailableError("idempotency_unavailable", "the idempotency table could not be written durably; nothing was sent");
    }
  }

  /** The send already happened: a write failure is kept in memory and retried on the next change, never thrown. */
  complete(key: string, response: ActResponse): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.response = response;
    try {
      this.persist();
    } catch {
      /* the in-flight marker on disk already makes a restart safe */
    }
  }

  private persist(): void {
    const tmp = `${this.path}.tmp`;
    const body: FileShape = { version: 1, entries: Object.fromEntries(this.entries) };
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(body));
      this.io.fsync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    const dfd = openSync(dirname(this.path), "r");
    try {
      this.io.fsync(dfd);
    } finally {
      closeSync(dfd);
    }
  }
}
