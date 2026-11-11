import { createHash } from "node:crypto";
import type { CoreAppJob } from "@openrig-seats/seat-source-openrig";
import type { ActResponse, Json } from "@openrig-seats/seat-protocol";
import { TableUnavailableError, type IdempotencyTable } from "./idempotency.js";
import type { ActResult } from "./act.js";

const rec = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Thin protocol adapter. The Core answer owner, never a local cache, decides replay and conflicts. */
export class AnswerAction {
  constructor(private readonly opts: { job: CoreAppJob; actor: string; table: IdempotencyTable }) {}

  async handle(raw: unknown): Promise<ActResult> {
    const b = rec(raw), input = rec(b.input);
    const key = b.idempotencyKey;
    if (typeof key !== "string" || key.length < 8 || key.length > 128) return { httpStatus: 400, response: { error: "invalid_request", message: "a stable idempotencyKey of 8 to 128 characters is required" } };
    const reject = (code: string, message: string, status = 400): ActResult => ({ httpStatus: status, response: { idempotencyKey: key, status: "rejected", replayed: false, error: { code, message } } });
    if (!this.opts.job.actionsEnabled()) return reject("job_unavailable", "the Core human-answer job is unavailable", 503);
    if (b.kind !== "attention" || typeof b.id !== "string" || b.id !== `core-app:${String(input.requestId)}`) return reject("invalid_request", "answer must address the explicit Core request");
    if (input.actor !== this.opts.actor) return reject("actor_not_allowed", "answer actor must be the configured registered person", 403);
    if (typeof input.requestId !== "string" || !input.requestId || typeof input.questionId !== "string" || !input.questionId || typeof input.expectedRevision !== "string" || !input.expectedRevision || !(input.episodeKey === null || typeof input.episodeKey === "string")) return reject("invalid_request", "request, question, episode and rendered revision are required");
    const option = typeof b.action === "string" && /^answer-option(?::[a-f0-9]{24})?$/.test(b.action), typed = typeof b.action === "string" && /^answer-typed(?::[a-f0-9]{24})?$/.test(b.action);
    if (!option && !typed) return reject("unknown_action", "this job supports option or typed answers");
    if (!this.opts.job.supports(option ? "option" : "typed-reply")) return reject("unsupported_answer_form", "Core did not advertise this answer form", 422);
    const allowed = new Set(["actor", "requestId", "questionId", "episodeKey", "expectedRevision", option ? "optionId" : "text"]);
    if (Object.keys(input).some((x) => !allowed.has(x))) return reject("invalid_request", "unknown answer input field");
    if (option && (typeof input.optionId !== "string" || !input.optionId)) return reject("invalid_request", "optionId is required");
    if (typed && (typeof input.text !== "string" || !input.text.trim() || Buffer.byteLength(input.text) > 16384 || input.text.includes("\0"))) return reject("invalid_request", "typed reply must contain 1 to 16384 UTF-8 bytes without NUL");
    const payload = { job: "human-answer", actor: input.actor, requestId: input.requestId, questionId: input.questionId, episodeKey: input.episodeKey, expectedRevision: input.expectedRevision, answer: option ? { kind: "option", optionId: input.optionId } : { kind: "typed-reply", text: input.text } };
    const answerId = `seats_${createHash("sha256").update(key).digest("hex")}`;
    // A durable marker predates the HTTP write. On restart it remains retryable with this SAME Core ID.
    // The hash is diagnostic only. Core binds every immutable field, including conflicting key reuse.
    const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const known = this.opts.table.get(key);
    if (!known) try { this.opts.table.begin(key, fingerprint, { requestId: input.requestId, actor: input.actor }); }
    catch (err) {
      if (err instanceof TableUnavailableError) return reject(err.code, err.message, 503);
      throw err;
    }
    let response: ActResponse;
    let httpStatus = 200;
    try {
      const result = await this.opts.job.submit(answerId, payload);
      const receipt = rec(result.body), submission = rec(receipt.submission);
      if (result.status >= 200 && result.status < 300 && submission.state === "committed") {
        response = { idempotencyKey: key, status: "completed", replayed: receipt.replayed === true, result: receipt as Json };
      } else if ((result.status >= 200 && result.status < 300) || ((result.status >= 500 || submission.state === "incomplete") && receipt.retrySameSubmission !== false)) {
        // A successful HTTP status without a recognized committed receipt is not a refusal:
        // Core may have committed before JSON was truncated or an unknown response was read.
        response = { idempotencyKey: key, status: "accepted", replayed: false, retrySameRequest: true, result: { ...receipt, answerId, retrySameSubmission: true } };
      } else {
        httpStatus = result.status >= 400 ? result.status : 409;
        const error = rec(receipt.error);
        response = { idempotencyKey: key, status: "rejected", replayed: receipt.replayed === true, result: receipt as Json, error: { code: typeof receipt.error === "string" ? receipt.error : typeof error.code === "string" ? error.code : "answer_refused", message: "Core refused this bound answer; refresh the request before making another decision." } };
      }
    } catch {
      response = { idempotencyKey: key, status: "accepted", replayed: false, retrySameRequest: true, result: { answerId, retrySameSubmission: true }, };
    }
    // Do not retain Core receipt/question/answer content in the gateway cache. The durable
    // marker keeps only the binding hash and request/actor needed to resume authoritative reads.
    return { httpStatus, response };
  }
}
