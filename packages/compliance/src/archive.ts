import type {
  HttpTransport,
  RecordingArchive,
  RecordingDeletion,
} from "@ledgerline/contracts";

/**
 * Deleting a recording from the telephony vendor that holds it.
 *
 * A retention policy that only nulls a column in *our* database has not deleted
 * anything. The audio lives at the carrier — Twilio, in the design `plan.md` Step 4.2
 * sketches — and a row saying `recording_url = NULL` beside a recording that is still
 * sitting in somebody's bucket is not a retention policy. It is a retention policy's
 * paperwork.
 *
 * So the media is deleted first and the tombstone is written second, and
 * `runRetention()` does not tombstone a deletion that failed. Same shape as the
 * poller's "a failed poll does not consume the poll it still owes" — the difference is
 * that here the thing we would owe is the deletion of somebody's voice.
 *
 * **This has never spoken to a live vendor**, and there is no telephony account to
 * speak to (Step 4.2). It is real code behind the `HttpTransport` port, driven in tests
 * against transcribed wire shapes, which is the same honest status as `GoogleGeocoder`
 * and both CRM adapters. What it does with a *real* carrier's response is task 8.6.
 */
export class HttpRecordingArchive implements RecordingArchive {
  constructor(private readonly transport: HttpTransport) {}

  /**
   * `DELETE` the recording resource.
   *
   * **A `404` is `already_absent`, not a failure**, and the distinction is the one
   * that decides whether this job ever finishes. Deletion is not idempotent from the
   * caller's side: a run that deleted the media and then crashed before writing the
   * tombstone leaves a row pointing at a recording that is already gone. Treating that
   * `404` as an error would make the retention job retry it forever, and the retention
   * backlog would grow with exactly the recordings it had successfully deleted.
   *
   * Everything else throws. A `500` from the carrier means the recording may still
   * exist, and a job that shrugged at that would write "deleted" over audio it had
   * not deleted — a lie told to the one person we told the truth to.
   */
  async delete(recordingUrl: string): Promise<RecordingDeletion> {
    const response = await this.transport.send({
      method: "DELETE",
      path: recordingUrl,
    });

    if (response.status === 404) return "already_absent";
    if (response.status >= 200 && response.status < 300) return "deleted";

    throw new Error(
      `recording archive refused to delete ${recordingUrl}: HTTP ${response.status}`,
    );
  }
}

/** Records what it was asked to delete, and can be made to fail. */
export class FakeRecordingArchive implements RecordingArchive {
  readonly deleted: string[] = [];

  constructor(
    private readonly options: {
      /** URLs this archive refuses. The recording is still out there; the poll is still owed. */
      readonly failing?: readonly string[];
      /** URLs the vendor has already lost. Deleted, from our point of view. */
      readonly absent?: readonly string[];
    } = {},
  ) {}

  async delete(recordingUrl: string): Promise<RecordingDeletion> {
    if (this.options.failing?.includes(recordingUrl)) {
      throw new Error(`archive unavailable for ${recordingUrl}`);
    }
    this.deleted.push(recordingUrl);
    return this.options.absent?.includes(recordingUrl) ? "already_absent" : "deleted";
  }
}
