import { createHash } from "node:crypto";
import type { ActResponse } from "@openrig-seats/seat-protocol";
import type { DaemonClient } from "@openrig-seats/seat-source-openrig";
import { TableUnavailableError, type IdempotencyTable } from "./idempotency.js";

export const SENDER_HEADER = "x-openrig-session";

export interface ActConfig {
  /** The `send` action is served only when this is true (default false). */
  send: boolean;
  /** Fixed principal the daemon sees as the sender: a registered non-seat address such as `cockpit@<rig>`. */
  sender?: string;
  /** Longest text accepted, in UTF-16 code units. */
  maxLength: number;
  /** Where the idempotency table lives (0600). */
  idempotencyFile?: string;
  maxKeys: number;
  /** Days every key is kept, whatever the count. Default 7. */
  retentionDays: number;
}

export const DEFAULT_SEND_MAX_LENGTH = 4000;

/** The declared action on `seat` items; also advertised in /capabilities. */
export const sendAction = (maxLength: number) => ({
  id: "send",
  label: "Send text to this seat",
  input: {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string", minLength: 1, maxLength, description: "Typed into the seat's input as one message." } },
  },
  danger: false,
});

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});

/** Seat states in which typing is not safe: a prompt is waiting, or the seat is not running. */
const ACCEPTING = new Set(["active", "idle"]);
const REASON = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

const HTTP_BY_CODE: Record<string, number> = {
  invalid_request: 400,
  unknown_action: 400,
  text_too_long: 400,
  unknown_seat: 404,
};

export interface ActResult {
  httpStatus: number;
  response: ActResponse | { error: string; message: string };
}

export interface SendActionOptions {
  config: ActConfig;
  daemon: DaemonClient;
  table: IdempotencyTable;
  /** Current seat items, from the cache. */
  seats: () => Json[];
  /** How long the daemon may take to answer one send. Default 30000. */
  timeoutMs?: number;
}

/** `httpStatus` of a stored or fresh response. */
export function httpStatusOf(r: ActResponse): number {
  if (r.status === "completed" || r.status === "accepted") return 200;
  if (r.status === "failed") return 409;
  return HTTP_BY_CODE[r.error?.code ?? ""] ?? 409;
}

/**
 * `POST /act` for the `send` action on seats, over the daemon's `POST /api/transport/send`.
 *
 * Rules: at most one send per idempotency key (also across restarts and across concurrent callers); a new key for
 * the same text is a new send; the gateway itself never retries a send, and once the daemon reports an input phase of
 * `attempted` or `written`, or any outcome other than a clean refusal before input, that outcome goes back to the
 * caller and a person decides. The sender is the configured principal, never a seat name; the request never carries
 * `x-openrig-occupant-generation`, `force`, or any override.
 */
export class SendAction {
  private readonly inflight = new Map<string, Promise<ActResponse>>();
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: SendActionOptions) {}

  async handle(raw: unknown): Promise<ActResult> {
    const body = rec(raw);
    const key = body.idempotencyKey;
    if (typeof key !== "string" || key.length < 8 || key.length > 128) return { httpStatus: 400, response: { error: "invalid_request", message: "idempotencyKey must be a string of 8 to 128 characters" } };
    const reject = (code: string, message: string): ActResult => ({ httpStatus: HTTP_BY_CODE[code] ?? 409, response: { idempotencyKey: key, status: "rejected", replayed: false, error: { code, message } } });

    if (body.kind !== "seat" || typeof body.id !== "string" || body.id === "") return reject("invalid_request", "kind must be seat and id a seat id");
    if (body.action !== "send") return reject("unknown_action", "this gateway declares only the send action");
    const input = rec(body.input);
    const text = input.text;
    if (typeof text !== "string" || text.trim() === "") return reject("invalid_request", "input.text must be a non-empty string");
    if (text.length > this.opts.config.maxLength) return reject("text_too_long", `input.text is longer than ${this.opts.config.maxLength}`);
    // eslint-disable-next-line no-control-regex
    if (/\u0000/.test(text)) return reject("invalid_request", "input.text must not contain NUL");

    const fingerprint = createHash("sha256").update(JSON.stringify([body.kind, body.id, body.action, text])).digest("hex");
    const known = this.opts.table.get(key);
    if (known) {
      if (known.fingerprint !== fingerprint) return reject("idempotency_key_reused", "this idempotency key was used for a different request");
      const pending = this.inflight.get(key);
      const response = known.response ?? (await pending);
      if (!response) return reject("invalid_request", "send state is unknown");
      return { httpStatus: httpStatusOf(response), response: { ...response, replayed: true } };
    }

    const seat = this.opts.seats().find((s) => s.id === body.id);
    if (!seat) return reject("unknown_seat", "no such seat");
    const ext = rec(seat["x-openrig"]);
    const session = typeof ext.sessionName === "string" && ext.sessionName ? ext.sessionName : undefined;
    const sender = this.opts.config.sender;
    if (!session || !sender) return reject("seat_not_accepting_input", "the seat has no session to send to");
    if (!ACCEPTING.has(String(seat.state)) || ext.held === true || ext.intentionallyStopped === true) {
      return reject("seat_not_accepting_input", `the seat is ${String(seat.state)}${ext.held === true ? " and held" : ""}; the daemon does not report it as accepting input`);
    }
    // The principal must never be a seat: a seat name would let this gateway act as that seat.
    if (this.opts.seats().some((s) => s.name === sender || rec(s["x-openrig"]).sessionName === sender)) return reject("sender_is_a_seat", "act.sender must be a non-seat address");

    // Everything above is synchronous: the key is claimed before any await, so two callers cannot both send.
    try {
      this.opts.table.begin(key, fingerprint);
    } catch (err) {
      if (err instanceof TableUnavailableError) return { httpStatus: 503, response: { idempotencyKey: key, status: "rejected", replayed: false, error: { code: err.code, message: err.message } } };
      throw err;
    }
    const prev = this.tails.get(session) ?? Promise.resolve();
    const run = prev.then(() => this.perform(key, session, sender, text));
    this.tails.set(session, run.catch(() => {}));
    this.inflight.set(key, run);
    let response: ActResponse;
    try {
      response = await run;
    } finally {
      this.inflight.delete(key);
    }
    return { httpStatus: httpStatusOf(response), response };
  }

  private async perform(key: string, session: string, sender: string, text: string): Promise<ActResponse> {
    let response: ActResponse;
    try {
      response = await this.send(key, session, sender, text);
    } catch {
      // No answer was read: the daemon may or may not have typed. Never retried here.
      response = {
        idempotencyKey: key,
        status: "failed",
        replayed: false,
        result: { outcome: "indeterminate" },
        error: { code: "daemon_no_answer", message: "The daemon did not answer; the text may or may not have been typed. Check the seat, then send again with a new key if needed." },
      };
    }
    this.opts.table.complete(key, response);
    return response;
  }

  private async send(key: string, session: string, sender: string, text: string): Promise<ActResponse> {
    const deliveryId = `gw-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
    const { status, body } = await this.opts.daemon.postJson(
      "/api/transport/send",
      { session, text, deliveryId, verify: true },
      { [SENDER_HEADER]: sender },
      this.opts.timeoutMs ?? 30_000,
    );
    const r = rec(body);
    const outcome = typeof r.outcome === "string" ? r.outcome : undefined;
    const phase = typeof r.inputPhase === "string" ? r.inputPhase : undefined;
    const reason = typeof r.reason === "string" && REASON.test(r.reason) ? r.reason : undefined;
    const base = { idempotencyKey: key, replayed: false } as const;
    const detail = { ...(outcome ? { outcome } : {}), ...(phase ? { inputPhase: phase } : {}), ...(typeof r.sent === "boolean" ? { sent: r.sent } : {}), ...(reason ? { reason } : {}) };

    if (status >= 200 && status < 300 && r.ok === true) {
      if (outcome === "delivered" || outcome === "rendered-unconfirmed") {
        return { ...base, status: "completed", result: { ...detail, outcome, verified: r.verified === true } };
      }
      if (outcome === "retained") {
        return { ...base, status: "accepted", result: { ...detail, outcome: "retained", message: "The daemon is holding the text and delivers it later; do not send it again." } };
      }
      // ok without a known outcome: something may have been typed.
      return { ...base, status: "completed", result: { ...detail, verified: r.verified === true } };
    }
    // A clean refusal: nothing was typed. Only these may be called "rejected" (the person can fix the cause and send again).
    const clean = status === 401 || status === 403 || ((status === 400 || status === 404) && phase === undefined) || (phase === "not_reached" && r.sent !== true);
    if (clean) {
      const code = status === 401 || status === 403 ? "daemon_auth_refused" : (reason ?? "send_refused");
      return { ...base, status: "rejected", result: detail, error: { code, message: "The daemon refused the send before typing anything." } };
    }
    return {
      ...base,
      status: "failed",
      result: { ...detail, outcome: outcome ?? "indeterminate" },
      error: { code: reason ?? "send_failed", message: "The send did not complete cleanly and may have been typed. Check the seat; the gateway does not retry. Send again with a new key only if needed." },
    };
  }
}
