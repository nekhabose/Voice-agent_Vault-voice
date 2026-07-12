import { systemClock } from "@ledgerline/contracts";
import { PgBookingStore, PgOutcomeStore, PgSnapshotStore, withTenant } from "@ledgerline/db";
import { runOutcomePolls } from "@ledgerline/workflows";
import { database, isCronRequest } from "@/lib/cron";
import { crmForTenant } from "@/lib/crm-for-tenant";
import { tenantResolver } from "@/lib/tenant";

/**
 * The outcome poller — the thing Step 2 built and nobody scheduled (plan, Step 7.3).
 *
 * `pollSchedule()` has been able to say when a booking is due since Step 2, and
 * `bookings.completed_polls` has been a column nobody incremented. This route calls
 * `runOutcomePolls()`, and `vercel.json` calls this route.
 *
 * **Hourly, not daily.** The offsets are 24h / 72h / 7d, and a daily cron can miss its
 * window by up to a day. Hourly means a poll lands close to when it was due — and
 * `completedPolls` guarantees that a run we *missed* is still owed rather than skipped. A
 * booking never polled is a correction never counted, and an uncounted correction reads as
 * a better number than the truth.
 *
 * Nothing here catches an error and reports success. `runOutcomePolls()` counts what it
 * could not do and returns it; a CRM outage leaves the poll owed rather than consumed.
 *
 * **`GET`, and it is not a mistake.** Vercel Cron invokes the path with a GET; a route
 * that exported only `POST` would deploy, schedule, and never fire — and the symptom
 * would be a correction rate of zero, which is precisely the number a dishonest vendor
 * would report. The safety of a mutating GET rests entirely on `isCronRequest`.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isCronRequest(request)) {
    return Response.json({ error: "not a cron invocation" }, { status: 401 });
  }

  const tenantId = await tenantResolver.resolve();
  if (tenantId === null) {
    return Response.json({ error: "no tenant" }, { status: 401 });
  }

  const { db, close } = database();
  try {
    const report = await withTenant(db, tenantId, async (tx) => {
      const crm = await crmForTenant(tx, tenantId);

      return runOutcomePolls({
        // Read-only *by type*: `PollDeps.crm` is `Pick<CrmAdapter, "readJob">`, so this
        // route cannot write to the contractor's CRM even by accident. A metric that
        // repairs the thing it measures measures nothing (Step 2, surprise #4).
        crm,
        bookings: new PgBookingStore(tx, tenantId),
        outcomes: new PgOutcomeStore(tx, tenantId),
        snapshots: new PgSnapshotStore(tx, tenantId),
        clock: systemClock,
      });
    });

    return Response.json(report);
  } finally {
    await close();
  }
}
