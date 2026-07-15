import type {
  Address,
  PendingBookingPayload,
  TimeWindow,
  Urgency,
} from "@ledgerline/contracts";
import type { MachineContext } from "@ledgerline/conversation";

/**
 * Everything about a `PendingBooking` that the conversation does not carry:
 * whose line the call came in on, and which tenant job type TRIAGE resolved to.
 */
export interface BookingMeta {
  readonly callId: string;
  readonly tenantId: string;
  /** Resolved during TRIAGE from the tenant's job catalog; null if unmapped. */
  readonly jobTypeId: string | null;
  /**
   * Rides the booking to the CRM so a human knows what language to call back
   * in. The product is English-only and nothing branches on it (plan, Step 0),
   * so it defaults to `en`.
   */
  readonly locale?: PendingBookingPayload["customer"]["locale"];
}

/**
 * Assemble the payload that crosses the call → workflow boundary.
 *
 * Only ever called on `CREATE_PENDING_BOOKING`, which the machine emits exactly
 * once, on the transition into CLOSE — and CLOSE is reachable only when every
 * slot is filled and every read-back is satisfied. So every value here has been
 * validated and, where its slot spec demands it, read back to the caller. A
 * missing slot at this point is a machine bug, and `readSlot` throws rather than
 * shipping an `undefined` to the contractor's calendar.
 */
export function buildPendingBooking(
  ctx: MachineContext,
  meta: BookingMeta,
): PendingBookingPayload {
  return {
    callId: meta.callId,
    tenantId: meta.tenantId,
    customer: {
      name: readSlot<string>(ctx, "caller_name"),
      phone: readSlot<string>(ctx, "callback_phone"),
      locale: meta.locale ?? "en",
    },
    address: readSlot<Address>(ctx, "service_address"),
    problemDescription: readSlot<string>(ctx, "problem_description"),
    urgency: readSlot<Urgency>(ctx, "urgency"),
    window: readSlot<TimeWindow>(ctx, "appointment_window"),
    jobTypeId: meta.jobTypeId,
  };
}

function readSlot<T>(ctx: MachineContext, key: Parameters<MachineContext["slots"]["get"]>[0]): T {
  const entry = ctx.slots.get(key);
  if (entry === undefined) {
    // Reaching CLOSE without this slot is impossible through `transition`; if it
    // happened, a booking with a hole in it is worse than a loud crash.
    throw new Error(`cannot build PendingBooking: slot "${key}" is not filled`);
  }
  return entry.value as T;
}
