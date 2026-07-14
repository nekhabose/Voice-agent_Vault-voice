import Groq from "groq-sdk";

/**
 * Which failures are outages, which are the *model's*, and which are ours.
 *
 * `@ledgerline/anthropic` has two categories, and the rule is simple: a `429`, a
 * `5xx`, or a dead socket is the world being unreliable and degrades to
 * `unavailable`; a `400` or a `401` is a bad request or a missing key, is our
 * defect, and **throws**, because a defect that degrades is a defect that ships.
 *
 * Groq has a third, and it is not a nicety. **A `400` here can be the model's
 * failure rather than ours.** When a Groq model is handed a forced tool it cannot
 * fill, it does not return a malformed tool call — the API rejects the *generation*
 * and returns `400 tool_use_failed`, carrying the text the model produced in
 * `failed_generation`. The same happens as `json_validate_failed` when a
 * `response_format: json_schema` request comes back not matching its schema.
 *
 * We did not deduce this. We measured it: `openai/gpt-oss-120b`, handed our
 * `record_service_address` tool and the utterance "1247 Calle Ocho, Miami FL
 * 33135", returned `{"value": {"address": "1247 Calle Ocho, Miami Florida,
 * 33135"}}` — it flattened a four-field address into one string, failed the
 * schema, and the API turned that into a `400`. That is VoiceAgentBench's
 * 60.6%-parameter-fill finding arriving on turn one of the first live call this
 * repository has ever made, and it is the reason principle #1 exists.
 *
 * Which leaves the taxonomy question, and it has exactly one defensible answer:
 *
 * - **It must not throw.** Anthropic's rule would drop the call. The caller is on
 *   the phone and has done nothing wrong; a model that cannot fill a schema is a
 *   model-selection bug, and a model-selection bug must not hang up on a
 *   homeowner with a burst pipe.
 * - **It must not be `absent`.** That is the far worse option, and the tempting
 *   one — `absent` is already the "the caller didn't say it" outcome and the call
 *   flows on. But it blames the caller for our failure, and it makes our failure
 *   *invisible*: the slot gets re-asked, the caller repeats themselves, and
 *   nothing anywhere records that the model could not do the job. Every failure
 *   mode of this system must push the published number **up** (principle #5), and
 *   this one would push it silently down.
 * - **So it is `unavailable`, with a reason that says which kind.** The call
 *   retries once and then escalates to a human — the same path as an outage,
 *   which is the right *behaviour* — while telemetry can still tell "Groq was
 *   down" apart from "this model cannot fill this schema", which are the same
 *   behaviour and completely different bugs. One is somebody else's incident. The
 *   other is ours, and it is fixed by choosing a different model.
 */

/**
 * The `code` on a `400` that means *the model* failed, not the request.
 *
 * Kept as a closed set on purpose. An unrecognised `400` stays our bug and still
 * throws, because the failure we cannot afford is the one where a genuinely
 * malformed request — a tool schema we broke, a parameter Groq stopped accepting —
 * quietly wears the costume of a model having a bad day, and the phone line stays
 * up while every call escalates to a human.
 */
export const MODEL_FAILURE_CODES = ["tool_use_failed", "json_validate_failed"] as const;

export type ModelFailureCode = (typeof MODEL_FAILURE_CODES)[number];

/** A `429`, a `5xx`, or a dead socket. The world, being unreliable. */
export function isOutage(error: unknown): boolean {
  if (error instanceof Groq.APIConnectionError) return true;
  if (error instanceof Groq.RateLimitError) return true;
  if (error instanceof Groq.InternalServerError) return true;
  return false;
}

/**
 * The model's failure code, if this `400` was one — otherwise `null`.
 *
 * The SDK sets `error.error` to the parsed response body, so the code we want is
 * at `error.error.error.code`. That doubled key is not a typo: the body is
 * `{"error": {"message": …, "type": …, "code": "tool_use_failed"}}` and the SDK's
 * own field is also called `error`.
 */
export function modelFailureCode(error: unknown): ModelFailureCode | null {
  if (!(error instanceof Groq.BadRequestError)) return null;

  const body = (error as { error?: unknown }).error;
  if (typeof body !== "object" || body === null) return null;

  const inner = (body as { error?: unknown }).error;
  if (typeof inner !== "object" || inner === null) return null;

  const code = (inner as { code?: unknown }).code;
  return MODEL_FAILURE_CODES.includes(code as ModelFailureCode)
    ? (code as ModelFailureCode)
    : null;
}

export function isModelFailure(error: unknown): boolean {
  return modelFailureCode(error) !== null;
}

/**
 * The reason string for a failure we may degrade on — or a rethrow, if it was our
 * bug.
 *
 * The prefix is the whole point. Every call site wraps this in its own
 * `unavailable` (`ExtractionOutcome`, `FaqOutcome`, `TriageVerdict`), and every
 * one of them *behaves* the same way about it. What differs is what a human should
 * do next, and a reason string that cannot distinguish "Groq returned 503" from
 * "this model cannot fill this schema" is a dashboard that will send somebody to
 * read a status page for a week while the fix is a one-line model change.
 */
export function degradeReasonOrThrow(error: unknown): string {
  const code = modelFailureCode(error);
  if (code !== null) return `model_failure: ${code}: ${messageOf(error)}`;
  if (isOutage(error)) return `outage: ${messageOf(error)}`;
  throw error;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
