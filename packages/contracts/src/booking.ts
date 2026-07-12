import { z } from "zod";
import {
  AddressSchema,
  E164Schema,
  IsoTimestampSchema,
  LocaleSchema,
  TimeWindowSchema,
  UrgencySchema,
} from "./primitives.js";

/**
 * Nothing is written to the contractor's CRM from inside the call. The call
 * produces a `PendingBooking`; a durable post-call workflow commits it (plan,
 * principle #3). This is the payload that crosses that boundary.
 *
 * Every field here has already been validated and, where its slot spec demands
 * it, read back to the caller.
 */
export const PendingBookingPayloadSchema = z.object({
  callId: z.string().uuid(),
  tenantId: z.string().uuid(),
  customer: z.object({
    name: z.string().min(1),
    phone: E164Schema,
    locale: LocaleSchema,
  }),
  address: AddressSchema,
  problemDescription: z.string().min(3),
  urgency: UrgencySchema,
  window: TimeWindowSchema,
  /** Tenant-defined job type, resolved during TRIAGE. */
  jobTypeId: z.string().uuid().nullable(),
});
export type PendingBookingPayload = z.infer<typeof PendingBookingPayloadSchema>;

/**
 * Saga lifecycle. `ROLLED_BACK` is distinct from `FAILED`: it asserts the
 * compensating steps ran and the CRM is clean. A booking stuck in `FAILED`
 * needs a human to look at it.
 */
export const BookingStatusSchema = z.enum([
  "PENDING",
  "COMMITTING",
  "COMMITTED",
  "FAILED",
  "ROLLED_BACK",
]);
export type BookingStatus = z.infer<typeof BookingStatusSchema>;

export const CommittedBookingSchema = z.object({
  pendingBookingId: z.string().uuid(),
  crmCustomerId: z.string().min(1),
  crmJobId: z.string().min(1),
  committedAt: IsoTimestampSchema,
});
export type CommittedBooking = z.infer<typeof CommittedBookingSchema>;

/**
 * How we learned the contractor changed something.
 *
 * `CRM_WEBHOOK` used to sit here and is gone on purpose. Webhook support differs
 * across vendors and delivery is at-most-once; a missed webhook reports a 0%
 * correction rate, which is precisely the number a dishonest vendor would
 * publish. A metric whose failure mode is "looks perfect" must not depend on
 * lossy delivery, so we poll (plan, §7). Leaving the variant in the enum would
 * be an invitation to wire one up and silently under-report.
 */
export const OutcomeSourceSchema = z.enum([
  "CRM_POLL",
  "CONTRACTOR_DASHBOARD",
  "MANUAL_AUDIT",
]);
export type OutcomeSource = z.infer<typeof OutcomeSourceSchema>;

/**
 * Was the contractor's edit *our* mistake, a change in the world, or a detail
 * only they could know? Only `agent_error` may ever count against the published
 * correction rate.
 *
 * Written by Step 6's nightly pass, never during a poll. It is a derived column
 * over a raw diff that is retained forever — a model asked whether an edit was
 * its own fault has an obvious bias, and the raw diff is the thing that lets
 * anyone recount.
 */
export const OutcomeClassificationSchema = z.enum([
  "agent_error",
  "business_change",
  "enrichment",
]);
export type OutcomeClassification = z.infer<typeof OutcomeClassificationSchema>;

/**
 * Ground truth (plan, principle #5). Every booking the contractor later edits
 * or cancels is a labeled failure. This closes the loop that idea.md §7 says
 * nobody has closed — and it is the only reliability number that matters.
 */
export const BookingOutcomeSchema = z.object({
  bookingId: z.string().uuid(),
  cancelled: z.boolean(),
  /** Slot keys the contractor had to correct, mapped to their fixed values. */
  correctedFields: z.record(z.string(), z.unknown()),
  source: OutcomeSourceSchema,
  /** Null until Step 6's triage pass runs. Never overwrites the raw diff. */
  classification: OutcomeClassificationSchema.nullable(),
  /** The weekly 10% audit. We publish agreement with the model beside the rate. */
  humanLabel: OutcomeClassificationSchema.nullable(),
  observedAt: IsoTimestampSchema,
});
export type BookingOutcome = z.infer<typeof BookingOutcomeSchema>;

/**
 * The booking failed. Cancelled or edited — either way we got it wrong, and
 * counting the two separately would let us report the flattering half.
 *
 * Defined here rather than in `telemetry` or `workflows` because both compute
 * from it and a disagreement between them is a published number that does not
 * add up: `telemetry` puts these in the numerator of `correctionRate`, and
 * `workflows` sends exactly these — and nothing else — to the triage model. A
 * booking nobody touched has no "why" for a model to invent.
 */
export const isCorrected = (outcome: BookingOutcome): boolean =>
  outcome.cancelled || Object.keys(outcome.correctedFields).length > 0;

/**
 * The label that counts, when a model and a human have both had a go.
 *
 * **The human wins.** The whole reason we run a weekly audit is that the model is
 * the interested party; a tie-break that preferred the model's answer would make
 * the audit decorative. `null` — nobody has labeled it — is *not* an absence of
 * fault: `packages/telemetry` counts an unlabeled correction as an agent error,
 * so a triage backlog can only ever make our published number worse.
 */
export const effectiveLabel = (
  outcome: BookingOutcome,
): OutcomeClassification | null => outcome.humanLabel ?? outcome.classification;

/**
 * **An untriaged correction is an agent error until someone shows otherwise.**
 *
 * This one line is what keeps triage from being a way to make the number look better.
 * `null` — the nightly pass has not run, the model declined, Anthropic was down, the
 * cron is broken — reads as *our fault*, so every failure mode of the triage pipeline
 * pushes the published number *up* toward the raw correction rate. A classifier can only
 * ever lower it, and only by producing an argument a human auditor can check.
 *
 * The inverse — unclassified means "not our fault" — is the missed webhook wearing its
 * third hat (plan, §7): a metric whose failure mode is "looks perfect".
 *
 * **It lives here, in the spine, because three packages now ask it.** `telemetry`
 * publishes the number; `workflows` decides what to send the model; and as of Step 7
 * `billing` decides whether to *charge* for the booking. If those three disagreed about
 * what counts as our fault, we would invoice a contractor for a job we had publicly
 * called our own error — which is the single most expensive sentence anyone could write
 * about this company. Same argument that moved `isCorrected` here in Step 6.
 */
export const isAgentError = (outcome: BookingOutcome): boolean => {
  const label = effectiveLabel(outcome);
  return label === null || label === "agent_error";
};

/**
 * One row per booking: the last thing we saw.
 *
 * The poller re-reads each job at 24h, 72h, and 7d, so one corrected booking arrives as
 * up to three `BookingOutcome` rows. Counting rows put `correctionRate` above 1.0 —
 * a value `ReliabilityMetricsSchema` rejects outright (Step 2, surprise #5) — and it
 * would bill a contractor three times for one job. Ordered by `observedAt` rather than
 * array position, because a cron guarantees no ordering.
 *
 * A contractor who fixed an address and then cancelled outright has told us the booking
 * failed once.
 */
export function latestPerBooking(
  outcomes: readonly BookingOutcome[],
): BookingOutcome[] {
  const latest = new Map<string, BookingOutcome>();
  for (const outcome of outcomes) {
    const seen = latest.get(outcome.bookingId);
    if (!seen || Date.parse(outcome.observedAt) >= Date.parse(seen.observedAt)) {
      latest.set(outcome.bookingId, outcome);
    }
  }
  return [...latest.values()];
}
