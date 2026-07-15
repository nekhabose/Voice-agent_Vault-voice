import { transactionalSms } from "@ledgerline/compliance";
import {
  PendingBookingPayloadSchema,
  type Clock,
  type CommittedBooking,
  type PendingBookingPayload,
  type Sleep,
} from "@ledgerline/contracts";
import type { CrmAdapter, OpContext } from "@ledgerline/crm";
import {
  RollbackFailure,
  Saga,
  type Journal,
  type RetryPolicy,
} from "./saga.js";
import { confirmationBody, type SmsSender } from "./sms.js";

export interface BookingDeps {
  readonly crm: CrmAdapter;
  readonly sms: SmsSender;
  readonly journal: Journal;
  readonly clock: Clock;
  /** Tenant's IANA zone, for the confirmation message. */
  readonly timeZone: string;
  readonly retry?: RetryPolicy;
  readonly sleep?: Sleep;
}

export type BookingResult =
  | {
      readonly status: "COMMITTED";
      readonly booking: CommittedBooking;
      /** A booked job with no text is a nuisance, not a failure. */
      readonly smsDelivered: boolean;
    }
  | { readonly status: "ROLLED_BACK"; readonly reason: string }
  /** Compensation itself failed. The CRM is in an unknown state. */
  | { readonly status: "FAILED"; readonly reason: string; readonly needsHumanReview: true };

export const BOOKING_STEPS = {
  customer: "create_customer",
  location: "ensure_location",
  job: "create_job",
  sms: "send_sms",
} as const;

/**
 * Commit a `PendingBooking` to the contractor's CRM.
 *
 * Runs *after* the call has ended and every consequential slot has been read
 * back to the caller. Nothing here talks to a model. The multi-step
 * `lookup → create → schedule → notify` chain that VoiceAgentBench shows models
 * completing 5–15% of the time is executed as a deterministic transaction with
 * retries and compensating rollback (plan, principle #1 and #3).
 */
export async function commitBooking(
  pendingBookingId: string,
  payload: PendingBookingPayload,
  deps: BookingDeps,
): Promise<BookingResult> {
  const parsed = PendingBookingPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    // A malformed payload cannot be fixed by retrying, and must never reach the
    // contractor's calendar.
    return {
      status: "FAILED",
      reason: `invalid booking payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      needsHumanReview: true,
    };
  }
  const booking = parsed.data;

  const saga = new Saga({
    journal: deps.journal,
    ...(deps.retry ? { retry: deps.retry } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });

  // Deterministic per (call, step), so a retry or a resume reuses the key and
  // the vendor de-duplicates for us.
  const key = (step: string): OpContext => ({
    idempotencyKey: `${booking.callId}:${step}`,
  });

  let crmCustomerId: string;
  let crmJobId: string;

  try {
    const customer = await saga.step(
      BOOKING_STEPS.customer,
      () => deps.crm.upsertCustomer(booking.customer, key(BOOKING_STEPS.customer)),
      (ref) => deps.crm.revokeCustomer(ref, key(`${BOOKING_STEPS.customer}:undo`)),
    );

    // No compensation. An address attached to a customer is inert, and deleting
    // one risks removing an address the customer already had.
    const location = await saga.step(BOOKING_STEPS.location, () =>
      deps.crm.ensureServiceLocation(customer, booking.address, key(BOOKING_STEPS.location)),
    );

    const job = await saga.step(
      BOOKING_STEPS.job,
      () =>
        deps.crm.createJob(
          {
            customer,
            location,
            window: booking.window,
            description: booking.problemDescription,
            urgency: booking.urgency,
            jobTypeId: booking.jobTypeId,
          },
          key(BOOKING_STEPS.job),
        ),
      (ref) => deps.crm.revokeJob(ref, key(`${BOOKING_STEPS.job}:undo`)),
    );

    crmCustomerId = customer.id;
    crmJobId = job.id;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await saga.rollback(error);
    } catch (rollbackError) {
      const detail =
        rollbackError instanceof RollbackFailure
          ? `${reason}; rollback failed at ${rollbackError.step}`
          : reason;
      return { status: "FAILED", reason: detail, needsHumanReview: true };
    }
    return { status: "ROLLED_BACK", reason };
  }

  // The SMS sits outside the transaction on purpose. You cannot unsend a text,
  // and cancelling a correctly-booked job because a carrier hiccuped would turn
  // a notification problem into a lost customer.
  //
  // `transactionalSms` is the only way to build a message `SmsSender` will accept, and
  // it takes the booking rather than a number (Step 8). The destination is not a
  // decision this function gets to make: it is `booking.customer.phone`, the slot the
  // caller gave us and heard read back.
  let smsDelivered = true;
  try {
    await saga.step(BOOKING_STEPS.sms, async () => {
      await deps.sms.send(
        transactionalSms(
          booking,
          confirmationBody(booking.address.formatted, booking.window, deps.timeZone),
        ),
      );
      return null;
    });
  } catch {
    smsDelivered = false;
  }

  return {
    status: "COMMITTED",
    booking: {
      pendingBookingId,
      crmCustomerId,
      crmJobId,
      committedAt: deps.clock.now().toISOString(),
    },
    smsDelivered,
  };
}
