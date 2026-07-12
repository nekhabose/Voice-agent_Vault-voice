import {
  isAgentError,
  isCorrected,
  latestPerBooking,
  type BookingOutcome,
  type OutcomeClassification,
  type PendingBookingPayload,
} from "@ledgerline/contracts";
import { decidePublication } from "@ledgerline/telemetry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Queryable } from "./client.js";
import * as schema from "./schema.js";
import { PgCohortReader, PgReportStore } from "./stores.js";
import { refusal, testDatabase, type TestDatabase } from "./testing.js";

/**
 * Step 9, against a real Postgres.
 *
 * The cross-tenant aggregate is the one read in this system that is nobody's and
 * everybody's, and it is therefore the one place the tenancy guarantee could be quietly
 * undone. Two things have to be true at once, and they pull in opposite directions:
 *
 *  1. It must see **every tenant's rows**, or it cannot compute a cohort.
 *  2. The role that calls it must still be unable to **read a single one of them**.
 *
 * A `SECURITY DEFINER` function whose return type is a row of counts is how both hold, and
 * the tests below are the evidence for each half. The third group is the one that would
 * cost real money if it were wrong: the SQL predicates for "corrected" and "our fault" must
 * agree, row for row, with the TypeScript in `contracts` — because `telemetry` publishes
 * from one and `billing` invoices from the other.
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const RIVAL = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";

/** The poll schedule's length — what `runPublication` passes as `requiredPolls`. */
const REQUIRED_POLLS = 3;

const WINDOW_START = new Date("2026-04-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-07-01T00:00:00.000Z");
const IN_WINDOW = "2026-05-01T15:00:00.000Z";

let pg: TestDatabase;

const payloadFor = (callId: string, tenantId: string): PendingBookingPayload => ({
  callId,
  tenantId,
  customer: { name: "Rosa Peña", phone: "+13055551234", locale: "en" },
  address: {
    line1: "1247 Calle Ocho",
    city: "Miami",
    state: "FL",
    postalCode: "33135",
    formatted: "1247 SW 8th St, Miami, FL 33135",
    lat: 25.765,
    lng: -80.22,
  },
  problemDescription: "Water heater leaking into the garage",
  urgency: "SAME_DAY",
  window: { startsAt: "2026-05-02T18:00:00.000Z", endsAt: "2026-05-02T22:00:00.000Z" },
  jobTypeId: null,
});

interface SeedOutcome {
  readonly observedAt: string;
  readonly correctedFields?: Record<string, unknown>;
  readonly cancelled?: boolean;
  readonly classification?: OutcomeClassification | null;
  readonly humanLabel?: OutcomeClassification | null;
}

/** Seeded as the owner — the app role cannot write another tenant's rows, which is the point. */
async function seedBooking(
  tenantId: string,
  options: {
    readonly committedAt?: string;
    readonly completedPolls?: number;
    readonly outcomes?: readonly SeedOutcome[];
  } = {},
): Promise<{ bookingId: string; outcomes: BookingOutcome[] }> {
  const committedAt = options.committedAt ?? IN_WINDOW;

  const [call] = await pg.db
    .insert(schema.calls)
    .values({ tenantId, fromE164: "+13055551234", startedAt: new Date(committedAt) })
    .returning();

  const [pending] = await pg.db
    .insert(schema.pendingBookings)
    .values({
      callId: call!.id,
      tenantId,
      payload: payloadFor(call!.id, tenantId),
      status: "COMMITTED",
    })
    .returning();

  const [booking] = await pg.db
    .insert(schema.bookings)
    .values({
      pendingBookingId: pending!.id,
      tenantId,
      crmJobId: `job-${pending!.id.slice(0, 8)}`,
      crmCustomerId: "cust-1",
      committedAt: new Date(committedAt),
      completedPolls: options.completedPolls ?? REQUIRED_POLLS,
    })
    .returning();

  const outcomes: BookingOutcome[] = [];
  for (const seed of options.outcomes ?? []) {
    const outcome: BookingOutcome = {
      bookingId: booking!.id,
      cancelled: seed.cancelled ?? false,
      correctedFields: seed.correctedFields ?? {},
      source: "CRM_POLL",
      classification: seed.classification ?? null,
      humanLabel: seed.humanLabel ?? null,
      observedAt: seed.observedAt,
    };
    outcomes.push(outcome);

    await pg.db.insert(schema.outcomes).values({
      bookingId: booking!.id,
      tenantId,
      cancelled: outcome.cancelled,
      correctedFields: outcome.correctedFields,
      source: "CRM_POLL",
      classification: outcome.classification,
      humanLabel: outcome.humanLabel,
      observedAt: new Date(outcome.observedAt),
    });
  }

  return { bookingId: booking!.id, outcomes };
}

/** Every outcome seeded, so the SQL and the TypeScript can be run over the same rows. */
let allOutcomes: BookingOutcome[] = [];

beforeAll(async () => {
  pg = await testDatabase();

  await pg.db.insert(schema.tenants).values([
    { id: ACME, name: "Acme Plumbing", timezone: "America/New_York", trade: "plumbing", crmProvider: "housecall_pro", crmCredentials: "enc:acme" },
    { id: RIVAL, name: "Rival Rooter", timezone: "America/Chicago", trade: "plumbing", crmProvider: "jobber", crmCredentials: "enc:rival" },
    { id: THIRD, name: "Third Drain", timezone: "America/Denver", trade: "plumbing", crmProvider: "jobber", crmCredentials: "enc:third" },
  ]);

  const seeded = await Promise.all([
    // ACME: three matured bookings, one of them corrected and blamed on us.
    seedBooking(ACME, { outcomes: [{ observedAt: "2026-05-02T15:00:00.000Z" }] }),
    seedBooking(ACME, {
      outcomes: [
        // The same booking, seen three times. Counting *rows* here is what once put
        // `correctionRate` above 1.0 (Step 2, surprise #5) — the last look is the one
        // that counts, and it is the one that found the correction.
        { observedAt: "2026-05-02T15:00:00.000Z" },
        { observedAt: "2026-05-04T15:00:00.000Z" },
        {
          observedAt: "2026-05-08T15:00:00.000Z",
          correctedFields: { service_address: "1247 SW 8th St" },
          classification: "agent_error",
          humanLabel: "agent_error",
        },
      ],
    }),
    seedBooking(ACME, { outcomes: [{ observedAt: "2026-05-03T15:00:00.000Z" }] }),

    // RIVAL: two matured. One cancelled and *unclassified* — which counts against us.
    seedBooking(RIVAL, { outcomes: [{ observedAt: "2026-05-02T15:00:00.000Z" }] }),
    seedBooking(RIVAL, {
      outcomes: [{ observedAt: "2026-05-09T15:00:00.000Z", cancelled: true }],
    }),

    // THIRD: one matured booking, corrected, and triage says it was the customer's own
    // change of plan — the only correction in this cohort that is *not* our fault.
    seedBooking(THIRD, {
      outcomes: [
        {
          observedAt: "2026-05-06T15:00:00.000Z",
          correctedFields: { appointment_window: "later" },
          classification: "business_change",
          humanLabel: "business_change",
        },
      ],
    }),

    // Immature: committed in the window, polls unfinished. Excluded from both sides of the
    // ratio — it never had a chance to show a correction — and counted separately.
    seedBooking(ACME, { completedPolls: 1, outcomes: [] }),

    // Outside the window entirely. Must not appear anywhere.
    seedBooking(RIVAL, {
      committedAt: "2026-03-01T15:00:00.000Z",
      outcomes: [{ observedAt: "2026-03-02T15:00:00.000Z", cancelled: true }],
    }),
  ]);

  allOutcomes = seeded.flatMap((s) => s.outcomes);
}, 60_000);

afterAll(async () => {
  await pg.close();
});

/** As `ledgerline_app`, with **no tenant set at all** — which is how publication runs. */
const cohort = () =>
  pg.asApp((db) => new PgCohortReader(db).cohort(WINDOW_START, WINDOW_END, REQUIRED_POLLS));

describe("the cross-tenant aggregate, as the app role, with no tenant scope", () => {
  /**
   * The whole trick, in one test. `withTenant()` is never called; no `app.tenant_id` is
   * set; RLS would show this connection **nothing**. And it still computes a cohort across
   * three tenants — because the counting happens inside a `SECURITY DEFINER` function that
   * can only hand back counts.
   */
  it("counts every tenant's bookings without any of them being readable", async () => {
    const stats = await cohort();

    expect(stats.tenants).toBe(3);
    expect(stats.committedBookings).toBe(6);
  });

  it("still cannot read one row of anybody's data", async () => {
    // The other half. If the function had been a view, or the app role had been given
    // BYPASSRLS, or we had simply connected as the owner, this would return rows.
    const rows = await pg.asApp((db) => db.select().from(schema.bookings));
    expect(rows).toHaveLength(0);

    const outcomeRows = await pg.asApp((db) => db.select().from(schema.outcomes));
    expect(outcomeRows).toHaveLength(0);
  });

  it("excludes immature bookings from the rate and counts them separately", async () => {
    const stats = await cohort();

    // The one with `completed_polls = 1`. A booking nobody has re-read cannot show a
    // correction, and leaving it in the denominator dilutes the numerator — which is to say
    // the newest bookings always flatter us.
    expect(stats.immatureBookings).toBe(1);
    expect(stats.committedBookings).toBe(6);
  });

  it("ignores bookings committed outside the window", async () => {
    // RIVAL's March booking was cancelled. If the window were leaking, the correction count
    // would be one higher and the rate would be wrong in the direction that hurts us —
    // which is the direction nobody checks.
    const stats = await cohort();
    expect(stats.correctedBookings).toBe(3);
  });

  it("counts a booking once, however many times it was polled", async () => {
    // ACME's second booking has three outcome rows and is one corrected booking.
    const stats = await cohort();
    expect(stats.correctedBookings).toBe(3);
    expect(stats.correctedBookings).toBeLessThanOrEqual(stats.committedBookings);
  });
});

describe("an empty window, and a function that does not answer", () => {
  /**
   * The claim in `PgCohortReader`'s comment, checked rather than assumed: a `RETURNS TABLE`
   * of aggregates yields exactly one row even when it counts nothing. If it yielded *no*
   * row, the natural fix would be a `?? zeroes` default — which would publish a **flawless
   * correction rate over no data**, the exact failure this subsystem is built against.
   */
  it("counts an empty window as a row of zeros, not as no row at all", async () => {
    const empty = await pg.asApp((db) =>
      new PgCohortReader(db).cohort(
        new Date("2020-01-01T00:00:00.000Z"),
        new Date("2020-04-01T00:00:00.000Z"),
        REQUIRED_POLLS,
      ),
    );

    expect(empty.committedBookings).toBe(0);
    expect(empty.tenants).toBe(0);
    expect(empty.correctedBookings).toBe(0);

    // And that row of zeros must not become a published 0%.
    const decision = decidePublication({
      cohort: empty,
      id: "77777777-7777-4777-8777-777777777777",
      publishedAt: "2026-07-12T00:00:00.000Z",
    });
    expect(decision.status).toBe("withheld");
  });

  it("throws rather than inventing a cohort when the function answers with nothing", async () => {
    // The defensive branch. A driver, or a migration that left us without the function, must
    // not degrade into a zeroed cohort — because a zeroed cohort is a perfect score, and
    // "the measurement broke" and "we made no mistakes" must never produce the same page.
    const mute = { execute: async () => ({ rows: [] }) } as unknown as Queryable;

    await expect(
      new PgCohortReader(mute).cohort(WINDOW_START, WINDOW_END, REQUIRED_POLLS),
    ).rejects.toThrow(/returned no row/);
  });
});

describe("the SQL agrees with the TypeScript, row for row", () => {
  /**
   * `telemetry` publishes the number from `isCorrected()` / `isAgentError()`; `billing`
   * refuses to invoice from the same two predicates; and this SQL is a *third* statement of
   * them, in a language neither of those packages can see. A drift here would publish one
   * number and charge for another — which is the single most expensive sentence anyone
   * could write about this company (`contracts/booking.ts` says so on `isAgentError`).
   *
   * So both are run over the same rows, and compared.
   */
  const inWindow = () =>
    allOutcomes.filter(
      (o) =>
        Date.parse(o.observedAt) >= WINDOW_START.getTime() &&
        Date.parse(o.observedAt) < WINDOW_END.getTime(),
    );

  it("counts the same corrected bookings that isCorrected() does", async () => {
    const stats = await cohort();
    const expected = latestPerBooking(inWindow()).filter(isCorrected).length;

    expect(stats.correctedBookings).toBe(expected);
  });

  it("blames the same bookings on us that isAgentError() does", async () => {
    const stats = await cohort();
    const expected = latestPerBooking(inWindow()).filter(isCorrected).filter(isAgentError).length;

    // RIVAL's cancelled-and-unclassified booking is in here. **A null label is guilt**, so
    // a triage backlog pushes the published number up rather than down.
    expect(stats.agentErrorBookings).toBe(expected);
    expect(stats.agentErrorBookings).toBe(2);
  });

  it("counts an unclassified correction against us, not for us", async () => {
    const stats = await cohort();

    // Three corrections; THIRD's is the only one triage exonerated. So two are ours: the
    // one actually labeled `agent_error`, and the one nobody has labeled at all.
    expect(stats.correctedBookings).toBe(3);
    expect(stats.agentErrorBookings).toBe(2);
  });

  it("counts only doubly-labeled outcomes as audited, and agreement among those", async () => {
    const stats = await cohort();

    // Two corrections carry both a model label and a human one, and the human agreed with
    // the model on both.
    expect(stats.auditedOutcomes).toBe(2);
    expect(stats.agreedOutcomes).toBe(2);
  });
});

describe("the worst tenant, so the average cannot hide them", () => {
  it("reports the single worst correction rate and the count it is over", async () => {
    const stats = await cohort();

    // THIRD corrected its only booking: 1/1. ACME is 1/3, RIVAL 1/2. Pooled, the cohort is
    // 3/6 = 50% — and THIRD, for whom this product has never once worked, is invisible in
    // that number.
    expect(stats.worstTenantCorrectionRate).toBe(1);
    expect(stats.worstTenantBookings).toBe(1);
    expect(stats.worstTenantCorrectionRate).toBeGreaterThan(
      stats.correctedBookings / stats.committedBookings,
    );
  });

  it("names nobody — the rate leaves the function, the tenant does not", async () => {
    const stats = await cohort();

    // A published aggregate that carried tenant identity would be a public statement about
    // one named plumbing company's business, which is not what they agreed to.
    expect(Object.keys(stats)).not.toContain("worstTenantId");
    expect(JSON.stringify(stats)).not.toContain(THIRD);
  });
});

describe("a published report cannot be unpublished", () => {
  const REPORT = {
    id: "44444444-4444-4444-8444-444444444444",
    methodologyVersion: "2026-07-12",
    windowStart: WINDOW_START.toISOString(),
    windowEnd: WINDOW_END.toISOString(),
    publishedAt: "2026-07-12T00:00:00.000Z",
    tenants: 3,
    calls: 4_000,
    committedBookings: 1_000,
    correctionRate: 0.04,
    correctionRateLow: 0.029,
    correctionRateHigh: 0.054,
    agentErrorRate: 0.025,
    publishedRate: 0.04,
    publishedBasis: "raw" as const,
    publishedReason: "the classifier has not earned its place",
    auditedOutcomes: 4,
    triageAgreementRate: 1,
    worstTenantCorrectionRate: 0.12,
    worstTenantBookings: 80,
    observedCoverage: 0.98,
  };

  it("round-trips through PgReportStore", async () => {
    await pg.asApp((db) => new PgReportStore(db).publish(REPORT));
    const history = await pg.asApp((db) => new PgReportStore(db).history(10));

    expect(history).toHaveLength(1);
    expect(history[0]).toEqual(REPORT);
  });

  /**
   * An append-only table written by a cron needs this, and needs it *badly*: there is no
   * `UPDATE` and no `DELETE` grant, so a duplicate row for the same quarter could never be
   * cleaned up. It would sit on the public page forever, two slightly different numbers for
   * one period, and the only available explanation would be that we do not know what our
   * own correction rate was.
   */
  it("is idempotent — a retried cron does not stack a second figure for the same quarter", async () => {
    await pg.asApp((db) =>
      new PgReportStore(db).publish({
        ...REPORT,
        id: "66666666-6666-4666-8666-666666666666",
        correctionRate: 0.99, // a different computation of the same window
      }),
    );

    const history = await pg.asApp((db) => new PgReportStore(db).history(10));

    // The first publication of a window is the one that stands. Recomputing it later and
    // quietly overwriting is the retraction this table exists to prevent.
    expect(history).toHaveLength(1);
    expect(history[0]!.correctionRate).toBe(0.04);
  });

  /**
   * The two mechanisms, again. `ReportStore` has no `update` and no `delete` — that is the
   * type, and it is the stronger guarantee. These assert the *privilege*, which holds for a
   * raw `db.execute()` that never went near the port.
   *
   * A reliability figure a vendor can quietly retract is a marketing claim with a database
   * behind it. So a quarter we did not like cannot be withdrawn; it can only be followed by
   * another quarter published beside it.
   */
  it("the app role may not UPDATE a published figure", async () => {
    const message = await refusal(() =>
      pg.asApp((db) =>
        db.execute("UPDATE reliability_reports SET correction_rate = 0.001"),
      ),
    );

    expect(message).toMatch(/permission denied/i);
  });

  it("the app role may not DELETE a published figure", async () => {
    const message = await refusal(() =>
      pg.asApp((db) => db.execute("DELETE FROM reliability_reports")),
    );

    expect(message).toMatch(/permission denied/i);
  });
});

describe("the cohort feeds the decision that publishes it", () => {
  /**
   * The whole pipeline, end to end, over a real Postgres: six bookings across three tenants
   * → the SECURITY DEFINER aggregate → `decidePublication()`.
   *
   * And it **withholds** — because six bookings is not five hundred. That is the correct
   * answer, and it is the answer this repo will keep giving until a contractor exists. The
   * alternative (publish 50% over six bookings) would be a number with no meaning printed
   * on a page whose entire claim is that the numbers mean something.
   */
  it("withholds on a cohort this small, and says exactly why", async () => {
    const stats = await cohort();

    const decision = decidePublication({
      cohort: stats,
      id: "55555555-5555-4555-8555-555555555555",
      publishedAt: "2026-07-12T00:00:00.000Z",
    });

    expect(decision.status).toBe("withheld");
    if (decision.status !== "withheld") return;

    expect(decision.reasons.join(" ")).toContain("matured bookings");
    // The cohort rides along, so "not yet" arrives with a denominator attached.
    expect(decision.cohort.committedBookings).toBe(6);
  });
});
