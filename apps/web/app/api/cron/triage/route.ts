import Anthropic from "@anthropic-ai/sdk";
import { systemClock } from "@ledgerline/contracts";
import { PgTriageStore, withTenant } from "@ledgerline/db";
import { AnthropicTriager, TRIAGE_MODEL } from "@ledgerline/triage";
import { runTriage } from "@ledgerline/workflows";
import { database, isCronRequest } from "@/lib/cron";
import { tenantResolver } from "@/lib/tenant";

/**
 * The nightly correction triage (plan, Step 7.3 — scheduling what Step 6 built).
 *
 * `runTriage()` has existed since Step 6 and nothing called it. This is the caller, and
 * it is **the only place in the tree that constructs an `AnthropicTriager`**: `workflows`
 * binds the port, `triage` owns the model, and the edge binds the implementation. Ports
 * down, implementations at the edge.
 *
 * Nightly, because a corrected booking is not urgent and `claude-opus-4-8` is not cheap.
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // A 500, not a silent no-op. A triage pass that "succeeded" having classified nothing
    // is indistinguishable, on a dashboard, from a night with no corrections.
    return Response.json({ error: "ANTHROPIC_API_KEY is not set" }, { status: 500 });
  }

  const { db, close } = database();
  try {
    const report = await withTenant(db, tenantId, (tx) =>
      runTriage({
        triager: new AnthropicTriager({ client: new Anthropic({ apiKey }) }),
        store: new PgTriageStore(tx, tenantId),
        clock: systemClock,
        model: TRIAGE_MODEL,
      }),
    );

    return Response.json(report);
  } finally {
    await close();
  }
}
