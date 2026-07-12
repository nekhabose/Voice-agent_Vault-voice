import type { PublicationDecision, ReliabilityReport } from "@ledgerline/contracts";
import { systemClock } from "@ledgerline/contracts";
import { PgCohortReader, PgReportStore, neonDatabase } from "@ledgerline/db";
import { POLL_OFFSETS_MS } from "@ledgerline/workflows";
import { decidePublication, lastCompleteQuarter } from "@ledgerline/telemetry";

/**
 * What the public page is allowed to say, and where it gets it.
 *
 * ## The one page in this app that may not use demo data
 *
 * `apps/web/lib/demo-data.ts` seeds the contractor dashboard, and that is fine: it is
 * obviously one shop's day, it is typed against the real contracts, and nobody mistakes it
 * for a claim. **This page is different.** It says "here is how often our agent gets it
 * wrong, measured across every customer we have" — and a page that says that over invented
 * numbers is not a mock, it is a lie, and it is precisely the lie this entire product
 * exists to be the opposite of.
 *
 * So there is no fallback here. No database means no cohort means **no number**, and the
 * page says so in those words. The state below is a discriminated union rather than a
 * report-with-optional-fields for exactly that reason: "we have not measured this" has to
 * be a state the renderer cannot forget to handle.
 *
 * ## Why the live decision is computed on every request
 *
 * The last published report is not enough on its own. A cron nobody ran leaves the previous
 * quarter's figure sitting there, looking current — which is how a vendor stops publishing
 * without ever deciding to. So the page always computes the *current* window's decision
 * live, beside whatever was last published, and a withheld quarter says out loud what it is
 * waiting for.
 *
 * Note what that does **not** allow: `decidePublication()` cannot read the rate, so there
 * is no path from "this quarter looks bad" to "withheld". The only reasons are about the
 * sample, and they are all printed.
 */

export type PublicationState =
  /** No Neon (task 7.7). We have measured nothing, and we say nothing. */
  | { readonly kind: "no_database" }
  | {
      readonly kind: "measured";
      /** The live decision for the last complete quarter. */
      readonly decision: PublicationDecision;
      /** Every figure ever published, newest first. The gaps are visible on purpose. */
      readonly history: readonly ReliabilityReport[];
      readonly window: { readonly start: string; readonly end: string };
    };

export async function publicationState(
  env = process.env,
): Promise<PublicationState> {
  const url = env.DATABASE_URL;
  if (!url) return { kind: "no_database" };

  const window = lastCompleteQuarter(systemClock.now());
  const { db, close } = neonDatabase(url);

  try {
    // **No `withTenant()`, and that is the point.** This is the one read in the system with
    // no tenant: the cohort is an aggregate over all of them. It runs as `ledgerline_app`
    // with no `app.tenant_id` set, so row-level security shows this connection *nothing* —
    // and it still computes the figure, because the counting happens inside a SECURITY
    // DEFINER function that can only hand back counts (migration `0004`).
    const cohort = await new PgCohortReader(db).cohort(
      window.start,
      window.end,
      POLL_OFFSETS_MS.length,
    );

    const decision = decidePublication({
      cohort,
      // A preview, not a publication. Nothing is written on a page render — `runPublication`
      // in the cron is the only thing that inserts, and the id it mints is the one that lasts.
      id: "00000000-0000-4000-8000-000000000000",
      publishedAt: systemClock.now().toISOString(),
    });

    const history = await new PgReportStore(db).history(20);

    return {
      kind: "measured",
      decision,
      history,
      window: { start: window.start.toISOString(), end: window.end.toISOString() },
    };
  } finally {
    await close();
  }
}

/** `2026-04-01T00:00:00Z` → `Q2 2026`. The window a figure covers, said the way a person says it. */
export function quarterLabel(startIso: string): string {
  const start = new Date(startIso);
  return `Q${Math.floor(start.getUTCMonth() / 3) + 1} ${start.getUTCFullYear()}`;
}

/** Two decimal places, because a correction rate of "3%" and "3.42%" are different claims. */
export const rate = (value: number): string => `${(value * 100).toFixed(2)}%`;
