import type {
  Clock,
  CohortReader,
  PublicationDecision,
  PublicationWindow,
  ReportStore,
} from "@ledgerline/contracts";
import { decidePublication } from "@ledgerline/telemetry";
import { POLL_OFFSETS_MS } from "./outcomes.js";

/**
 * The publication pass (plan, Step 9 — "publish the number").
 *
 * Four lines of orchestration around a decision that took the rest of the Step to get
 * right. It reads the cross-tenant cohort, asks `packages/telemetry` whether the sample
 * entitles us to say anything, and — only if it does — writes the figure into an
 * append-only table nobody can edit afterwards.
 *
 * ## What it deliberately does not do
 *
 * **It does not record a withheld decision.** The obvious instinct is to log the quarters
 * we declined to publish, for the auditor. It is the wrong instinct, and the reason is
 * worth stating: a withheld decision is not a fact about the world, it is a fact about our
 * sample *at one moment*, and the moment passes. What matters is that a reader can tell
 * whether the number in front of them is current — and that is answered by the report's own
 * `windowEnd` plus the *live* decision the public page computes for the window we are in
 * now. The failure this protects against is a real one and is not what it looks like: it is
 * not "we suppressed a bad quarter", because no gate in `decidePublication()` can read the
 * rate. It is **"we stopped running the cron and the page still showed the last good
 * number, looking current"** — and the fix for that is a page that computes its own status
 * live, not a table of excuses.
 *
 * ## `requiredPolls`
 *
 * `POLL_OFFSETS_MS.length` is passed *into* the SQL rather than baked into it. When a
 * booking's outcome is settled is `packages/workflows`' policy — the same reason
 * `BookingStore` does not know the poll schedule. A `3` living in migration `0004` would be
 * a product decision in a SQL file, and it would go stale the day the schedule changed.
 */

export interface PublicationDeps {
  readonly cohort: CohortReader;
  readonly reports: ReportStore;
  readonly clock: Clock;
  /** The report's id. Injected, because nothing in this package invents one either. */
  readonly newId: () => string;
}

export async function runPublication(
  deps: PublicationDeps,
  window: PublicationWindow,
): Promise<PublicationDecision> {
  const cohort = await deps.cohort.cohort(
    window.start,
    window.end,
    POLL_OFFSETS_MS.length,
  );

  const decision = decidePublication({
    cohort,
    id: deps.newId(),
    publishedAt: deps.clock.now().toISOString(),
  });

  if (decision.status === "published") {
    await deps.reports.publish(decision.report);
  }

  return decision;
}
