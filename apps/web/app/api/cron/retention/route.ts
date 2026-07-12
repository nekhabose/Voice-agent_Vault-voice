import { HttpRecordingArchive } from "@ledgerline/compliance";
import { FetchTransport, systemClock } from "@ledgerline/contracts";
import { PgRetentionStore, withTenant } from "@ledgerline/db";
import { runRetention } from "@ledgerline/workflows";
import { database, isCronRequest } from "@/lib/cron";
import { tenantResolver } from "@/lib/tenant";

/**
 * The deletion cron (plan, Step 8 — "recording retention and deletion policy").
 *
 * The third scheduled job, and the only one whose failure is invisible. A poller that
 * stops running produces a suspiciously perfect correction rate; a triage batch that
 * stops running drives our own published number *up*, which is uncomfortable and
 * therefore noticed. **A retention job that stops running produces nothing at all** —
 * the product works, the dashboard is green, the contractor is happy, and we are
 * holding forty thousand recordings of other people's homes that we told them we had
 * deleted. Nobody finds out until somebody asks, and by then the answer is the story.
 *
 * So `RetentionReport.recordingsFailed` is the number this route exists to surface, and
 * a run that could not delete is a run that says so rather than one that returns 200 and
 * a shrug.
 *
 * **Daily, at 03:00.** Retention windows are 90 and 365 days; a job that runs a few
 * hours late has broken no promise, and running it beside the nightly triage pass would
 * put two long jobs on one cold function.
 *
 * **`GET`, because Vercel Cron sends `GET`** — the same trap as the other two routes. A
 * `POST`-only export deploys, schedules, and never fires, and this is the one job whose
 * silence looks exactly like success.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isCronRequest(request)) {
    return Response.json({ error: "not a cron invocation" }, { status: 401 });
  }

  const tenantId = await tenantResolver.resolve();
  if (tenantId === null) {
    return Response.json({ error: "no tenant" }, { status: 401 });
  }

  const baseUrl = process.env.RECORDING_ARCHIVE_URL;
  if (!baseUrl) {
    // A 500, and deliberately not a partial run. Blanking the transcripts while the
    // recordings survive would report `recordingsFailed: 0` — a green run that deleted
    // none of the audio, which is the exact shape of failure this route exists to make
    // impossible. No archive, no retention pass.
    return Response.json(
      { error: "RECORDING_ARCHIVE_URL is not set; refusing to run a retention pass that cannot delete a recording" },
      { status: 500 },
    );
  }

  const { db, close } = database();
  try {
    const report = await withTenant(db, tenantId, (tx) =>
      runRetention({
        store: new PgRetentionStore(tx, tenantId),
        // Real code, and it has never spoken to a live carrier — there is no telephony
        // account to speak to (Step 4.2). Same honest status as `GoogleGeocoder` and
        // both CRM adapters: a real binding behind a real port, proven offline.
        archive: new HttpRecordingArchive(new FetchTransport(baseUrl)),
        clock: systemClock,
      }),
    );

    return Response.json(report);
  } finally {
    await close();
  }
}
