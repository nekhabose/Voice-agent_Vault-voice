import { systemClock } from "@ledgerline/contracts";
import { PgTriageStore, withTenant } from "@ledgerline/db";
import { runTriage } from "@ledgerline/workflows";
import { database, isCronRequest } from "@/lib/cron";
import { triagerFor } from "@/lib/model-provider";
import { tenantResolver } from "@/lib/tenant";

/**
 * The nightly correction triage (plan, Step 7.3 — scheduling what Step 6 built).
 *
 * `runTriage()` has existed since Step 6 and nothing called it. This is the caller, and it
 * binds the *port*: `workflows` knows a `CorrectionTriager` exists and cannot tell which
 * vendor is behind it. `lib/model-provider.ts` makes that choice, once, from the
 * environment. Ports down, implementations at the edge — and the edge is one file.
 *
 * Nightly, because a corrected booking is not urgent and a triage model is not cheap.
 *
 * **Every way this route can fail makes our published number worse, not better.** If it
 * never runs, corrections stay unclassified; an unclassified correction counts as an
 * agent error (`isAgentError`, in `contracts`), so `agentErrorRate` climbs toward the raw
 * `correctionRate`. And as of Step 7 it also costs us money — `packages/billing` waives an
 * untriaged correction. A cron nobody wired up is the failure this pipeline is arranged to
 * make expensive for *us*, which is the only direction it is safe for a failure to point.
 *
 * **`GET`, because that is what Vercel Cron sends.** A route exporting only `POST` would
 * deploy, schedule, and never fire — and a triage pass that never runs looks exactly like
 * a night with no corrections. `isCronRequest` is what makes a mutating GET safe.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isCronRequest(request)) {
    return Response.json({ error: "not a cron invocation" }, { status: 401 });
  }

  const tenantId = await tenantResolver.resolve();
  if (tenantId === null) {
    return Response.json({ error: "no tenant" }, { status: 401 });
  }

  const binding = triagerFor();
  if (typeof binding === "string") {
    // A 500, not a silent no-op and not a fallback to the other vendor. A triage pass that
    // "succeeded" having classified nothing is indistinguishable, on a dashboard, from a
    // night with no corrections — and it costs us money, because an unclassified correction
    // is an agent error (principle #5) and an agent error is a booking we waive (#7).
    return Response.json({ error: binding }, { status: 500 });
  }

  const { db, close } = database();
  try {
    const report = await withTenant(db, tenantId, (tx) =>
      runTriage({
        triager: binding.triager,
        store: new PgTriageStore(tx, tenantId),
        clock: systemClock,
        model: binding.model,
      }),
    );

    return Response.json(report);
  } finally {
    await close();
  }
}
