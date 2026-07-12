import {
  fixedClock,
  type BookingOutcome,
  type BookingStore,
  type DueBooking,
  type OutcomeStore,
  type PendingBookingPayload,
} from "@ledgerline/contracts";
import type { CrmAdapter, CrmJobSnapshot } from "@ledgerline/crm";
import { describe, expect, it } from "vitest";
import { InMemorySnapshotStore } from "./outcomes.js";
import { runOutcomePolls } from "./poller.js";

/**
 * The cron, over the ports. `packages/db`'s `stores.test.ts` proves the Postgres side of
 * the same ports against a real Postgres; this proves the *policy* — what the cron does
 * when the CRM is down, when a booking is not due yet, and when it has been polled out.
 */

const COMMITTED_AT = "2026-07-01T15:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;

const BOOKED: PendingBookingPayload = {
  callId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  tenantId: "11111111-1111-4111-8111-111111111111",
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
  window: { startsAt: "2026-07-02T18:00:00.000Z", endsAt: "2026-07-02T22:00:00.000Z" },
  jobTypeId: null,
};

const BOOKING_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const due = (completedPolls: number): DueBooking => ({
  bookingId: BOOKING_ID,
  committedAt: COMMITTED_AT,
  completedPolls,
  booked: BOOKED,
  crmJobId: "hcp-901",
  crmCustomerId: "cust-1",
});

class FakeBookingStore implements BookingStore {
  readonly polled: string[] = [];
  constructor(private readonly rows: readonly DueBooking[]) {}

  async unfinished(
    committedBefore: Date,
    maxPolls: number,
    limit: number,
  ): Promise<readonly DueBooking[]> {
    return this.rows
      .filter(
        (row) =>
          row.completedPolls < maxPolls &&
          Date.parse(row.committedAt) <= committedBefore.getTime(),
      )
      .slice(0, limit);
  }

  async recordPoll(bookingId: string): Promise<void> {
    this.polled.push(bookingId);
  }
}

class FakeOutcomeStore implements OutcomeStore {
  readonly recorded: BookingOutcome[] = [];
  async record(outcome: BookingOutcome): Promise<void> {
    this.recorded.push(outcome);
  }
  async since(): Promise<readonly BookingOutcome[]> {
    return this.recorded;
  }
}

/** What the CRM says the job looks like now. `null` fields are *unobserved*, never wrong. */
const snapshot = (over: Partial<CrmJobSnapshot> = {}): CrmJobSnapshot => ({
  jobId: "hcp-901",
  status: "SCHEDULED",
  customer: { name: "Rosa Peña", phone: "+13055551234" },
  address: {
    line1: "1247 Calle Ocho",
    city: "Miami",
    state: "FL",
    postalCode: "33135",
  },
  description: "Water heater leaking into the garage",
  window: { startsAt: "2026-07-02T18:00:00.000Z", endsAt: "2026-07-02T22:00:00.000Z" },
  raw: { work_status: "scheduled" },
  ...over,
});

const crmReturning = (result: CrmJobSnapshot | Error): Pick<CrmAdapter, "readJob"> => ({
  async readJob() {
    if (result instanceof Error) throw result;
    return result;
  },
});

const deps = (
  bookings: FakeBookingStore,
  outcomes: FakeOutcomeStore,
  crm: Pick<CrmAdapter, "readJob">,
  now: string,
) => ({
  crm,
  bookings,
  outcomes,
  snapshots: new InMemorySnapshotStore(),
  clock: fixedClock(now),
});

describe("runOutcomePolls", () => {
  it("polls a due booking, records the outcome, and consumes the poll", async () => {
    const bookings = new FakeBookingStore([due(0)]);
    const outcomes = new FakeOutcomeStore();

    // 24h after commit: the first offset is up.
    const report = await runOutcomePolls(
      deps(
        bookings,
        outcomes,
        crmReturning(snapshot({ customer: { name: "Rose Pena", phone: "+13055551234" } })),
        "2026-07-02T16:00:00.000Z",
      ),
    );

    expect(report).toEqual({ considered: 1, polled: 1, notYetDue: 0, failed: 0 });
    expect(outcomes.recorded).toHaveLength(1);
    expect(outcomes.recorded[0]!.correctedFields).toEqual({ caller_name: "Rose Pena" });
    expect(bookings.polled).toEqual([BOOKING_ID]);
  });

  it("leaves a booking alone until its next offset comes round", async () => {
    const bookings = new FakeBookingStore([due(1)]);
    const outcomes = new FakeOutcomeStore();

    // 25h in, and the 24h poll has already run. The next is due at 72h.
    const report = await runOutcomePolls(
      deps(bookings, outcomes, crmReturning(snapshot()), "2026-07-02T17:00:00.000Z"),
    );

    expect(report).toEqual({ considered: 1, polled: 0, notYetDue: 1, failed: 0 });
    expect(outcomes.recorded).toEqual([]);
    expect(bookings.polled).toEqual([]);
  });

  it("a CRM outage records nothing, consumes no poll, and does not abort the batch", async () => {
    // The load-bearing test in this file. `readJob` throwing is the missed-webhook
    // failure mode arriving by a different route: swallow it and write "no corrections
    // observed" and we publish a perfect score out of an outage.
    const bookings = new FakeBookingStore([due(0)]);
    const outcomes = new FakeOutcomeStore();

    const report = await runOutcomePolls(
      deps(
        bookings,
        outcomes,
        crmReturning(new Error("503 Service Unavailable")),
        "2026-07-02T16:00:00.000Z",
      ),
    );

    expect(report).toEqual({ considered: 1, polled: 0, notYetDue: 0, failed: 1 });
    expect(outcomes.recorded, "an outage must not record an outcome").toEqual([]);
    // The poll is still owed. This is why `completedPolls` is a counter, not a timestamp.
    expect(bookings.polled, "an outage must not consume the poll").toEqual([]);
  });

  it("the poll a failed run owed is picked up by the next one", async () => {
    const bookings = new FakeBookingStore([due(0)]);
    const outcomes = new FakeOutcomeStore();

    await runOutcomePolls(
      deps(
        bookings,
        outcomes,
        crmReturning(new Error("503 Service Unavailable")),
        "2026-07-02T16:00:00.000Z",
      ),
    );

    // The CRM is back. The booking's `completedPolls` was never incremented, so the
    // store still offers it, and the correction is counted — late, but counted.
    const report = await runOutcomePolls(
      deps(
        bookings,
        outcomes,
        crmReturning(snapshot({ description: "Replaced the water heater" })),
        "2026-07-02T18:00:00.000Z",
      ),
    );

    expect(report.polled).toBe(1);
    expect(outcomes.recorded[0]!.correctedFields).toEqual({
      problem_description: "Replaced the water heater",
    });
  });

  it("one booking's outage does not cost the others their poll", async () => {
    const doomed = { ...due(0), bookingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
    const bookings = new FakeBookingStore([doomed, due(0)]);
    const outcomes = new FakeOutcomeStore();

    let call = 0;
    const flaky: Pick<CrmAdapter, "readJob"> = {
      async readJob() {
        call += 1;
        if (call === 1) throw new Error("429 Too Many Requests");
        return snapshot();
      },
    };

    const report = await runOutcomePolls(
      deps(bookings, outcomes, flaky, "2026-07-02T16:00:00.000Z"),
    );

    expect(report).toEqual({ considered: 2, polled: 1, notYetDue: 0, failed: 1 });
    expect(bookings.polled).toEqual([BOOKING_ID]);
  });

  it("stops re-reading a booking once it has run all three polls", async () => {
    const bookings = new FakeBookingStore([due(3)]);
    const outcomes = new FakeOutcomeStore();

    const report = await runOutcomePolls(
      deps(bookings, outcomes, crmReturning(snapshot()), "2026-08-01T00:00:00.000Z"),
    );

    expect(report.considered).toBe(0);
  });

  it("does not offer a booking committed less than the first offset ago", async () => {
    const bookings = new FakeBookingStore([due(0)]);
    const outcomes = new FakeOutcomeStore();

    const report = await runOutcomePolls(
      deps(
        bookings,
        outcomes,
        crmReturning(snapshot()),
        new Date(Date.parse(COMMITTED_AT) + DAY / 2).toISOString(),
      ),
    );

    expect(report.considered).toBe(0);
  });

  it("a cancelled job is an outcome, and it is the loudest correction there is", async () => {
    const bookings = new FakeBookingStore([due(0)]);
    const outcomes = new FakeOutcomeStore();

    await runOutcomePolls(
      deps(
        bookings,
        outcomes,
        crmReturning(snapshot({ status: "CANCELLED" })),
        "2026-07-02T16:00:00.000Z",
      ),
    );

    expect(outcomes.recorded[0]!.cancelled).toBe(true);
  });
});
