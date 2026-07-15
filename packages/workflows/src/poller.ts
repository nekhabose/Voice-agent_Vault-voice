import type {
  BookingStore,
  Clock,
  OutcomeStore,
  SnapshotStore,
} from "@ledgerline/contracts";
import type { CrmAdapter } from "@ledgerline/crm";
import { nextDuePoll, observeOutcome, POLL_OFFSETS_MS } from "./outcomes.js";

/**
 * The cron body (plan, Step 7).
 *
 * `observeOutcome()` has been able to re-read one booking since Step 2, and
 * `pollSchedule()` has been able to say when a booking is *due* — but nothing called
 * either, and `bookings.completed_polls` was a column nobody incremented. This is what
 * calls them, and `apps/web/app/api/cron/poll-outcomes` is what calls this.
 *
 * Three rules, and all three are the same rule: **a poll we failed to run must not look
 * like a booking nobody corrected.**
 *
 *   1. **A failure does not abort the batch.** The remaining bookings are independent,
 *      and a run that stops at the first `503` leaves every later booking unpolled.
 *   2. **A failure does not increment `completedPolls`.** The poll is still owed. This
 *      is the whole reason the column is a counter and not a timestamp: a cron that
 *      missed its window still owes the poll it missed (plan, §7).
 *   3. **A failure records nothing.** `readJob` throws on a `429`/`5xx`/dead socket and
 *      `observeOutcome` lets it; catching it and writing an empty `BookingOutcome` would
 *      publish a perfect score out of an outage — the missed-webhook failure mode, which
 *      this entire subsystem exists to refuse.
 *
 * Every failure mode of this file therefore leaves a correction *uncounted for now* and
 * *counted later*, never *silently absent*. It is the same inversion as Step 6's
 * "unclassified is an agent error": the pipeline breaking must never flatter us.
 */

export interface PollDeps {
  /**
   * Read-only, by type (Step 2, surprise #4). The poller observes the contractor's CRM
   * and never writes to it, so a future edit that "helpfully" re-syncs a corrected field
   * back does not compile. A metric that repairs the thing it measures measures nothing.
   */
  readonly crm: Pick<CrmAdapter, "readJob">;
  readonly bookings: BookingStore;
  readonly outcomes: OutcomeStore;
  readonly snapshots: SnapshotStore;
  readonly clock: Clock;
}

export interface PollReport {
  /** Bookings the store offered — committed long enough ago to *possibly* owe a poll. */
  readonly considered: number;
  /** Re-read, diffed, and recorded. */
  readonly polled: number;
  /** Offered, but the next offset has not come round yet. */
  readonly notYetDue: number;
  /**
   * The CRM could not be read. **The poll is still owed** — `completedPolls` was not
   * incremented, so the next run picks the booking up again.
   */
  readonly failed: number;
}

/** A cap, not a target. The store decides what is due; this decides how much per run. */
export const POLL_BATCH_LIMIT = 200;

export async function runOutcomePolls(
  deps: PollDeps,
  options: { readonly limit?: number } = {},
): Promise<PollReport> {
  const now = deps.clock.now();

  // The coarse filter: nothing committed more recently than the *first* offset can be
  // due for anything. The exact schedule is `nextDuePoll`'s, below — the store must not
  // know it, or a product decision (when a correction is likely to land) ends up living
  // in a SQL file.
  const earliest = new Date(now.getTime() - POLL_OFFSETS_MS[0]!);

  const candidates = await deps.bookings.unfinished(
    earliest,
    POLL_OFFSETS_MS.length,
    options.limit ?? POLL_BATCH_LIMIT,
  );

  let polled = 0;
  let notYetDue = 0;
  let failed = 0;

  for (const booking of candidates) {
    if (nextDuePoll(booking.committedAt, booking.completedPolls, now) === null) {
      notYetDue += 1;
      continue;
    }

    try {
      const outcome = await observeOutcome(
        booking.bookingId,
        booking.booked,
        { id: booking.crmJobId },
        { crm: deps.crm, clock: deps.clock, snapshots: deps.snapshots },
      );

      // Record the outcome *before* consuming the poll. If the order were reversed and
      // the write failed, the booking would count as polled and never be looked at
      // again — an unobserved correction, which reads as a better number than the truth.
      await deps.outcomes.record(outcome);
      await deps.bookings.recordPoll(booking.bookingId);
      polled += 1;
    } catch {
      // Deliberately swallowed *here* and nowhere else: the batch continues, and the
      // booking keeps its `completedPolls`, so the next run owes it the same poll.
      failed += 1;
    }
  }

  return { considered: candidates.length, polled, notYetDue, failed };
}
