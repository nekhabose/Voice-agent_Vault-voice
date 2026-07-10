import { describe, expect, it } from "vitest";
import { fixedClock, type PendingBookingPayload } from "@ledgerline/contracts";
import {
  CrmError,
  FakeTransport,
  HousecallProAdapter,
  type CrmJobSnapshot,
} from "@ledgerline/crm";
import { computeMetrics } from "@ledgerline/telemetry";
import {
  DIFFABLE_SLOTS,
  InMemorySnapshotStore,
  POLL_OFFSETS_MS,
  diffBooking,
  nextDuePoll,
  observeOutcome,
  pollSchedule,
  type OutcomeDeps,
} from "./outcomes.js";

const BOOKING_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const COMMITTED_AT = "2026-07-09T12:00:00.000Z";

const PAYLOAD: PendingBookingPayload = {
  callId: "3f8c1e6a-1b2c-4d5e-8f90-1a2b3c4d5e6f",
  tenantId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  customer: { name: "Rosa Delgado", phone: "+13055551234", locale: "en" },
  address: {
    line1: "1247 Calle Ocho",
    city: "Miami",
    state: "FL",
    postalCode: "33135",
    formatted: "1247 Calle Ocho, Miami, FL 33135",
  },
  problemDescription: "Water heater leaking into the garage",
  urgency: "SAME_DAY",
  window: { startsAt: "2026-07-09T18:00:00.000Z", endsAt: "2026-07-09T22:00:00.000Z" },
  jobTypeId: null,
};

/** The CRM agreeing with us on every field it can report. */
const UNCHANGED: CrmJobSnapshot = {
  jobId: "job_1",
  status: "SCHEDULED",
  window: PAYLOAD.window,
  description: PAYLOAD.problemDescription,
  address: {
    line1: "1247 Calle Ocho",
    city: "Miami",
    state: "FL",
    postalCode: "33135",
  },
  customer: { name: "Rosa Delgado", phone: "+13055551234" },
  raw: { id: "job_1" },
};

const snapshot = (overrides: Partial<CrmJobSnapshot>): CrmJobSnapshot => ({
  ...UNCHANGED,
  ...overrides,
});

/* -------------------------------------------------------------------------- */
/* The schedule                                                                */
/* -------------------------------------------------------------------------- */

describe("pollSchedule", () => {
  it("re-reads the job at 24h, 72h, and 7d", () => {
    expect(pollSchedule(COMMITTED_AT)).toEqual([
      "2026-07-10T12:00:00.000Z",
      "2026-07-12T12:00:00.000Z",
      "2026-07-16T12:00:00.000Z",
    ]);
  });

  it("holds a poll that is not due yet", () => {
    expect(nextDuePoll(COMMITTED_AT, 0, new Date("2026-07-10T11:59:00.000Z"))).toBeNull();
  });

  it("releases the poll the moment it comes due", () => {
    expect(nextDuePoll(COMMITTED_AT, 0, new Date("2026-07-10T12:00:00.000Z"))).toBe(0);
  });

  it("still owes a missed poll rather than skipping it", () => {
    // A cron that slept through the 24h window must run the poll it owed. Any
    // other behaviour drops corrections on the floor and reports a better
    // number than we earned.
    const veryLate = new Date("2026-08-01T00:00:00.000Z");
    expect(nextDuePoll(COMMITTED_AT, 0, veryLate)).toBe(0);
    expect(nextDuePoll(COMMITTED_AT, 1, veryLate)).toBe(1);
  });

  it("stops after the last offset", () => {
    const veryLate = new Date("2027-01-01T00:00:00.000Z");
    expect(nextDuePoll(COMMITTED_AT, POLL_OFFSETS_MS.length, veryLate)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The diff — every case here is a false correction waiting to happen          */
/* -------------------------------------------------------------------------- */

describe("diffBooking", () => {
  it("reports nothing when the contractor changed nothing", () => {
    expect(diffBooking(PAYLOAD, UNCHANGED)).toEqual({});
  });

  it("never diffs on the geocoder's formatted address", () => {
    // `formatted`, `lat`, `lng` are our output and no CRM echoes them. If they
    // reached the comparison, *every* booking would report a corrected address
    // and the published number would be 100%.
    expect(diffBooking(PAYLOAD, UNCHANGED).service_address).toBeUndefined();
  });

  it("does not mistake a reformatted phone number for a correction", () => {
    // We store +13055551234; Housecall Pro echoes (305) 555-1234.
    const echoed = snapshot({ customer: { name: "Rosa Delgado", phone: "(305) 555-1234" } });
    expect(diffBooking(PAYLOAD, echoed)).toEqual({});
  });

  it("does not mistake a title-cased name for a correction", () => {
    const cased = snapshot({ customer: { name: "  ROSA   DELGADO ", phone: "+13055551234" } });
    expect(diffBooking(PAYLOAD, cased)).toEqual({});
  });

  it("does not mistake an equivalent timestamp offset for a reschedule", () => {
    const sameInstant = snapshot({
      window: { startsAt: "2026-07-09T14:00:00.000-04:00", endsAt: "2026-07-09T18:00:00.000-04:00" },
    });
    expect(diffBooking(PAYLOAD, sameInstant)).toEqual({});
  });

  it("treats ZIP+4 enrichment as information, not as our error", () => {
    const enriched = snapshot({
      address: { ...UNCHANGED.address!, postalCode: "33135-2841" },
    });
    expect(diffBooking(PAYLOAD, enriched)).toEqual({});
  });

  it("catches a corrected address, and reports the contractor's fix", () => {
    const fixed = { ...UNCHANGED.address!, line1: "4120 Ponce de Leon Blvd", line2: "Apt 2" };
    expect(diffBooking(PAYLOAD, snapshot({ address: fixed }))).toEqual({
      service_address: fixed,
    });
  });

  it("catches a reschedule", () => {
    const moved = { startsAt: "2026-07-10T18:00:00.000Z", endsAt: "2026-07-10T22:00:00.000Z" };
    expect(diffBooking(PAYLOAD, snapshot({ window: moved }))).toEqual({
      appointment_window: moved,
    });
  });

  it("catches a corrected name, phone, and problem in one pass", () => {
    const wrong = snapshot({
      customer: { name: "Rosa Delgado-Fuentes", phone: "+13055559999" },
      description: "Burst pipe under the sink",
    });
    expect(diffBooking(PAYLOAD, wrong)).toEqual({
      caller_name: "Rosa Delgado-Fuentes",
      callback_phone: "+13055559999",
      problem_description: "Burst pipe under the sink",
    });
  });

  it("never turns an unreported field into a correction", () => {
    // A vendor that stops returning `description` has told us nothing about
    // whether the contractor edited it. Absence is not evidence.
    const blind = snapshot({
      window: null,
      description: null,
      address: null,
      customer: { name: null, phone: null },
    });
    expect(diffBooking(PAYLOAD, blind)).toEqual({});
  });

  it("never diffs urgency — one CRM cannot report it", () => {
    // Housecall Pro tags urgency; Jobber has nowhere to put it. Diffing it would
    // make the correction rate differ by provider for reasons that have nothing
    // to do with the agent.
    expect(DIFFABLE_SLOTS).not.toContain("urgency");
    expect(Object.keys(diffBooking(PAYLOAD, UNCHANGED))).not.toContain("urgency");
  });

  it("only ever reports keys drawn from DIFFABLE_SLOTS", () => {
    const everything = snapshot({
      customer: { name: "Someone Else", phone: "+13055559999" },
      description: "Something else",
      window: { startsAt: "2026-08-09T18:00:00.000Z", endsAt: "2026-08-09T22:00:00.000Z" },
      address: { line1: "1 Other St", city: "Hialeah", state: "FL", postalCode: "33010" },
    });
    const keys = Object.keys(diffBooking(PAYLOAD, everything));
    expect(new Set(keys)).toEqual(new Set(DIFFABLE_SLOTS));
  });
});

/* -------------------------------------------------------------------------- */
/* The poll                                                                    */
/* -------------------------------------------------------------------------- */

/** `OutcomeDeps.crm` is `Pick<CrmAdapter, "readJob">`, so this is the whole port. */
const stubCrm = (result: CrmJobSnapshot | Error): OutcomeDeps["crm"] => ({
  async readJob() {
    if (result instanceof Error) throw result;
    return result;
  },
});

function deps(result: CrmJobSnapshot | Error): OutcomeDeps & { snapshots: InMemorySnapshotStore } {
  return {
    crm: stubCrm(result),
    clock: fixedClock("2026-07-10T12:00:00.000Z"),
    snapshots: new InMemorySnapshotStore(),
  };
}

describe("observeOutcome", () => {
  it("labels a clean booking as neither cancelled nor corrected", async () => {
    const outcome = await observeOutcome(BOOKING_ID, PAYLOAD, { id: "job_1" }, deps(UNCHANGED));
    expect(outcome).toEqual({
      bookingId: BOOKING_ID,
      cancelled: false,
      correctedFields: {},
      source: "CRM_POLL",
      classification: null,
      humanLabel: null,
      observedAt: "2026-07-10T12:00:00.000Z",
    });
  });

  it("sources the outcome from a poll, because webhooks are lossy", async () => {
    const outcome = await observeOutcome(BOOKING_ID, PAYLOAD, { id: "job_1" }, deps(UNCHANGED));
    expect(outcome.source).toBe("CRM_POLL");
  });

  it("counts a cancelled job as cancelled", async () => {
    const d = deps(snapshot({ status: "CANCELLED" }));
    expect((await observeOutcome(BOOKING_ID, PAYLOAD, { id: "job_1" }, d)).cancelled).toBe(true);
  });

  it("counts a deleted job as cancelled — the booking did not survive", async () => {
    const d = deps(snapshot({ status: "DELETED", window: null, address: null, description: null }));
    const outcome = await observeOutcome(BOOKING_ID, PAYLOAD, { id: "job_1" }, d);
    expect(outcome.cancelled).toBe(true);
    // …and does not also report five phantom corrections on the way out.
    expect(outcome.correctedFields).toEqual({});
  });

  it("does not count a completed job as cancelled", async () => {
    const d = deps(snapshot({ status: "COMPLETED" }));
    expect((await observeOutcome(BOOKING_ID, PAYLOAD, { id: "job_1" }, d)).cancelled).toBe(false);
  });

  it("emits nothing at all when the CRM is down", async () => {
    // The single most dangerous bug available here: swallow the outage, record
    // "no corrections", and publish a perfect reliability score. §7 — a metric
    // whose failure mode is "looks perfect" must not depend on lossy delivery.
    const d = deps(new CrmError("throttled", "housecall_pro", 429, true));
    await expect(observeOutcome(BOOKING_ID, PAYLOAD, { id: "job_1" }, d)).rejects.toThrow(CrmError);
    expect(d.snapshots.records).toEqual([]);
  });

  it("stores the vendor payload verbatim, before it trusts its own diff", async () => {
    const d = deps(UNCHANGED);
    await observeOutcome(BOOKING_ID, PAYLOAD, { id: "job_1" }, d);
    expect(d.snapshots.records).toEqual([
      { bookingId: BOOKING_ID, polledAt: "2026-07-10T12:00:00.000Z", payload: { id: "job_1" } },
    ]);
  });

  it("rejects an outcome that does not satisfy the contract", async () => {
    const d = deps(UNCHANGED);
    await expect(observeOutcome("not-a-uuid", PAYLOAD, { id: "job_1" }, d)).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* End to end: a hand-edited job body becomes a published correction rate      */
/* -------------------------------------------------------------------------- */

describe("the wedge, end to end", () => {
  /**
   * The Step 2 exit criterion, run against a `FakeTransport` rather than a live
   * Housecall Pro sandbox: a job body edited by hand, read back through the real
   * adapter, diffed by the real poller, and fed to the real `computeMetrics()`.
   *
   * Only the credential is fake. The live-sandbox half is task 4.10.
   */
  async function outcomeFromHousecall(body: unknown) {
    const transport = new FakeTransport(() => ({ status: 200, body }));
    return observeOutcome(BOOKING_ID, PAYLOAD, { id: "job_1" }, {
      crm: new HousecallProAdapter(transport),
      clock: fixedClock("2026-07-10T12:00:00.000Z"),
      snapshots: new InMemorySnapshotStore(),
    });
  }

  const housecallBody = (address: Record<string, unknown>) => ({
    id: "job_1",
    work_status: "scheduled",
    description: PAYLOAD.problemDescription,
    schedule: { scheduled_start: PAYLOAD.window.startsAt, scheduled_end: PAYLOAD.window.endsAt },
    address,
    customer: { first_name: "Rosa", last_name: "Delgado", mobile_number: "(305) 555-1234" },
  });

  const asBooked = {
    street: "1247 Calle Ocho",
    street_line_2: null,
    city: "Miami",
    state: "FL",
    zip: "33135",
  };

  it("reports 0% when the contractor changed nothing", async () => {
    const outcome = await outcomeFromHousecall(housecallBody(asBooked));
    const metrics = computeMetrics({
      calls: [],
      turns: [],
      outcomes: [outcome],
      committedBookings: 1,
    });
    expect(metrics.correctionRate).toBe(0);
  });

  it("reports 100% when the contractor fixed the address by hand", async () => {
    const edited = { ...asBooked, street: "4120 Ponce de Leon Blvd", street_line_2: "Apt 2" };
    const outcome = await outcomeFromHousecall(housecallBody(edited));

    expect(outcome.correctedFields).toEqual({
      service_address: {
        line1: "4120 Ponce de Leon Blvd",
        line2: "Apt 2",
        city: "Miami",
        state: "FL",
        postalCode: "33135",
      },
    });

    const metrics = computeMetrics({
      calls: [],
      turns: [],
      outcomes: [outcome],
      committedBookings: 1,
    });
    expect(metrics.correctionRate).toBe(1);
  });

  it("counts one corrected booking once, however many times we polled it", async () => {
    // Three polls per booking. Counting outcome rows instead of bookings puts
    // correctionRate above 1.0 — a number ReliabilityMetricsSchema rejects and
    // no reader would believe.
    const edited = { ...asBooked, street: "4120 Ponce de Leon Blvd" };
    const outcome = await outcomeFromHousecall(housecallBody(edited));
    const threePolls = ["2026-07-10", "2026-07-12", "2026-07-16"].map((day) => ({
      ...outcome,
      observedAt: `${day}T12:00:00.000Z`,
    }));

    const metrics = computeMetrics({
      calls: [],
      turns: [],
      outcomes: threePolls,
      committedBookings: 1,
    });
    expect(metrics.correctionRate).toBe(1);
  });
});
