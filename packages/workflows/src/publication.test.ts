import type {
  CohortReader,
  CohortStats,
  ReliabilityReport,
  ReportStore,
} from "@ledgerline/contracts";
import { fixedClock } from "@ledgerline/contracts";
import { describe, expect, it } from "vitest";
import { POLL_OFFSETS_MS } from "./outcomes.js";
import { runPublication } from "./publication.js";

/**
 * The publication pass. Four lines of orchestration, and every test here is about what it
 * refuses to do.
 */

const WINDOW = {
  start: new Date("2026-04-01T00:00:00.000Z"),
  end: new Date("2026-07-01T00:00:00.000Z"),
};

const CLOCK = fixedClock("2026-07-12T00:00:00.000Z");
const ID = "11111111-1111-4111-8111-111111111111";

const ADEQUATE: CohortStats = {
  windowStart: WINDOW.start.toISOString(),
  windowEnd: WINDOW.end.toISOString(),
  tenants: 8,
  calls: 4_000,
  committedBookings: 1_000,
  immatureBookings: 10,
  correctedBookings: 40,
  agentErrorBookings: 25,
  auditedOutcomes: 30,
  agreedOutcomes: 29,
  worstTenantCorrectionRate: 0.12,
  worstTenantBookings: 80,
};

const THIN: CohortStats = {
  ...ADEQUATE,
  tenants: 1,
  calls: 12,
  committedBookings: 6,
  correctedBookings: 3,
  agentErrorBookings: 2,
  auditedOutcomes: 0,
  agreedOutcomes: 0,
};

class FakeCohortReader implements CohortReader {
  readonly asked: { start: Date; end: Date; requiredPolls: number }[] = [];

  constructor(private readonly stats: CohortStats) {}

  async cohort(start: Date, end: Date, requiredPolls: number): Promise<CohortStats> {
    this.asked.push({ start, end, requiredPolls });
    return this.stats;
  }
}

class FakeReportStore implements ReportStore {
  readonly published: ReliabilityReport[] = [];

  async publish(report: ReliabilityReport): Promise<void> {
    this.published.push(report);
  }

  async history(limit: number): Promise<readonly ReliabilityReport[]> {
    return this.published.slice(0, limit);
  }
}

const deps = (stats: CohortStats) => {
  const cohort = new FakeCohortReader(stats);
  const reports = new FakeReportStore();
  return {
    cohort,
    reports,
    all: { cohort, reports, clock: CLOCK, newId: () => ID },
  };
};

describe("runPublication", () => {
  it("writes the figure when the sample earns it", async () => {
    const { reports, all } = deps(ADEQUATE);

    const decision = await runPublication(all, WINDOW);

    expect(decision.status).toBe("published");
    expect(reports.published).toHaveLength(1);
    expect(reports.published[0]!.correctionRate).toBeCloseTo(0.04, 10);
  });

  /**
   * The state this repo is actually in, and will be until a contractor exists.
   *
   * **Nothing is written.** A withheld quarter leaves no row, and the public page computes
   * its own status live rather than reading one — so a cron nobody ran cannot leave a stale
   * figure looking current.
   */
  it("writes nothing at all when the cohort is too thin", async () => {
    const { reports, all } = deps(THIN);

    const decision = await runPublication(all, WINDOW);

    expect(decision.status).toBe("withheld");
    expect(reports.published).toEqual([]);
  });

  /**
   * How many polls settle a booking is `packages/workflows`' policy — `POLL_OFFSETS_MS`,
   * beside `pollSchedule()` and `nextDuePoll()`. Migration `0004` takes it as a *parameter*
   * rather than hardcoding a `3`, so that changing the poll schedule cannot silently leave
   * a stale number in a SQL file deciding which bookings count.
   */
  it("hands the SQL the poll schedule's length rather than letting it guess", async () => {
    const { cohort, all } = deps(ADEQUATE);

    await runPublication(all, WINDOW);

    expect(cohort.asked).toHaveLength(1);
    expect(cohort.asked[0]!.requiredPolls).toBe(POLL_OFFSETS_MS.length);
    expect(cohort.asked[0]!.start).toEqual(WINDOW.start);
    expect(cohort.asked[0]!.end).toEqual(WINDOW.end);
  });

  it("stamps the report with the injected clock and id, reading neither from the world", async () => {
    const { reports, all } = deps(ADEQUATE);

    await runPublication(all, WINDOW);

    expect(reports.published[0]!.publishedAt).toBe("2026-07-12T00:00:00.000Z");
    expect(reports.published[0]!.id).toBe(ID);
  });

  /**
   * The gates are about the sample, never the number — and this is that property observed
   * from the outside, through the batch a cron actually calls. A cohort in which the
   * contractor corrected **every booking we made** is published, on the front page, at 100%.
   */
  it("publishes a catastrophic number when the sample is adequate", async () => {
    const { reports, all } = deps({
      ...ADEQUATE,
      correctedBookings: 1_000,
      agentErrorBookings: 1_000,
    });

    const decision = await runPublication(all, WINDOW);

    expect(decision.status).toBe("published");
    expect(reports.published[0]!.correctionRate).toBe(1);
  });
});
