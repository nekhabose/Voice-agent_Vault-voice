import {
  recordingsExpireBefore,
  transcriptsExpireBefore,
} from "@ledgerline/compliance";
import type { Clock, RecordingArchive, RetentionStore } from "@ledgerline/contracts";

/**
 * The deletion cron (plan, Step 8 — "recording retention and deletion policy").
 *
 * A retention policy is a promise made to somebody who will never check. That is what
 * makes it the third member of a family this repo already has two of: the outcome
 * poller, whose failure looks like a perfect correction rate, and the triage batch,
 * whose failure looks like a night with no corrections. **A retention job that never
 * runs looks like nothing at all** — there is no dashboard on which "we still have
 * 40,000 recordings we told people we had deleted" appears, unless somebody builds one.
 *
 * So the report is the point, and the invariants are the poller's, in the same order
 * and for the same reason:
 *
 * 1. **A failure does not abort the batch.** The remaining calls are independent.
 * 2. **A failed delete does not tombstone.** The media may still exist, and a row that
 *    says `recording_deleted_at` over audio still sitting in a carrier's bucket is not
 *    a bug in a job — it is a false statement about somebody's voice, and the next run
 *    would never look at that call again.
 * 3. **Media first, tombstone second.** Reverse the order and (2) is unavoidable.
 *
 * `RetentionReport.recordingsFailed` is what a person is supposed to look at, and it is
 * the number that must be zero.
 */

export interface RetentionDeps {
  readonly store: RetentionStore;
  /** Where the audio actually is. A store with no archive deletes nothing. */
  readonly archive: RecordingArchive;
  readonly clock: Clock;
}

export interface RetentionReport {
  readonly recordingsExpired: number;
  /** Gone from the vendor, and tombstoned here. */
  readonly recordingsDeleted: number;
  /**
   * The vendor refused. **The deletion is still owed**, nothing was tombstoned, and the
   * next run picks the call up again. This number being non-zero for two runs running
   * is a promise we are quietly breaking.
   */
  readonly recordingsFailed: number;
  readonly transcriptsRedacted: number;
}

/** A cap, not a target — the same shape as `POLL_BATCH_LIMIT`. */
export const RETENTION_BATCH_LIMIT = 500;

export async function runRetention(
  deps: RetentionDeps,
  options: { readonly limit?: number } = {},
): Promise<RetentionReport> {
  const now = deps.clock.now();
  const limit = options.limit ?? RETENTION_BATCH_LIMIT;

  const expired = await deps.store.expiredRecordings(recordingsExpireBefore(now), limit);

  let recordingsDeleted = 0;
  let recordingsFailed = 0;

  for (const recording of expired) {
    try {
      // Throws unless the media is *gone* — a `404` from the vendor is `already_absent`,
      // which is the same fact arrived at by a previous run that crashed between these
      // two lines. Anything else and we do not get to write the tombstone.
      await deps.archive.delete(recording.recordingUrl);
      await deps.store.markRecordingDeleted(recording.callId, now);
      recordingsDeleted += 1;
    } catch {
      recordingsFailed += 1;
    }
  }

  // Separate pass, separate window, and deliberately not gated on the first one
  // succeeding: the transcript is *our* text in *our* database, and a carrier outage
  // must not be a reason we keep a caller's words for another day.
  const stale = await deps.store.expiredTranscripts(transcriptsExpireBefore(now), limit);
  for (const callId of stale) {
    await deps.store.redactTranscript(callId, now);
  }

  return {
    recordingsExpired: expired.length,
    recordingsDeleted,
    recordingsFailed,
    transcriptsRedacted: stale.length,
  };
}
