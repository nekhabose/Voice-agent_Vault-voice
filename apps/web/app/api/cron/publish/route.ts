import { randomUUID } from "node:crypto";
import { systemClock } from "@ledgerline/contracts";
import { PgCohortReader, PgReportStore } from "@ledgerline/db";
import { lastCompleteQuarter } from "@ledgerline/telemetry";
import { runPublication } from "@ledgerline/workflows";
import { database, isCronRequest } from "@/lib/cron";

/**
 * The publication cron (plan, Step 9 — "publish the number").
 *
 * The fourth scheduled job, and the only one that **takes no tenant**. Every other route in
 * this app funnels through `tenantResolver` into `withTenant()`, because everything else it
 * does belongs to one contractor. The published figure belongs to all of them, so there is
 * no tenant to resolve — and the cross-tenant read is safe anyway, because the aggregate
 * lives in a `SECURITY DEFINER` function that can only return counts (migration `0004`).
 * The app role calls it unscoped and still cannot read a single row of anyone's data.
 *
 * **Quarterly, on the 15th — not the 1st.** This is the subtle one. A quarter's last
 * bookings are polled at 24h, 72h, and 7d, so on the 1st of the following month they are
 * still *immature*: their outcomes have not finished being observed, they are excluded from
 * the rate, and `MIN_OBSERVED_COVERAGE` would refuse to publish a quarter whose final
 * fortnight is missing. Firing on the 15th gives the poll schedule the week it needs. A cron
 * on the 1st would have withheld every quarter forever, and the reason would have looked
 * like a bug in the gates rather than a bug in the schedule.
 *
 * **`GET`, because that is what Vercel Cron sends** — the same trap as the other three.
 *
 * Running it twice is harmless: `PgReportStore.publish` is idempotent on the window, which
 * an append-only table with no `UPDATE` and no `DELETE` grant absolutely requires.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isCronRequest(request)) {
    return Response.json({ error: "not a cron invocation" }, { status: 401 });
  }

  const { db, close } = database();
  try {
    const decision = await runPublication(
      {
        // No `withTenant`. There is no tenant — see above.
        cohort: new PgCohortReader(db),
        reports: new PgReportStore(db),
        clock: systemClock,
        newId: () => randomUUID(),
      },
      lastCompleteQuarter(systemClock.now()),
    );

    // A withheld quarter is a 200 and a body that says why. It is not an error: for as long
    // as this company has fewer than three contractors it is the *correct* outcome, and a
    // route that 500'd on it would train whoever watches these logs to ignore them.
    return Response.json(decision);
  } finally {
    await close();
  }
}
