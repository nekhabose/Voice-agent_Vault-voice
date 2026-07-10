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
