import { z } from "zod";
import { IsoTimestampSchema } from "./primitives.js";

/**
 * Step 9 — the number, published.
 *
 * `idea.md` §7's first open question is that **no field reliability numbers exist** for
 * deployed voice agents. Being the first to publish ours is the whole marketing case, and
 * it is worth exactly nothing unless the mechanism that produces it is one we could not
 * have bent even if we wanted to. Everything in this file is shaped by one question asked
 * over and over: *if we wanted to cheat here, how would we?*
 *
 * ## What a published figure is, and is not
 *
 * It is an **aggregate across every tenant**, and that single word is the reason this file
 * exists rather than a `SELECT` on the reliability page. Every other number in this system
 * is one contractor's, computed inside `withTenant()` with row-level security underneath
 * (principle #6). A cross-tenant figure has no tenant, so it cannot be computed that way —
 * and the obvious alternative, *connect as the owner and count*, would mean the one number
 * we publish to the world is the one produced by the only connection in the system with no
 * isolation at all. That is the deployment mistake `rls.test.ts` exists to pin.
 *
 * So the cohort is read through {@link CohortReader}, whose Postgres implementation calls a
 * `SECURITY DEFINER` function that can see every tenant's rows and **can only return
 * counts** (migration `0004`). The app role gains the ability to compute the statistic and
 * gains no ability to read a row it could not read before. Same move as
 * `Pick<CrmAdapter, "readJob">` and `TriageStore.classify`: the *type* is the guarantee.
 */

/**
 * The definitions behind a published figure, versioned so two numbers can be compared.
 *
 * A correction rate is only meaningful next to what counts as a correction. If
 * `isCorrected()` or `diffBooking()`'s false-positive rules change, last quarter's 3.1%
 * and this quarter's 2.8% are measurements of different things, and putting them on one
 * chart is a lie told with true numbers.
 *
 * Bumping this is therefore **deliberately expensive**, exactly as `DPA_VERSION` is: every
 * report already published keeps the version it was computed under, and the public page
 * refuses to draw a trend across a version boundary. `publication.test.ts` pins the
 * definitions this version stands for, so changing one without bumping the version fails
 * the suite rather than silently rewriting history.
 */
export const METHODOLOGY_VERSION = "2026-07-12";

/* -------------------------------------------------------------------------- */
/* The cohort — counts, and nothing that could name a contractor               */
/* -------------------------------------------------------------------------- */

/**
 * What the cross-tenant aggregate returns.
 *
 * **There is no tenant id in this schema, and there is no field that could hold one.**
 * That is not tidiness. A published aggregate that carried tenant identity would be a
 * public statement about one named contractor's business, which is not a thing they
 * agreed to when they signed up to have their calls answered.
 */
export const CohortStatsSchema = z.object({
  windowStart: IsoTimestampSchema,
  windowEnd: IsoTimestampSchema,
  /** Distinct tenants with at least one *matured* booking in the window. */
  tenants: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
  /**
   * The denominator. **Matured bookings only** — see {@link CohortStats.immatureBookings}.
   */
  committedBookings: z.number().int().nonnegative(),
  /**
   * Bookings committed inside the window whose poll schedule has **not finished**, and
   * which are therefore excluded from every rate above.
   *
   * This is the correction rate's most flattering bug, and it is invisible unless you
   * count it. A booking committed yesterday has not been re-read at 72h or 7d yet, so no
   * correction *can* have been observed on it — and putting it in the denominator anyway
   * dilutes the numerator with bookings that never had a chance to fail. **The newest
   * bookings always make us look best.** A vendor who published monthly, from the first of
   * the month, would report a number bent in their favour by the calendar alone, and would
   * never have to know they were doing it.
   *
   * So immature bookings leave *both* sides of the ratio and are counted here instead —
   * and because that exclusion could itself be abused (a CRM outage that stops every poll
   * would quietly shrink the cohort to the bookings that happened to work),
   * {@link observedCoverage} is a publication gate rather than a footnote.
   */
  immatureBookings: z.number().int().nonnegative(),
  /** Matured bookings the contractor cancelled or edited. `isCorrected()`, in SQL. */
  correctedBookings: z.number().int().nonnegative(),
  /** The subset triage attributes to us. An *unlabeled* correction is one of these. */
  agentErrorBookings: z.number().int().nonnegative(),
  auditedOutcomes: z.number().int().nonnegative(),
  agreedOutcomes: z.number().int().nonnegative(),
  /**
   * The single worst tenant's correction rate, and how many bookings it is over.
   *
   * **A pooled average is how you hide one contractor's disaster behind nine good ones,
   * while remaining scrupulously honest.** Nine tenants at 2% and one at 40% pool to 5.8%,
   * and the tenth contractor — the only one whose experience of this product is that it
   * does not work — is arithmetically invisible. Publishing the worst case beside the
   * average is the cheapest possible defence against a number that is true and misleading.
   *
   * The booking count rides along because "100% correction rate" over three bookings is
   * noise and over three hundred is an emergency, and a reader cannot tell which without
   * the denominator.
   */
  worstTenantCorrectionRate: z.number().min(0).max(1),
  worstTenantBookings: z.number().int().nonnegative(),
});
export type CohortStats = z.infer<typeof CohortStatsSchema>;

/* -------------------------------------------------------------------------- */
/* The report                                                                  */
/* -------------------------------------------------------------------------- */

/** Which of the two rates the headline figure is. See `publishedCorrectionRate()`. */
export const PublicationBasisSchema = z.enum(["agent_error", "raw"]);
export type PublicationBasis = z.infer<typeof PublicationBasisSchema>;

/**
 * One published figure, forever.
 *
 * **Append-only, and not by convention**: `ReportStore` has no `update` and no `delete`,
 * and migration `0004` grants the app role `SELECT` and `INSERT` on the table and nothing
 * else — the same two mechanisms that make `outcomes.corrected_fields` unrewritable
 * (principle #6). A quarter we did not like cannot be withdrawn. It can only be followed
 * by another quarter, published beside it.
 *
 * That is the entire value of the artifact. A reliability number a vendor can retract is a
 * marketing claim with a database behind it.
 */
export const ReliabilityReportSchema = z.object({
  id: z.string().uuid(),
  /** What the numbers below mean. A trend line may not cross a version boundary. */
  methodologyVersion: z.string().min(1),
  windowStart: IsoTimestampSchema,
  windowEnd: IsoTimestampSchema,
  publishedAt: IsoTimestampSchema,

  tenants: z.number().int().positive(),
  calls: z.number().int().nonnegative(),
  committedBookings: z.number().int().positive(),

  /**
   * The raw rate. Every booking a contractor cancelled or edited, over every matured
   * booking. **Nothing subtracted, ever** (principle #5).
   */
  correctionRate: z.number().min(0).max(1),
  /**
   * The 95% Wilson score interval on {@link correctionRate}.
   *
   * A point estimate invites a reader to believe a precision the sample does not support,
   * and *we* are the party who benefits from that belief. Wilson rather than the normal
   * approximation because the normal one misbehaves exactly where our numbers will live —
   * small samples and rates near zero — and it can hand back a negative lower bound, which
   * is a correction rate below "perfect" and is the kind of thing a competitor screenshots.
   */
  correctionRateLow: z.number().min(0).max(1),
  correctionRateHigh: z.number().min(0).max(1),

  /** The subset triage blames on us. `agentErrorRate <= correctionRate`, always. */
  agentErrorRate: z.number().min(0).max(1),

  /** The headline. `publishedCorrectionRate()` chose it, and `publishedReason` says why. */
  publishedRate: z.number().min(0).max(1),
  publishedBasis: PublicationBasisSchema,
  publishedReason: z.string().min(1),

  auditedOutcomes: z.number().int().nonnegative(),
  triageAgreementRate: z.number().min(0).max(1),

  worstTenantCorrectionRate: z.number().min(0).max(1),
  worstTenantBookings: z.number().int().nonnegative(),

  /**
   * Matured bookings as a fraction of all bookings committed in the window.
   *
   * Published *with* the rate, because a rate computed over 60% of the cohort is a rate
   * with a hole in it, and the reader is entitled to know how big the hole is.
   */
  observedCoverage: z.number().min(0).max(1),
});
export type ReliabilityReport = z.infer<typeof ReliabilityReportSchema>;

/* -------------------------------------------------------------------------- */
/* The decision                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Publish, or withhold and say why.
 *
 * **Every reason a figure can be withheld is a statement about the sample, never about the
 * number.** There is no code path from "the correction rate is embarrassing" to
 * `withheld`, and `publication.test.ts` asserts a cohort with a *100%* correction rate and
 * an adequate sample publishes anyway. That property is the one this whole file is for: a
 * vendor who may withhold a figure they dislike is a vendor whose published figures mean
 * nothing, and the way to be believed is to have removed the option.
 *
 * The other half of the same guarantee lives on the public page, which renders the
 * *live* decision for the current window beside the last published report. Simply not
 * running the cron in a bad quarter therefore does not produce a stale-but-current-looking
 * number; it produces a page that says, in the present tense, what we are waiting for.
 */
export type PublicationDecision =
  | { readonly status: "published"; readonly report: ReliabilityReport }
  | {
      readonly status: "withheld";
      /** Sample-adequacy failures, in the order the gates are checked. Never empty. */
      readonly reasons: readonly string[];
      /** What we had. Shown on the page — "not yet" is more credible with a denominator. */
      readonly cohort: CohortStats;
    };

/**
 * The period a figure covers.
 *
 * **Derived from the clock, never chosen** (`lastCompleteQuarter()` in `packages/telemetry`).
 * A window somebody picks is a window somebody can gerrymander: "the trailing 37 days"
 * catches a good streak, and "since the fix shipped" is the same trick with an engineering
 * excuse attached. A fixed calendar quarter is the same window every time, decided before
 * anyone knows what it will contain — which is `hashedAuditSample`'s discipline (Step 6.3)
 * applied to time rather than to bookings.
 */
export interface PublicationWindow {
  readonly start: Date;
  /** Exclusive. A window that includes its own end double-counts the boundary booking. */
  readonly end: Date;
}

/* -------------------------------------------------------------------------- */
/* The ports                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The cross-tenant read.
 *
 * **`cohort()` takes a window and nothing else — in particular it cannot be handed a list
 * of tenants.** Cherry-picking the customers who make us look good is the most obvious way
 * to cheat at this, and it is the easiest to hide: a `tenantIds?: string[]` parameter with
 * a comment saying "for testing" would do it, and would read as reasonable in review
 * forever. There is no such parameter, so the cohort is every tenant with a matured
 * booking in the window, and picking a subset would require a schema change, a migration,
 * and a conversation.
 */
export interface CohortReader {
  cohort(windowStart: Date, windowEnd: Date, requiredPolls: number): Promise<CohortStats>;
}

/**
 * Where published figures go, and stay.
 *
 * No `update`. No `delete`. No `deleteBefore`. The absent methods are the point — this is
 * `RetentionStore`'s trick (which has no `delete(callId)` because a call is evidence), and
 * a reliability figure is evidence about *us*, which is the kind nobody keeps voluntarily.
 */
export interface ReportStore {
  publish(report: ReliabilityReport): Promise<void>;
  /** Every figure we have ever published, newest first. The gaps are visible on purpose. */
  history(limit: number): Promise<readonly ReliabilityReport[]>;
}
