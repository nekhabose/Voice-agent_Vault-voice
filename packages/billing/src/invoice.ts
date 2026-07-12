import {
  isAgentError,
  isCorrected,
  latestPerBooking,
  type BookingOutcome,
} from "@ledgerline/contracts";

/**
 * Billing, per booked job (plan, Step 7).
 *
 * "Per booked job rather than per minute — align our incentive with theirs." Per-minute
 * pricing pays us to keep a homeowner on the phone, which is the opposite of the product.
 * Per-booking pricing pays us when a job appears on the contractor's calendar.
 *
 * But it does not stop there, and the part that does not stop there is the whole file:
 *
 * **We do not bill for a booking we got wrong.**
 *
 * A contractor who has to fix the address we captured did the job we charged them to do.
 * Charging for it anyway would mean *our own error rate is a revenue stream* — and we
 * are the company that publishes its error rate. The two claims cannot both be made by
 * the same business, and this is the one that has to give.
 *
 * So `billable` is exactly `!cancelled && !isAgentError(outcome)`, and `isAgentError`
 * is imported from `contracts` rather than restated here, because `packages/telemetry`
 * computes the number we *publish* from the same predicate. If they drifted, we would
 * invoice a contractor for a booking we had publicly called our own error.
 *
 * ## An unclassified correction is unbilled
 *
 * `isAgentError` counts a `null` label as our fault (Step 6's inversion). Carried into
 * billing, that means a triage backlog, a declined verdict, an Anthropic outage, or a
 * cron nobody wired up all cost us **money**, not just a worse published number. Every
 * failure mode of this pipeline now has a price, and we pay it.
 *
 * That is deliberate and it is the safe direction. The alternative — bill it, refund it
 * later if triage says it was ours — is a company that profits from its own broken cron.
 *
 * **Which means the invoice is computed after triage has run for the period**, or we
 * waive revenue we would have earned. `runTriage()` is nightly; invoicing is monthly.
 * The order is not an accident, and `staleTriage` reports on it rather than silently
 * absorbing it.
 */

/** One job that reached the contractor's CRM. */
export interface CommittedJob {
  readonly bookingId: string;
  /** ISO. Decides which period the job falls in. */
  readonly committedAt: string;
}

export type WaiverReason =
  /** The contractor cancelled the job outright. The loudest correction there is. */
  | "cancelled"
  /** Triage (or a human) says the contractor's edit was our mistake. */
  | "agent_error"
  /**
   * The contractor edited it and nobody has said why yet.
   *
   * Not billed. `null` is guilt, not innocence — the same rule `agentErrorRate` runs on.
   * Distinguished from `agent_error` in the *reason* so a dashboard can tell "we were
   * wrong" from "our triage pipeline is behind", which are different problems with the
   * same price.
   */
  | "untriaged";

export interface InvoiceLine {
  readonly bookingId: string;
  readonly amountCents: number;
  /** Null when we billed for it. */
  readonly waived: WaiverReason | null;
}

export interface Invoice {
  readonly tenantId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  /** Jobs committed in the period. The thing the contractor actually got. */
  readonly booked: number;
  readonly billed: number;
  readonly waived: number;
  readonly totalCents: number;
  /**
   * Waived only because nobody has classified the correction yet.
   *
   * Revenue we may be owed and are not claiming. It is not an error — it is the price of
   * "null is guilt" — but it is money, so it is *reported* rather than absorbed. A number
   * that climbs means the nightly triage pass is not running, and the first symptom of a
   * broken cron should not be a quiet drop in revenue.
   */
  readonly staleTriage: number;
  readonly lines: readonly InvoiceLine[];
}

export interface InvoiceInput {
  readonly tenantId: string;
  /** ISO, inclusive. */
  readonly periodStart: string;
  /** ISO, exclusive — so consecutive months cannot double-bill a midnight commit. */
  readonly periodEnd: string;
  readonly jobs: readonly CommittedJob[];
  /** Every observation of every booking. Reduced to the latest per booking. */
  readonly outcomes: readonly BookingOutcome[];
  readonly pricePerBookingCents: number;
}

export function invoiceFor(input: InvoiceInput): Invoice {
  const start = Date.parse(input.periodStart);
  const end = Date.parse(input.periodEnd);

  const inPeriod = input.jobs.filter((job) => {
    const at = Date.parse(job.committedAt);
    return at >= start && at < end;
  });

  // The latest observation of each booking wins. Three polls per booking would otherwise
  // let one corrected job be waived once and billed twice.
  const latest = new Map(
    latestPerBooking(input.outcomes).map((outcome) => [outcome.bookingId, outcome]),
  );

  const lines = inPeriod.map((job): InvoiceLine => {
    const outcome = latest.get(job.bookingId);
    const waived = waiverFor(outcome);
    return {
      bookingId: job.bookingId,
      amountCents: waived === null ? input.pricePerBookingCents : 0,
      waived,
    };
  });

  const billedLines = lines.filter((line) => line.waived === null);

  return {
    tenantId: input.tenantId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    booked: inPeriod.length,
    billed: billedLines.length,
    waived: lines.length - billedLines.length,
    totalCents: billedLines.reduce((sum, line) => sum + line.amountCents, 0),
    staleTriage: lines.filter((line) => line.waived === "untriaged").length,
    lines,
  };
}

/**
 * Why we are not charging for this one — or `null`, meaning we are.
 *
 * A booking with no outcome at all is **billed**: the poller looks three times over seven
 * days and found nothing to report, which is the agent doing its job. Not-corrected and
 * not-yet-polled are the same state here, and that is the one place this file's caution
 * runs the other way — a booking committed yesterday has not been polled yet. The
 * invoice is drawn at period close, by which time the 7d poll has run for every job in it.
 */
function waiverFor(outcome: BookingOutcome | undefined): WaiverReason | null {
  if (outcome === undefined) return null;
  if (outcome.cancelled) return "cancelled";
  if (!isCorrected(outcome)) return null;
  if (!isAgentError(outcome)) return null;

  // Corrected, and ours. The only question left is whether anyone has said *why*.
  return outcome.humanLabel === null && outcome.classification === null
    ? "untriaged"
    : "agent_error";
}
