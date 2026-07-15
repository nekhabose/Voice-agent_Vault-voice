import {
  METHODOLOGY_VERSION,
  type CohortStats,
  type PublicationDecision,
  type PublicationWindow,
  type ReliabilityReport,
} from "@ledgerline/contracts";
import { publishedCorrectionRate } from "./metrics.js";

/**
 * Step 9 — what we are allowed to say out loud, and what we must say instead.
 *
 * `packages/telemetry` already owned the rule that decides *which of two rates* we may
 * quote (`publishedCorrectionRate()` — the classifier is licensed, not trusted). This file
 * owns the one before it: **whether we may quote a rate at all.**
 *
 * That question sounds like a formality and is the most dangerous moment in the product.
 * `computeMetrics()`' `ratio()` returns **0 when the denominator is 0** — which is correct
 * for a rate and catastrophic for a claim, because it means a cohort of no bookings
 * reports a *flawless* correction rate. A vendor with no customers and a bug in their
 * poller publishes 0.0% and is telling the truth about a number that means nothing. It is
 * the missed-webhook failure mode (principle #5) for the fourth time, and it arrives here
 * wearing its most persuasive disguise: a perfect score.
 *
 * So publication is a **decision**, not a number.
 */

/* -------------------------------------------------------------------------- */
/* The gates                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Below three tenants, a "cross-tenant aggregate" is one contractor's business with a
 * rounding error attached.
 *
 * Two reasons, and they happen to agree. **Statistically**, a pooled figure over one or
 * two customers is a claim about those customers rather than about the product, and we
 * would be publishing it as though it generalised. **Contractually**, it is
 * near-identifying: a reader who knows we have two customers and sees one worst-tenant
 * rate has been told something about a named plumbing company that the plumbing company
 * did not agree to have published. Nothing in `CohortStats` carries a tenant id — this is
 * the floor that keeps the *arithmetic* from carrying one.
 */
export const MIN_COHORT_TENANTS = 3;

/**
 * The denominator of `correctionRate`, and therefore the number that decides whether the
 * published figure means anything.
 *
 * At 500 bookings a 5% rate carries a 95% Wilson interval of roughly ±1.9 points, which is
 * a claim worth making. At 50 it is ±6 points — an interval so wide that "5%" and "11%"
 * are the same measurement, and quoting the midpoint as *the number nobody else publishes*
 * would be the most sophisticated lie in this repo.
 */
export const MIN_COHORT_BOOKINGS = 500;

/** "M thousand calls" (plan, Step 9), made a number. Bookings gate the rate; calls gate the claim. */
export const MIN_COHORT_CALLS = 1_000;

/**
 * How much of the window's booking volume must have actually been observed.
 *
 * Immature bookings — the ones whose 24h/72h/7d polls have not all run — are excluded from
 * both sides of the ratio, because a booking nobody has re-read yet *cannot* show a
 * correction and would silently dilute the numerator (see `CohortStats.immatureBookings`).
 * That exclusion is correct and it is also an attack surface: a CRM outage that stopped
 * every poll for a fortnight would shrink the cohort down to the bookings that happened to
 * work, and the survivors would publish a lovely number.
 *
 * So coverage is a **gate**, not a footnote. Below 95% we do not publish a rate at all; we
 * publish the fact that we could not observe our own product.
 */
export const MIN_OBSERVED_COVERAGE = 0.95;

/**
 * 1.96 — the two-sided 95% normal quantile, which is what the Wilson score interval takes.
 */
const Z_95 = 1.959963984540054;

/**
 * The 95% Wilson score interval for a proportion.
 *
 * **Wilson rather than the textbook normal approximation**, and the reason is not
 * fastidiousness: `p ± z·sqrt(p(1-p)/n)` degenerates exactly where our numbers will live.
 * At a 1% correction rate over 500 bookings it hands back a *negative* lower bound — a
 * correction rate better than perfect — and at `p = 0` it produces the interval `[0, 0]`,
 * which asserts, with 95% confidence, that we will never make a mistake again. Wilson is
 * defined at both extremes and never leaves `[0, 1]`.
 *
 * We publish it because a bare point estimate invites the reader to believe a precision the
 * sample does not support, and **we are the party who profits from that belief.** Any
 * discipline whose absence would flatter us is a discipline that has to be mechanical.
 */
export function wilsonInterval(
  successes: number,
  trials: number,
  z: number = Z_95,
): { readonly low: number; readonly high: number } {
  if (trials <= 0) return { low: 0, high: 1 };

  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));

  return {
    low: Math.max(0, centre - margin),
    high: Math.min(1, centre + margin),
  };
}

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

/* -------------------------------------------------------------------------- */
/* Which window                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The last complete calendar quarter, in UTC.
 *
 * **The window is derived, never chosen, and that is a discipline rather than a
 * convenience.** A vendor who selects the period they report on has a free parameter worth
 * more than any amount of spin: "the trailing 37 days" catches a good streak, "since the
 * fix shipped" is the same move with an engineering excuse attached, and neither is a lie
 * anyone could prove. A fixed calendar quarter is the same window every time, and — like
 * hashing a booking id to pick the audit sample (Step 6.3) — it is settled **before anyone
 * knows what it will contain**, so a bad quarter cannot be re-rolled into a good one.
 *
 * *Complete*, because a quarter still in progress is mostly bookings too young to have been
 * corrected yet, and those flatter us (`CohortStats.immatureBookings`).
 */
export function lastCompleteQuarter(now: Date): PublicationWindow {
  const quarter = Math.floor(now.getUTCMonth() / 3);
  const year = now.getUTCFullYear();

  // The quarter *before* the one `now` sits in. Q1 wraps to the previous year's Q4.
  const startMonth = quarter === 0 ? 9 : (quarter - 1) * 3;
  const startYear = quarter === 0 ? year - 1 : year;

  const start = new Date(Date.UTC(startYear, startMonth, 1));
  const end = new Date(Date.UTC(startYear, startMonth + 3, 1));

  return { start, end };
}

/** What the caller must supply, because nothing here reads a clock or invents an id. */
export interface PublicationInput {
  readonly cohort: CohortStats;
  readonly id: string;
  readonly publishedAt: string;
}

/**
 * Publish the figure, or withhold it and say exactly what was missing.
 *
 * **Read the list of gates below and note what is not among them: the rate.** There is no
 * branch in this function that reads `correctedBookings / committedBookings` and decides
 * the number is too embarrassing to print. Every reason a report can be withheld is a
 * statement about the *sample* — too few tenants, too few calls, too few bookings, too much
 * of the window unobserved — and every one of them is a reason a reader can check against
 * the cohort we hand back beside it.
 *
 * `publication.test.ts` asserts that a cohort with a **100% correction rate** and an
 * adequate sample publishes 100%. That test is the product. A vendor who retains the
 * option to withhold a figure they dislike has published nothing at all, whatever their
 * website says, and the only way to be believed is to have deleted the option — in code
 * somebody else can read.
 */
export function decidePublication(input: PublicationInput): PublicationDecision {
  const { cohort } = input;

  const totalBookings = cohort.committedBookings + cohort.immatureBookings;
  const observedCoverage = ratio(cohort.committedBookings, totalBookings);

  const reasons: string[] = [];

  if (cohort.tenants < MIN_COHORT_TENANTS) {
    reasons.push(
      `${cohort.tenants} tenants in the cohort; we do not publish a cross-tenant figure below ${MIN_COHORT_TENANTS}, because it would be one contractor's number wearing an average's clothes`,
    );
  }
  if (cohort.calls < MIN_COHORT_CALLS) {
    reasons.push(
      `${cohort.calls} calls; the published figure needs ${MIN_COHORT_CALLS.toLocaleString("en-US")}`,
    );
  }
  if (cohort.committedBookings < MIN_COHORT_BOOKINGS) {
    reasons.push(
      `${cohort.committedBookings} matured bookings; a correction rate over fewer than ${MIN_COHORT_BOOKINGS} has a confidence interval too wide to mean anything`,
    );
  }
  if (observedCoverage < MIN_OBSERVED_COVERAGE) {
    reasons.push(
      `only ${(observedCoverage * 100).toFixed(1)}% of the window's bookings finished their poll schedule (need ${MIN_OBSERVED_COVERAGE * 100}%); a rate computed over the bookings that happened to be observable is a rate bent in our favour`,
    );
  }

  if (reasons.length > 0) {
    return { status: "withheld", reasons, cohort };
  }

  const correctionRate = ratio(cohort.correctedBookings, cohort.committedBookings);
  const agentErrorRate = ratio(cohort.agentErrorBookings, cohort.committedBookings);
  const triageAgreementRate = ratio(cohort.agreedOutcomes, cohort.auditedOutcomes);

  // The rule from Step 6, unchanged and reused rather than restated: the triaged rate is
  // quoted only while a human audit of meaningful size says the classifier tells the truth.
  // A second copy of that decision here is a second copy that could drift from the one the
  // dashboard shows a contractor, and they must not be able to disagree about what we said.
  const published = publishedCorrectionRate({
    correctionRate,
    agentErrorRate,
    auditedOutcomes: cohort.auditedOutcomes,
    triageAgreementRate,
  });

  const interval = wilsonInterval(cohort.correctedBookings, cohort.committedBookings);

  const report: ReliabilityReport = {
    id: input.id,
    methodologyVersion: METHODOLOGY_VERSION,
    windowStart: cohort.windowStart,
    windowEnd: cohort.windowEnd,
    publishedAt: input.publishedAt,

    tenants: cohort.tenants,
    calls: cohort.calls,
    committedBookings: cohort.committedBookings,

    correctionRate,
    correctionRateLow: interval.low,
    correctionRateHigh: interval.high,
    agentErrorRate,

    publishedRate: published.rate,
    publishedBasis: published.basis,
    publishedReason: published.reason,

    auditedOutcomes: cohort.auditedOutcomes,
    triageAgreementRate,

    worstTenantCorrectionRate: cohort.worstTenantCorrectionRate,
    worstTenantBookings: cohort.worstTenantBookings,

    observedCoverage,
  };

  return { status: "published", report };
}
