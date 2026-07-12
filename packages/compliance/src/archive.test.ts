import { FakeTransport } from "@ledgerline/contracts";
import { describe, expect, it } from "vitest";
import { FakeRecordingArchive, HttpRecordingArchive } from "./archive.js";

const URL = "/2010-04-01/Accounts/AC123/Recordings/RE456.json";

describe("HttpRecordingArchive", () => {
  it("sends a DELETE to the recording's own resource", async () => {
    const transport = new FakeTransport(() => ({ status: 204, body: null }));
    const archive = new HttpRecordingArchive(transport);

    expect(await archive.delete(URL)).toBe("deleted");
    expect(transport.requests).toEqual([{ method: "DELETE", path: URL }]);
  });

  /**
   * The `404` is the one that decides whether this job ever finishes.
   *
   * Deletion is not idempotent from our side: a run that deleted the media and crashed
   * before writing the tombstone leaves a row pointing at audio that is already gone.
   * Treat that `404` as a failure and the retention backlog grows with exactly the
   * recordings we successfully deleted — a queue of work that can never drain, made
   * entirely of finished work.
   */
  it("treats a 404 as gone, not as a failure", async () => {
    const transport = new FakeTransport(() => ({ status: 404, body: { message: "not found" } }));
    expect(await new HttpRecordingArchive(transport).delete(URL)).toBe("already_absent");
  });

  /**
   * And the mirror. A `500` means the recording *may still exist*, and a job that shrugged
   * at it would write `recording_deleted_at` over audio it had not deleted — a false
   * statement about somebody's voice, in the one system whose pitch is that it tells the
   * truth about its own failures. So it throws, `runRetention()` counts it as failed, and
   * the deletion is still owed.
   */
  it.each([500, 502, 429, 403])("throws on a %d, because the media may still be there", async (status) => {
    const transport = new FakeTransport(() => ({ status, body: null }));
    await expect(new HttpRecordingArchive(transport).delete(URL)).rejects.toThrow(
      `HTTP ${status}`,
    );
  });

  it("accepts any 2xx", async () => {
    const transport = new FakeTransport(() => ({ status: 200, body: { deleted: true } }));
    expect(await new HttpRecordingArchive(transport).delete(URL)).toBe("deleted");
  });
});

describe("FakeRecordingArchive", () => {
  it("records what it was asked to delete", async () => {
    const archive = new FakeRecordingArchive();
    await archive.delete("/rec/1");
    expect(archive.deleted).toEqual(["/rec/1"]);
  });

  it("can refuse, so a test can prove the deletion stays owed", async () => {
    const archive = new FakeRecordingArchive({ failing: ["/rec/2"] });
    await expect(archive.delete("/rec/2")).rejects.toThrow("archive unavailable");
  });
});
