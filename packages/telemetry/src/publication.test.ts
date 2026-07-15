import { describe, expect, it } from "vitest";
import {
  METHODOLOGY_VERSION,
  ReliabilityReportSchema,
  type CohortStats,
} from "@ledgerline/contracts";
import {
  MIN_COHORT_BOOKINGS,
  MIN_COHORT_CALLS,
  MIN_COHORT_TENANTS,
  MIN_OBSERVED_COVERAGE,
  decidePublication,
  lastCompleteQuarter,
  wilsonInterval,
} from "./publication.js";

/**
 * Step 9. The tests that matter here are not the ones proving we can compute a rate —
 * `metrics.test.ts` did that in the initial build. They are the ones proving we **cannot
 * decline to publish a rate we do not like**, and that a cohort of nothing does not report
 * a flawless record.
 */

const ID = "11111111-1111-4111-8111-111111111111";
const AT = "2026-07-12T00:00:00.000Z";

/** A cohort that clears every gate. Individual tests spoil exactly one thing. */
const HEALTHY: CohortStats = {
  windowStart: "2026-04-01T00:00:00.000Z",
  windowEnd: "2026-07-01T00:00:00.000Z",
  tenants: 8,
  calls: 4_000,
  committedBookings: 1_000,
  immatureBookings: 20,
  correctedBookings: 40,
  agentErrorBookings: 25,
  auditedOutcomes: 30,
  agreedOutcomes: 29,
  worstTenantCorrectionRate: 0.12,
  worstTenantBookings: 80,
};

const publish = (cohort: CohortStats) =>
  decidePublication({ cohort, id: ID, publishedAt: AT });

describe("an empty cohort does not report a perfect record", () => {
  /**
   * The most dangerous number in this repo. `ratio()` returns 0 on a 0 denominator — which
   * is correct arithmetic and a catastrophic claim, because it means a company with no
   * customers, or a company whose poller has been broken for a month, publishes a **0.0%
   * correction rate** and is not technically lying. It is the missed-webhook failure mode
   * (principle #5) in its most persuasive costume: a perfect score.
   */
  it("withholds rather than publishing 0% over nothing", () => {
    const decision = publish({
      ...HEALTHY,
      tenants: 0,
      calls: 0,
      committedBookings: 0,
      immatureBookings: 0,
      correctedBookings: 0,
      agentErrorBookings: 0,
      auditedOutcomes: 0,
      agreedOutcomes: 0,
      worstTenantCorrectionRate: 0,
      worstTenantBookings: 0,
    });

    expect(decision.status).toBe("withheld");
  });

  it("hands back the cohort it had, so 'not yet' comes with a denominator", () => {
    const decision = publish({ ...HEALTHY, tenants: 0, calls: 0, committedBookings: 0 });
    if (decision.status !== "withheld") throw new Error("expected withheld");

    expect(decision.cohort.committedBookings).toBe(0);
    expect(decision.reasons.length).toBeGreaterThan(0);
  });
});

describe("the gates", () => {
  it("refuses a cohort below the tenant floor — an average of two is not an average", () => {
    const decision = publish({ ...HEALTHY, tenants: MIN_COHORT_TENANTS - 1 });
    if (decision.status !== "withheld") throw new Error("expected withheld");

    expect(decision.reasons.join(" ")).toContain("tenants");
  });

  it("refuses a cohort below the call floor", () => {
    const decision = publish({ ...HEALTHY, calls: MIN_COHORT_CALLS - 1 });
    expect(decision.status).toBe("withheld");
  });

  it("refuses a booking count whose confidence interval would be meaningless", () => {
    const decision = publish({ ...HEALTHY, committedBookings: MIN_COHORT_BOOKINGS - 1 });
    expect(decision.status).toBe("withheld");
  });

  /**
   * The gate that stops the exclusion of immature bookings from becoming a loophole. They
   * *must* be excluded — a booking nobody has re-read cannot show a correction, and leaving
   * it in the denominator dilutes the numerator. But that also means a CRM outage which
   * stopped every poll would shrink the cohort down to the bookings that happened to work,
   * and the survivors would publish a lovely number over a fraction of the real volume.
   */
  it("refuses when too much of the window was never actually observed", () => {
    const decision = publish({
      ...HEALTHY,
      committedBookings: 600,
      immatureBookings: 400, // 60% coverage
    });
    if (decision.status !== "withheld") throw new Error("expected withheld");

    expect(decision.reasons.join(" ")).toContain("poll schedule");
  });

  it("publishes at exactly the coverage floor, not one booking above it", () => {
    // 950 matured of 1000 == 95.0%. A `>` where the code says `>=` would fail here.
    const decision = publish({
      ...HEALTHY,
      committedBookings: 950,
      immatureBookings: 50,
    });

    expect(decision.status).toBe("published");
    if (decision.status !== "published") return;
    expect(decision.report.observedCoverage).toBeCloseTo(MIN_OBSERVED_COVERAGE, 10);
  });

  it("reports every failed gate at once, not just the first", () => {
    // All four: one tenant, three calls, two bookings — and, because those two sit beside
    // twenty immature ones, a coverage of 9%. Somebody reading a "not yet" is owed the
    // whole list, not the first thing that tripped.
    const decision = publish({ ...HEALTHY, tenants: 1, calls: 3, committedBookings: 2 });
    if (decision.status !== "withheld") throw new Error("expected withheld");

    expect(decision.reasons).toHaveLength(4);
  });
});

describe("no gate can read the rate", () => {
  /**
   * **The test this whole file exists for.**
   *
   * A vendor who retains the option to withhold a figure they dislike has published
   * nothing, whatever their website says — and the only way to be believed is to have
   * deleted the option, in code somebody else can read. So: a cohort where the contractor
   * corrected *every single booking we made* publishes 100%, on the front page, because
   * there is no branch in `decidePublication` that looks at the numerator.
   *
   * If someone ever adds one, this test is what stops them.
   */
  it("publishes a catastrophic correction rate when the sample is adequate", () => {
    const decision = publish({
      ...HEALTHY,
      correctedBookings: 1_000, // every booking. The product does not work.
      agentErrorBookings: 1_000,
    });

    expect(decision.status).toBe("published");
    if (decision.status !== "published") return;
    expect(decision.report.correctionRate).toBe(1);
    expect(decision.report.publishedRate).toBe(1);
  });

  it("every withholding reason is about the sample, never about the number", () => {
    // A cohort that is both terrible and inadequate. The reasons must all name the sample.
    const decision = publish({
      ...HEALTHY,
      tenants: 1,
      calls: 10,
      committedBookings: 10,
      correctedBookings: 10,
      agentErrorBookings: 10,
    });
    if (decision.status !== "withheld") throw new Error("expected withheld");

    for (const reason of decision.reasons) {
      expect(reason).not.toMatch(/correction rate is|too high|embarrass|unflattering/i);
    }
  });
});

describe("the published figure", () => {
  it("is the raw rate until the classifier has earned its licence", () => {
    // 30 audited labels clears MIN_AUDITED_OUTCOMES, but 29/30 is 96.7% agreement...
    const decision = publish(HEALTHY);
    if (decision.status !== "published") throw new Error("expected published");

    // ...so the triaged rate is licensed, and it is *lower* than the raw one.
    expect(decision.report.publishedBasis).toBe("agent_error");
    expect(decision.report.publishedRate).toBe(decision.report.agentErrorRate);
    expect(decision.report.agentErrorRate).toBeLessThan(decision.report.correctionRate);
  });

  it("falls back to the raw rate when the human audit has not vouched for the model", () => {
    const decision = publish({ ...HEALTHY, auditedOutcomes: 4, agreedOutcomes: 4 });
    if (decision.status !== "published") throw new Error("expected published");

    // Four audits that happened to agree is not evidence; it is a small number that
    // flatters us. The rule is `publishedCorrectionRate()`'s, reused rather than restated.
    expect(decision.report.publishedBasis).toBe("raw");
    expect(decision.report.publishedRate).toBe(decision.report.correctionRate);
  });

  it("keeps agentErrorRate <= correctionRate, which is the invariant Step 6 turns on", () => {
    const decision = publish(HEALTHY);
    if (decision.status !== "published") throw new Error("expected published");

    expect(decision.report.agentErrorRate).toBeLessThanOrEqual(
      decision.report.correctionRate,
    );
  });

  it("carries the worst tenant beside the pooled average", () => {
    // Nine tenants at 2% and one at 40% pool to something respectable, and the tenth
    // contractor — the only one for whom this product does not work — is arithmetically
    // invisible. Publishing the worst case is the cheapest defence against a number that
    // is true and misleading.
    const decision = publish(HEALTHY);
    if (decision.status !== "published") throw new Error("expected published");

    expect(decision.report.worstTenantCorrectionRate).toBe(0.12);
    expect(decision.report.worstTenantBookings).toBe(80);
    expect(decision.report.worstTenantCorrectionRate).toBeGreaterThan(
      decision.report.correctionRate,
    );
  });

  it("stamps the methodology version, so no trend line crosses a definition change", () => {
    const decision = publish(HEALTHY);
    if (decision.status !== "published") throw new Error("expected published");

    expect(decision.report.methodologyVersion).toBe(METHODOLOGY_VERSION);
  });

  it("parses as a ReliabilityReport — the schema is the publication contract", () => {
    const decision = publish(HEALTHY);
    if (decision.status !== "published") throw new Error("expected published");

    expect(() => ReliabilityReportSchema.parse(decision.report)).not.toThrow();
  });
});

describe("the confidence interval", () => {
  /**
   * Wilson, not the normal approximation, and the difference is not academic: at these
   * rates and sample sizes the textbook interval hands back a **negative lower bound** — a
   * correction rate better than perfect — and at `p = 0` it produces `[0, 0]`, asserting
   * with 95% confidence that we will never make another mistake. We publish the interval
   * because a bare point estimate invites a precision the sample cannot support, and *we*
   * are the party who profits from that belief.
   */
  it("brackets the point estimate", () => {
    const { low, high } = wilsonInterval(40, 1_000);
    expect(low).toBeLessThan(0.04);
    expect(high).toBeGreaterThan(0.04);
  });

  it("never leaves [0, 1], even at zero corrections", () => {
    // The normal approximation gives [0, 0] here: 95% confidence that we will never make
    // another mistake. Wilson gives a lower bound of zero and an *honest* upper one.
    const { low, high } = wilsonInterval(0, 500);
    expect(low).toBeCloseTo(0, 10);
    expect(high).toBeGreaterThan(0);
    expect(high).toBeLessThan(1);
  });

  it("never claims certainty at a perfect score", () => {
    const { low, high } = wilsonInterval(500, 500);
    expect(high).toBe(1);
    expect(low).toBeLessThan(1);
  });

  it("is wider on a small sample than a large one at the same rate", () => {
    const small = wilsonInterval(5, 100);
    const large = wilsonInterval(50, 1_000);
    expect(small.high - small.low).toBeGreaterThan(large.high - large.low);
  });

  /**
   * Checked against the *definition* rather than against a number somebody remembered from
   * a table — which is how the first draft of this test got it wrong, and how a subtly
   * broken interval would have shipped with a green suite.
   *
   * The Wilson bounds are exactly the two values of `p` that solve
   * `|p̂ − p| = z · √(p(1−p)/n)`: the rates at which the observed proportion sits precisely
   * `z` standard errors away. Substituting each bound back into that equation is an
   * independent check on the algebra, and it does not care what I think Wilson's table says.
   */
  it("satisfies the equation that defines it", () => {
    const z = 1.959963984540054;
    const n = 100;
    const observed = 5 / n;

    const { low, high } = wilsonInterval(5, n);

    for (const bound of [low, high]) {
      const standardErrors = Math.abs(observed - bound) / Math.sqrt((bound * (1 - bound)) / n);
      expect(standardErrors).toBeCloseTo(z, 9);
    }
  });

  it("is [0, 1] over no trials — total ignorance, not a perfect score", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe("the window is derived, not chosen", () => {
  /**
   * The free parameter worth more than any amount of spin. A vendor who picks the period
   * they report on can catch a good streak — "the trailing 37 days", "since the fix
   * shipped" — and nobody could ever prove it was a lie. So the window is a calendar
   * quarter, computed from the clock, settled before anyone knows what it will contain.
   */
  it("is the quarter before the one we are standing in", () => {
    const { start, end } = lastCompleteQuarter(new Date("2026-07-12T09:30:00.000Z"));

    expect(start.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("wraps to the previous year in Q1", () => {
    const { start, end } = lastCompleteQuarter(new Date("2026-02-14T00:00:00.000Z"));

    expect(start.toISOString()).toBe("2025-10-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("does not move when the clock does, within a quarter", () => {
    // The first second of Q3 and the last: the same window either way. A window that
    // crept forward daily would let a bad week age out of the report on its own.
    const early = lastCompleteQuarter(new Date("2026-07-01T00:00:00.000Z"));
    const late = lastCompleteQuarter(new Date("2026-09-30T23:59:59.999Z"));

    expect(early).toEqual(late);
  });

  it("never includes the quarter in progress", () => {
    // Which is mostly bookings too young to have been corrected yet, and they flatter us.
    const now = new Date("2026-08-20T00:00:00.000Z");
    const { end } = lastCompleteQuarter(now);

    expect(end.getTime()).toBeLessThanOrEqual(now.getTime());
  });

  it("is half-open: the end of one quarter is the start of the next", () => {
    // A window that included its own end would count the boundary booking twice.
    const q2 = lastCompleteQuarter(new Date("2026-07-12T00:00:00.000Z"));
    const q1 = lastCompleteQuarter(new Date("2026-04-12T00:00:00.000Z"));

    expect(q1.end).toEqual(q2.start);
  });
});

describe("the methodology version", () => {
  /**
   * The pin. A correction rate is meaningless without the definition of what counts as a
   * correction — so if `isCorrected()`, the poll schedule, or the gates below change, last
   * quarter's 3.1% and this quarter's 2.8% are measurements of different things, and
   * drawing a trend through them is a lie told with true numbers.
   *
   * This test fails when a definition moves and the version does not. It is deliberately
   * annoying, for the same reason bumping `DPA_VERSION` is deliberately expensive: a
   * version bump that cost nothing would be one nobody read.
   */
  it("pins the gates this version stands for", () => {
    expect({
      MIN_COHORT_TENANTS,
      MIN_COHORT_CALLS,
      MIN_COHORT_BOOKINGS,
      MIN_OBSERVED_COVERAGE,
      METHODOLOGY_VERSION,
    }).toEqual({
      MIN_COHORT_TENANTS: 3,
      MIN_COHORT_CALLS: 1_000,
      MIN_COHORT_BOOKINGS: 500,
      MIN_OBSERVED_COVERAGE: 0.95,
      METHODOLOGY_VERSION: "2026-07-12",
    });
  });
});
