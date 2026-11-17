import { createHash } from "node:crypto";
import { DaemonClient, DaemonError } from "./daemon.js";
import { ROUTES } from "./routes.js";
import type { Json } from "./types.js";

const rec = (v: unknown): Json => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Json : {};
const rows = (v: unknown): Json[] => Array.isArray(v) ? v.map(rec) : [];
const str = (v: unknown): string | undefined => typeof v === "string" && v ? v : undefined;
export const CORE_APP_CONTRACT = "openrig.core-app";
export const CORE_APP_VERSION = 1;

/** Uses only the separately authenticated, versioned Core job. Legacy source reads are independent. */
export class CoreAppJob {
  private supported = false;
  private forms: string[] = [];
  private requests = new Map<string, Json>();
  private results = new Map<string, Json>();
  private tracked = new Set<string>();
  /** Requests in the latest successful snapshot: only these may offer actions. Stale cached ones never do. */
  private fresh = new Set<string>();
  private partial = false;
  private refreshed = false;
  private ctl = new AbortController();
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private refreshTail: Promise<void> = Promise.resolve();
  private notify: () => void = () => {};

  /** `tracked` may be a callback so an owner with its own marker policy (the gateway's idempotency table) bounds it. */
  constructor(private readonly opts: { daemon: DaemonClient; actor: string; actions: boolean; tracked?: string[] | (() => string[]) }) {
    if (Array.isArray(opts.tracked)) for (const id of opts.tracked) this.tracked.add(id);
  }
  private trackedIds(): Iterable<string> { return typeof this.opts.tracked === "function" ? this.opts.tracked() : this.tracked; }

  available(): boolean { return this.supported; }
  supports(form: string): boolean { return this.forms.includes(form); }
  actionsEnabled(): boolean { return this.supported && this.opts.actions; }

  /** Discovery failures disable only this job. Never assume support from the seat protocol version. */
  async discover(signal?: AbortSignal): Promise<void> {
    let supported = false;
    let forms: string[] = [];
    try {
      const c = rec(await this.opts.daemon.getJson(ROUTES.appCapabilities, signal));
      const job = rows(c.jobs).find((j) => j.id === "human-answer");
      const app = rec(c.app);
      if (c.contract !== CORE_APP_CONTRACT || c.version !== CORE_APP_VERSION || !job ||
        !Array.isArray(app.actors) || !app.actors.includes(this.opts.actor) ||
        !Array.isArray(job.actorAssurance) || !job.actorAssurance.includes("app-attributed") ||
        job.stableSubmissionIds !== true || job.resultRead !== true) throw new Error("unsupported job");
      forms = Array.isArray(job.answerForms) ? job.answerForms.filter((x): x is string => x === "option" || x === "typed-reply") : [];
      supported = forms.length > 0;
    } catch { /* Old, new, unavailable or unauthenticated Core: retain the legacy source. */ }
    this.forms = forms;
    this.supported = supported;
  }

  async refresh(signal?: AbortSignal): Promise<void> {
    const run = async () => {
      await this.discover(signal);
      if (!this.supported) { this.partial = true; this.fresh.clear(); this.notify(); return; }
      try {
        const snapshot = rec(await this.opts.daemon.getJson(ROUTES.appNeedsMe(this.opts.actor), signal));
        if (snapshot.version !== CORE_APP_VERSION || !Array.isArray(snapshot.requests) || !Array.isArray(snapshot.sources)) throw new Error("unsupported snapshot");
        this.partial = !rows(snapshot.sources).some((s) => s.source === "queue" && s.state === "available") || rows(snapshot.sources).some((s) => s.state !== "available");
        // Core's partial coverage still lists its healthy requests; an unavailable queue lists none.
        const readable = rows(snapshot.sources).some((s) => s.source === "queue" && (s.state === "available" || s.state === "partial"));
        const fresh = new Map<string, Json>();
        for (const r of rows(snapshot.requests)) {
          const id = str(r.requestId);
          if (id && rec(r.actor).address === this.opts.actor) fresh.set(id, r);
        }
        if (!this.partial) this.requests.clear();
        for (const [id, r] of fresh) this.requests.set(id, r);
        this.refreshed = true;
        this.fresh = new Set(readable ? fresh.keys() : []);
        const tracked = [...this.trackedIds()];
        for (const id of [...this.results.keys()]) if (!tracked.includes(id)) this.results.delete(id);
        for (const id of tracked) {
          try { this.results.set(id, rec(await this.opts.daemon.getJson(ROUTES.appResult(id, this.opts.actor), signal))); }
          catch (err) {
            this.results.set(id, { sources: [{ source: "queue", state: "unavailable" }], unavailable: err instanceof DaemonError ? err.status ?? "network" : "network" });
          }
        }
      } catch { this.partial = true; this.fresh.clear(); }
      this.notify();
    };
    const next = this.refreshTail.then(run, run);
    this.refreshTail = next;
    await next;
  }

  /** Every reconnect/gap/invalidation rereads actor-scoped snapshots; stream payloads are never state patches. */
  start(onChange: () => void): void {
    if (this.running) return;
    this.notify = onChange;
    this.ctl = new AbortController();
    this.timer = setInterval(() => { void this.refresh(this.ctl.signal); }, 5000);
    this.running = this.loop();
  }
  async stop(): Promise<void> {
    this.ctl.abort();
    if (this.timer) clearInterval(this.timer);
    await this.running;
    await this.refreshTail;
    this.running = undefined;
  }
  private async loop(): Promise<void> {
    const signal = this.ctl.signal;
    while (!signal.aborted) {
      try {
        for await (const _ of this.opts.daemon.appInvalidations(signal)) await this.refresh(signal);
      } catch { /* Polling remains authoritative when the optional event route is unavailable. */ }
      if (!signal.aborted) await this.refresh(signal);
      if (!signal.aborted) await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(t); signal.removeEventListener("abort", done); resolve(); };
        const t = setTimeout(done, 1000); signal.addEventListener("abort", done, { once: true });
      });
    }
  }

  /** Stable Core ID comes from the caller's durable key, never a new ID minted on retry. */
  async submit(answerId: string, body: Json): Promise<{ status: number; body: unknown }> {
    if (typeof this.opts.tracked !== "function") this.tracked.add(String(body.requestId));
    const result = await this.opts.daemon.postJson(ROUTES.appAnswer(answerId), body);
    void this.refresh(this.ctl.signal);
    return result;
  }

  /** Reuse protocol question parts and generic declared actions; no second question model. */
  items(): Json[] {
    const out: Json[] = [];
    const ids = new Set([...this.requests.keys(), ...this.trackedIds()]);
    for (const id of ids) {
      const request = this.requests.get(id);
      const questions = rows(request?.questions);
      const humanAnswers = rec(request?.humanAnswers);
      const actions: Json[] = [];
      const answer = rec(request?.answer);
      const requestForms = Array.isArray(answer.forms) ? answer.forms : [];
      const unanswered = questions.filter((q) => !Object.hasOwn(humanAnswers, String(q.id)));
      const executable = this.actionsEnabled() && this.refreshed && this.fresh.has(id) && request?.state === "pending" && answer.job === "human-answer" && str(request.decisionRevision);
      if (executable) for (const q of unanswered) {
        if (!str(q.id)) continue;
        const binding = { actor: this.opts.actor, requestId: id, questionId: q.id, episodeKey: request!.episodeKey ?? null, expectedRevision: request!.decisionRevision };
        const properties = Object.fromEntries(Object.entries(binding).map(([key, value]) => [key, { const: value }]));
        const declare = (verb: string, label: string, extra: Json) => actions.push({
          id: `${verb}:${createHash("sha256").update(String(q.id)).digest("hex").slice(0, 24)}`, label, danger: false,
          input: { type: "object", additionalProperties: false, required: [...Object.keys(binding), ...Object.keys(extra)], properties: { ...properties, ...extra } },
        });
        if (this.forms.includes("option") && requestForms.includes("option") && rows(q.options).length) declare("answer-option", `Answer: ${String(q.question)}`, { optionId: { type: "string", enum: rows(q.options).map((o) => o.id) } });
        if (q === unanswered[0] && this.forms.includes("typed-reply") && requestForms.includes("typed-reply")) declare("answer-typed", "Reply to this question thread", { text: { type: "string", minLength: 1, maxLength: 16384 } });
      }
      const currentResult = this.results.get(id);
      out.push({ id: `core-app:${id}`, title: `Question ${id}`, severity: "info", state: "open",
        reason: `Answer as ${this.opts.actor} (attributed by the authenticated app)`,
        summary: [str(request?.body), str(request?.humanDetail), str(request?.occupantAuthorityDetail), questions.map((q) => `${String(q.question)}: ${rows(q.options).map((o) => `${String(o.label)} (${String(o.id)})`).join(", ")}`).join("\n"), currentResult ? JSON.stringify(currentResult) : ""].filter(Boolean).join("\n"),
        ...(actions.length ? { actions } : {}),
        "x-openrig.core-app": { actor: this.opts.actor, requestId: id, askedPerson: request?.askedPerson, occupantAuthority: request?.occupantAuthority, occupantAuthorityDetail: request?.occupantAuthorityDetail, asker: request?.asker, decisionRevision: request?.decisionRevision, coverage: this.partial ? "partial" : "available", ...(currentResult ? { result: currentResult } : {}) },
      });
    }
    return out;
  }
}
