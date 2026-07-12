import { METHODOLOGY_VERSION } from "@ledgerline/contracts";
import { publicationState } from "@/lib/publication";

/**
 * The figures, machine-readable (plan, Step 9).
 *
 * A number on a marketing page is a number a company can quietly change. A JSON endpoint is
 * one a journalist, a competitor, or a customer can poll on a schedule and diff — and the
 * whole strategic value of being first to publish a field reliability figure evaporates if
 * the figure is only ever a rendered `<span>` that we control the history of.
 *
 * So this exists to be **archived by other people**. It carries the window, the sample
 * sizes, the confidence interval, the methodology version, and the full publication history,
 * because every one of those is something a sceptic needs in order to catch us moving the
 * goalposts later. The append-only table behind it means we could not move them quietly even
 * if we tried; this endpoint is what makes that fact checkable from outside.
 *
 * **Public, and deliberately unauthenticated.** There is no tenant here and there must not
 * be one: the cohort is an aggregate across every contractor, it carries no tenant id, and
 * `MIN_COHORT_TENANTS` is what keeps the arithmetic itself from naming one.
 *
 * `withheld` is a first-class response, not an error. Today it is the only response.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const state = await publicationState();

  if (state.kind === "no_database") {
    // Not a 500, and *emphatically* not `{ correctionRate: 0 }`. "We have measured nothing"
    // is a true and complete answer, and the failure mode this whole subsystem is arranged
    // against is a broken measurement that reports a perfect score.
    return Response.json({
      status: "unmeasured",
      methodologyVersion: METHODOLOGY_VERSION,
      reason:
        "No contractor has used this agent to answer a real call. There is no number, and a 0% correction rate over no bookings would be a lie.",
      history: [],
    });
  }

  const { decision, history, window } = state;

  return Response.json({
    status: decision.status,
    methodologyVersion: METHODOLOGY_VERSION,
    window,
    ...(decision.status === "published"
      ? { current: decision.report }
      : { reasons: decision.reasons, cohort: decision.cohort }),
    history,
  });
}
