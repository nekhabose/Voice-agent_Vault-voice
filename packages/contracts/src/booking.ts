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
 * Ground truth (plan, principle #5). Every booking the contractor later edits
 * or cancels is a labeled failure. This closes the loop that idea.md §7 says
 * nobody has closed — and it is the only reliability number that matters.
 */
export const BookingOutcomeSchema = z.object({
  bookingId: z.string().uuid(),
  cancelled: z.boolean(),
  /** Slot keys the contractor had to correct, mapped to their fixed values. */
  correctedFields: z.record(z.string(), z.unknown()),
  source: z.enum(["CRM_WEBHOOK", "CONTRACTOR_DASHBOARD", "MANUAL_AUDIT"]),
  observedAt: IsoTimestampSchema,
});
export type BookingOutcome = z.infer<typeof BookingOutcomeSchema>;
