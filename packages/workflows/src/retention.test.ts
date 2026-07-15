import { FakeRecordingArchive, RECORDING_RETENTION_DAYS } from "@ledgerline/compliance";
import { fixedClock, type ExpiredRecording, type RetentionStore } from "@ledgerline/contracts";
import { describe, expect, it } from "vitest";
import { runRetention } from "./retention.js";

const NOW = "2026-07-11T03:00:00.000Z";

/**
 * A store that answers from a script and records what it was told, so the assertions are
 * about what the collaborator *saw* — the repo's convention, and the only way to catch the
 * bug this file exists for: a tombstone written over a recording that still exists.
 */
class FakeRetentionStore implements RetentionStore {
  readonly tombstoned: string[] = [];
  readonly redacted: string[] = [];

  constructor(
    private readonly recordings: readonly ExpiredRecording[] = [],
    private readonly transcripts: readonly string[] = [],
  ) {}

  async expiredRecordings(_before: Date, limit: number): Promise<readonly ExpiredRecording[]> {
    return this.recordings.slice(0, limit);
  }

  async markRecordingDeleted(callId: string): Promise<void> {
    this.tombstoned.push(callId);
  }

  async expiredTranscripts(_before: Date, limit: number): Promise<readonly string[]> {
    return this.transcripts.slice(0, limit);
  }

  async redactTranscript(callId: string): Promise<void> {
    this.redacted.push(callId);
  }
}

const recording = (n: number): ExpiredRecording => ({
  callId: `call-${n}`,
  recordingUrl: `/rec/${n}`,
});

const deps = (store: RetentionStore, archive = new FakeRecordingArchive()) => ({
  store,
  archive,
  clock: fixedClock(NOW),
});

describe("runRetention", () => {
  it("deletes the media, then writes the tombstone", async () => {
    const store = new FakeRetentionStore([recording(1), recording(2)]);
    const archive = new FakeRecordingArchive();

    const report = await runRetention(deps(store, archive));

    expect(archive.deleted).toEqual(["/rec/1", "/rec/2"]);
    expect(store.tombstoned).toEqual(["call-1", "call-2"]);
    expect(report).toMatchObject({
      recordingsExpired: 2,
      recordingsDeleted: 2,
      recordingsFailed: 0,
    });
  });

  /**
   * **The mutation this file exists to catch.** Swap the two lines in `runRetention` so the
   * tombstone is written before the archive is called, and this is the only test that
   * fails.
   *
   * A row saying `recording_deleted_at` beside audio still sitting in a carrier's bucket is
   * not a bug in a cron job. It is a false statement about somebody's voice — and worse, a
   * *self-healing* one: the call leaves the working set, so no later run ever looks at it,
   * and the recording we told them we deleted lives forever with a receipt saying otherwise.
   */
  it("does not tombstone a recording the vendor refused to delete", async () => {
    const store = new FakeRetentionStore([recording(1), recording(2)]);
    const archive = new FakeRecordingArchive({ failing: ["/rec/1"] });

    const report = await runRetention(deps(store, archive));

    expect(store.tombstoned).toEqual(["call-2"]);
    expect(report.recordingsFailed).toBe(1);
    expect(report.recordingsDeleted).toBe(1);
  });

  /** The poller's rule, for the poller's reason: the rest of the batch is independent. */
  it("does not abort the batch on one failure", async () => {
    const store = new FakeRetentionStore([recording(1), recording(2), recording(3)]);
    const archive = new FakeRecordingArchive({ failing: ["/rec/2"] });

    const report = await runRetention(deps(store, archive));

    expect(store.tombstoned).toEqual(["call-1", "call-3"]);
    expect(report.recordingsFailed).toBe(1);
  });

  /**
   * A run that deleted the media and crashed before the tombstone leaves the call in the
   * working set. The retry gets `already_absent` — the recording is gone, which is the fact
   * we needed — and the tombstone finally lands. Treating that as a failure would build a
   * queue of finished work that could never drain.
   */
  it("tombstones a recording the vendor had already lost", async () => {
    const store = new FakeRetentionStore([recording(1)]);
    const archive = new FakeRecordingArchive({ absent: ["/rec/1"] });

    const report = await runRetention(deps(store, archive));

    expect(store.tombstoned).toEqual(["call-1"]);
    expect(report.recordingsDeleted).toBe(1);
    expect(report.recordingsFailed).toBe(0);
  });

  /**
   * The transcript pass is deliberately not gated on the recording pass succeeding. The
   * transcript is *our* text in *our* database, and a carrier outage is not a reason to keep
   * a caller's words for another day.
   */
  it("redacts transcripts even when every recording deletion failed", async () => {
    const store = new FakeRetentionStore([recording(1)], ["call-9"]);
    const archive = new FakeRecordingArchive({ failing: ["/rec/1"] });

    const report = await runRetention(deps(store, archive));

    expect(report.recordingsFailed).toBe(1);
    expect(store.redacted).toEqual(["call-9"]);
    expect(report.transcriptsRedacted).toBe(1);
  });

  it("reads the retention windows from the compliance policy, not from itself", async () => {
    let asked: Date | null = null;
    const store = new FakeRetentionStore();
    store.expiredRecordings = async (before) => {
      asked = before;
      return [];
    };

    await runRetention(deps(store));

    const expected =
      new Date(NOW).getTime() - RECORDING_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    expect(asked!).not.toBeNull();
    expect((asked as unknown as Date).getTime()).toBe(expected);
  });

  it("caps a run, and says so in the report", async () => {
    const store = new FakeRetentionStore([recording(1), recording(2), recording(3)]);
    const report = await runRetention(deps(store), { limit: 2 });
    expect(report.recordingsExpired).toBe(2);
  });

  it("does nothing, loudly, when there is nothing to do", async () => {
    const report = await runRetention(deps(new FakeRetentionStore()));
    expect(report).toEqual({
      recordingsExpired: 0,
      recordingsDeleted: 0,
      recordingsFailed: 0,
      transcriptsRedacted: 0,
    });
  });
});
