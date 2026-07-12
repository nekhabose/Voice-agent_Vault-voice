import {
  BookingOutcomeSchema,
  type AddressInput,
  type BookingOutcome,
  type Clock,
  type JobSnapshotRecord,
  type PendingBookingPayload,
  type SlotKey,
  type SnapshotStore,
  type TimeWindow,
} from "@ledgerline/contracts";
import type { CrmAdapter, CrmJobRef, CrmJobSnapshot } from "@ledgerline/crm";

/**
 * `SnapshotStore` and `JobSnapshotRecord` moved into `contracts` in Step 7:
 * `packages/db` implements them, and a port that crosses a package boundary
 * belongs in the spine (the same argument that moved `Effect` in Step 3 and
 * `HttpTransport` in Step 4). Re-exported here because this is where they are
 * *used*, exactly as `machine.ts` re-exports `Effect`.
 */
export type { JobSnapshotRecord, SnapshotStore };

/**
 * The wedge, made mechanical.
 *
 * `idea.md` §7's biggest open question is that nobody publishes field-deployment
 * reliability numbers for voice agents. `outcomes.correctedFields` is that
 * number: every booking the contractor later edits or cancels is a labeled
 * failure, and this file is what labels it.
 *
 * Two properties are load-bearing, and both are ways of *not* flattering
 * ourselves:
 *
 *   1. **Change detection is polled, never webhooked** (plan, §7). Webhook
 *      delivery is at-most-once and vendor support is uneven; a missed webhook
 *      reports a 0% correction rate. A metric whose failure mode is "looks
 *      perfect" must not depend on lossy delivery.
 *   2. **A failed poll emits nothing.** `readJob` throws on an outage, and this
 *      module lets it. Recording "no corrections observed" because the CRM was
 *      down is the same lie as the missed webhook, arrived at more honestly.
 */

const HOUR_MS = 60 * 60 * 1000;

/**
 * When we re-read a job after committing it.
 *
 * 24h catches the dispatcher fixing the address before the truck rolls; 72h
 * catches the reschedule; 7d catches the cancellation nobody told us about.
 * Stopping at 7d is a guess, and the distribution of *when* corrections land is
 * itself a number worth publishing once we have one.
 */
export const POLL_OFFSETS_MS: readonly number[] = [24 * HOUR_MS, 72 * HOUR_MS, 7 * 24 * HOUR_MS];

/** The ISO instants at which this booking is due to be re-read. */
export function pollSchedule(committedAt: string): string[] {
  const base = Date.parse(committedAt);
  return POLL_OFFSETS_MS.map((offset) => new Date(base + offset).toISOString());
}

/**
 * The index of the next poll that is due, or `null` if none is.
 *
 * `completedPolls` rather than a timestamp because the poller is a cron, and a
 * cron that missed a window must still run the poll it owed — not skip it and
 * pretend the booking was never corrected.
 */
export function nextDuePoll(
  committedAt: string,
  completedPolls: number,
  now: Date,
): number | null {
  if (completedPolls >= POLL_OFFSETS_MS.length) return null;
  const due = pollSchedule(committedAt)[completedPolls]!;
  return Date.parse(due) <= now.getTime() ? completedPolls : null;
}

/* -------------------------------------------------------------------------- */
/* Snapshot storage                                                            */
/* -------------------------------------------------------------------------- */

/** The test double. `PgSnapshotStore` in `packages/db` is the one that ships. */
export class InMemorySnapshotStore implements SnapshotStore {
  readonly records: JobSnapshotRecord[] = [];

  async record(snapshot: JobSnapshotRecord): Promise<void> {
    this.records.push(snapshot);
  }
}

/* -------------------------------------------------------------------------- */
/* The diff                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The slots a CRM can tell us about.
 *
 * `urgency` and `jobTypeId` are absent because Housecall Pro stores urgency as a
 * job tag and Jobber has nowhere to put it at all. A field only one adapter can
 * report is a field whose correction rate differs by provider for reasons that
 * have nothing to do with the agent — see `CrmJobSnapshot`.
 */
export const DIFFABLE_SLOTS: readonly SlotKey[] = [
  "caller_name",
  "callback_phone",
  "service_address",
  "problem_description",
  "appointment_window",
];

/** Collapse whitespace and case. A CRM title-casing a name is not a correction. */
const norm = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Compare phone numbers on their digits.
 *
 * We store `+13055551234`; Housecall Pro echoes `(305) 555-1234`. Comparing the
 * strings would report a corrected callback number on every booking ever made.
 * The leading NANP `1` is dropped so the two agree.
 */
function samePhone(ours: string, theirs: string): boolean {
  const digits = (value: string): string => {
    const only = value.replace(/\D/g, "");
    return only.length === 11 && only.startsWith("1") ? only.slice(1) : only;
  };
  return digits(ours) === digits(theirs);
}

/**
 * Compare on the five fields the caller actually said.
 *
 * `formatted`, `lat`, and `lng` are our geocoder's output and no CRM will ever
 * echo them (principle #3). ZIP+4 is compared on the first five digits: a CRM
 * enriching `33135` to `33135-2841` has added information, not corrected us.
 */
function sameAddress(ours: AddressInput, theirs: AddressInput): boolean {
  const zip = (value: string): string => value.slice(0, 5);
  return (
    norm(ours.line1) === norm(theirs.line1) &&
    norm(ours.line2 ?? "") === norm(theirs.line2 ?? "") &&
    norm(ours.city) === norm(theirs.city) &&
    norm(ours.state) === norm(theirs.state) &&
    zip(ours.postalCode) === zip(theirs.postalCode)
  );
}

/** Instants, not strings. `2026-07-09T18:00:00Z` and `...T14:00:00-04:00` agree. */
function sameWindow(ours: TimeWindow, theirs: TimeWindow): boolean {
  return (
    Date.parse(ours.startsAt) === Date.parse(theirs.startsAt) &&
    Date.parse(ours.endsAt) === Date.parse(theirs.endsAt)
  );
}

/**
 * What the contractor changed, keyed by slot, valued at their fix.
 *
 * **A null field is never a correction.** The CRM not returning a description,
 * or a deleted job returning nothing at all, tells us the field was not
 * observed — not that it was wrong. Treating absence as a correction would let a
 * vendor's field rename read as an agent that suddenly got everything wrong.
 */
export function diffBooking(
  payload: PendingBookingPayload,
  snapshot: CrmJobSnapshot,
): Partial<Record<SlotKey, unknown>> {
  const corrected: Partial<Record<SlotKey, unknown>> = {};

  const { name, phone } = snapshot.customer;
  if (name !== null && norm(payload.customer.name) !== norm(name)) {
    corrected.caller_name = name;
  }
  if (phone !== null && !samePhone(payload.customer.phone, phone)) {
    corrected.callback_phone = phone;
  }
  if (snapshot.address !== null && !sameAddress(payload.address, snapshot.address)) {
    corrected.service_address = snapshot.address;
  }
  if (
    snapshot.description !== null &&
    norm(payload.problemDescription) !== norm(snapshot.description)
  ) {
    corrected.problem_description = snapshot.description;
  }
  if (snapshot.window !== null && !sameWindow(payload.window, snapshot.window)) {
    corrected.appointment_window = snapshot.window;
  }

  return corrected;
}

/* -------------------------------------------------------------------------- */
/* The poll                                                                    */
/* -------------------------------------------------------------------------- */

export interface OutcomeDeps {
  /**
   * Read-only, by type. The poller observes the contractor's CRM; it never
   * writes to it. Narrowing the port here means a future edit that "helpfully"
   * re-syncs a corrected field back into the CRM does not typecheck — which is
   * the point, because a metric that repairs the thing it measures measures
   * nothing.
   */
  readonly crm: Pick<CrmAdapter, "readJob">;
  readonly clock: Clock;
  readonly snapshots: SnapshotStore;
}

/**
 * Re-read one committed booking and label it.
 *
 * Throws whatever `readJob` throws. That is the contract: a `CrmError` reaches
 * the cron, which retries the poll later. Catching it here and returning an
 * empty `BookingOutcome` would publish a perfect score out of an outage.
 *
 * The raw payload is stored *before* the diff runs, so a bug in `diffBooking`
 * costs us a wrong label rather than the evidence.
 */
export async function observeOutcome(
  bookingId: string,
  payload: PendingBookingPayload,
  job: CrmJobRef,
  deps: OutcomeDeps,
): Promise<BookingOutcome> {
  const snapshot = await deps.crm.readJob(job, {
    idempotencyKey: `${bookingId}:read_job`,
  });

  const observedAt = deps.clock.now().toISOString();
  await deps.snapshots.record({ bookingId, polledAt: observedAt, payload: snapshot.raw });

  return BookingOutcomeSchema.parse({
    bookingId,
    cancelled: snapshot.status === "CANCELLED" || snapshot.status === "DELETED",
    correctedFields: diffBooking(payload, snapshot),
    source: "CRM_POLL",
    classification: null,
    humanLabel: null,
    observedAt,
  });
}
