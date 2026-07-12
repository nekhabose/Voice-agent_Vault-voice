import Anthropic from "@anthropic-ai/sdk";

/**
 * Which failures are outages, and which are our bugs.
 *
 * Three packages now speak to this vendor — `extraction` (call site #2), `faq`
 * (#3), and `triage` (#5) — and they must answer this question identically,
 * because it is not a question about any of them. It is a question about the
 * API. Three copies of it would drift, and the drift would be silent: a package
 * that decided a `401` was an outage would degrade into asking a caller their
 * name four times instead of crashing in staging on the day we shipped without a
 * key.
 *
 * A `429`, a `5xx`, or a dead socket is the world being unreliable. A `400` means
 * we built a bad request and a `401` means we shipped without a credential; both
 * are defects, and both must crash loudly rather than wear the costume of a
 * caller who said nothing.
 */
export function isOutage(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.RateLimitError) return true;
  if (error instanceof Anthropic.InternalServerError) return true;
  return false;
}

/**
 * The reason string for an outage — or a rethrow, if it was our bug.
 *
 * Each call site wraps the reason in its own outcome type (`unavailable` on
 * `ExtractionOutcome`, `FaqOutcome`, `TriageVerdict`), because what to *do*
 * about an outage differs per call site. What *counts* as one does not.
 */
export function outageReasonOrThrow(error: unknown): string {
  if (!isOutage(error)) throw error;
  return error instanceof Error ? error.message : String(error);
}
