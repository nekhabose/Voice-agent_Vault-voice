import { describe, expect, it } from "vitest";
import type { BookingOutcome, CallOutcome, CallRecord, CallTurn } from "@ledgerline/contracts";
import { checkBudgets, computeMetrics, percentile } from "./metrics.js";

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;

function call(outcome: CallOutcome | null): CallRecord {
  return {
    id: uuid(),
    tenantId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    fromE164: "+13055551234",
    startedAt: "2026-07-08T12:00:00.000Z",
    endedAt: outcome ? "2026-07-08T12:02:00.000Z" : null,
    localesDetected: ["es"],
    outcome,
    containment: outcome === "BOOKED",
    recordingUrl: null,
    transcriptUrl: null,
  };
}

function agentTurn(overrides: Partial<CallTurn> = {}): CallTurn {
  return {
    callId: uuid(),
    idx: 0,
    role: "agent",
    state: "TRIAGE",
    text: "Un momento",
    firstWordLatencyMs: 400,
    turnLatencyMs: 900,
    bargeIn: false,
    turnTakeOk: true,
    createdAt: "2026-07-08T12:00:01.000Z",
    ...overrides,
  };
}

const outcome = (o: Partial<BookingOutcome>): BookingOutcome => ({
  bookingId: uuid(),
  cancelled: false,
  correctedFields: {},
  source: "CRM_WEBHOOK",
  observedAt: "2026-07-09T09:00:00.000Z",
  ...o,
});

describe("percentile", () => {
  it("returns 0 for no samples rather than NaN", () => {
    expect(percentile([], 0.95)).toBe(0);
  });

  it("returns a value some real turn actually took", () => {
    const values = [100, 200, 300, 400, 500];
    expect(values).toContain(percentile(values, 0.95));
  });

  it.each([
    [0.5, 300],
    [0.95, 500],
    [1, 500],
  ])("p%s of 100..500 is %i", (p, expected) => {
    expect(percentile([100, 200, 300, 400, 500], p)).toBe(expected);
  });

  it("is order-independent", () => {
    expect(percentile([500, 100, 300, 200, 400], 0.5)).toBe(300);
  });

  it("handles a single sample", () => {
    expect(percentile([42], 0.95)).toBe(42);
  });

  it("clamps a non-positive percentile to the minimum", () => {
    expect(percentile([100, 200], 0)).toBe(100);
    expect(percentile([100, 200], -1)).toBe(100);
  });
});

describe("computeMetrics — containment", () => {
  it("scores only finished calls, ignoring the one still ringing", () => {
    const metrics = computeMetrics({
      calls: [call("BOOKED"), call("BOOKED"), call("ESCALATED_EMERGENCY"), call(null)],
      turns: [],
      outcomes: [],
      committedBookings: 2,
    });

    expect(metrics.calls).toBe(4);
    // 2 booked out of 3 finished. The live call is not a failure yet.
    expect(metrics.containmentRate).toBeCloseTo(2 / 3);
  });

  it("counts an emergency escalation against containment, as it should", () => {
    const metrics = computeMetrics({
      calls: [call("ESCALATED_EMERGENCY")],
      turns: [],
      outcomes: [],
      committedBookings: 0,
    });
    expect(metrics.containmentRate).toBe(0);
  });

  it("returns zero rather than NaN when nothing has finished", () => {
    const metrics = computeMetrics({
      calls: [call(null)],
      turns: [],
      outcomes: [],
      committedBookings: 0,
    });
    expect(metrics.containmentRate).toBe(0);
  });
});

describe("computeMetrics — correction rate", () => {
  it("counts a cancelled booking as a failure", () => {
    const metrics = computeMetrics({
      calls: [],
      turns: [],
      outcomes: [outcome({ cancelled: true })],
      committedBookings: 4,
    });
    expect(metrics.correctionRate).toBe(0.25);
  });

  it("counts an edited field as a failure too", () => {
    const metrics = computeMetrics({
      calls: [],
      turns: [],
      outcomes: [outcome({ correctedFields: { service_address: "1249 Calle Ocho" } })],
      committedBookings: 2,
    });
    expect(metrics.correctionRate).toBe(0.5);
  });

  it("does not double-count a booking that was both edited and cancelled", () => {
    const metrics = computeMetrics({
      calls: [],
      turns: [],
      outcomes: [outcome({ cancelled: true, correctedFields: { urgency: "ROUTINE" } })],
      committedBookings: 1,
    });
    expect(metrics.correctionRate).toBe(1);
  });

  it("ignores an untouched booking", () => {
    const metrics = computeMetrics({
      calls: [],
      turns: [],
      outcomes: [outcome({}), outcome({})],
      committedBookings: 2,
    });
    expect(metrics.correctionRate).toBe(0);
  });
});

describe("computeMetrics — turn taking", () => {
  it("measures barge-in and turn-take over agent turns only", () => {
    const metrics = computeMetrics({
      calls: [],
      turns: [
        agentTurn({ bargeIn: true }),
        agentTurn({ bargeIn: false }),
        agentTurn({ bargeIn: false, turnTakeOk: false }),
        agentTurn({ bargeIn: false }),
        // Caller turns must not dilute the denominator.
        { ...agentTurn(), role: "caller", bargeIn: true, turnTakeOk: false },
      ],
      outcomes: [],
      committedBookings: 0,
    });

    expect(metrics.bargeInRate).toBe(0.25);
    expect(metrics.turnTakeRate).toBe(0.75);
  });

  it("returns zero rates for a call with no agent turns", () => {
    const metrics = computeMetrics({ calls: [], turns: [], outcomes: [], committedBookings: 0 });
    expect(metrics.bargeInRate).toBe(0);
    expect(metrics.turnTakeRate).toBe(0);
  });
});

describe("computeMetrics — latency", () => {
  it("reports a distribution, not a mean", () => {
    const latencies = [200, 300, 400, 500, 5_000];
    const metrics = computeMetrics({
      calls: [],
      turns: latencies.map((ms) => agentTurn({ firstWordLatencyMs: ms, turnLatencyMs: ms * 2 })),
      outcomes: [],
      committedBookings: 0,
    });

    expect(metrics.firstWordLatencyP50Ms).toBe(400);
    // The mean would be 1,280ms and would hide the caller who waited 5 seconds.
    expect(metrics.firstWordLatencyP95Ms).toBe(5_000);
    expect(metrics.turnLatencyP95Ms).toBe(10_000);
  });

  it("skips turns where the agent never spoke rather than scoring them as fast", () => {
    const metrics = computeMetrics({
      calls: [],
      turns: [
        agentTurn({ firstWordLatencyMs: 800 }),
        agentTurn({ firstWordLatencyMs: null, turnLatencyMs: null, turnTakeOk: false }),
      ],
      outcomes: [],
      committedBookings: 0,
    });

    // A silent turn is a turn-take failure, not a 0ms response.
    expect(metrics.firstWordLatencyP50Ms).toBe(800);
    expect(metrics.turnTakeRate).toBe(0.5);
  });
});

describe("checkBudgets", () => {
  const healthy = computeMetrics({
    calls: [call("BOOKED")],
    turns: Array.from({ length: 100 }, (_, i) =>
      agentTurn({
        firstWordLatencyMs: 500,
        turnLatencyMs: 1_000,
        bargeIn: i < 13,
        turnTakeOk: i < 97,
      }),
    ),
    outcomes: [],
    committedBookings: 1,
  });

  it("passes a run inside every budget", () => {
    expect(checkBudgets(healthy)).toEqual([]);
  });

  it("flags a first-word latency regression", () => {
    const breaches = checkBudgets({ ...healthy, firstWordLatencyP95Ms: 1_500 });
    expect(breaches).toEqual([
      { metric: "firstWordLatencyP95Ms", observed: 1_500, budget: 1_200 },
    ]);
  });

  it("flags a turn-take regression — speed that produces silence is not speed", () => {
    const breaches = checkBudgets({ ...healthy, turnTakeRate: 0.78 });
    expect(breaches.map((b) => b.metric)).toEqual(["turnTakeRate"]);
  });

  it("flags an interruption regression", () => {
    const breaches = checkBudgets({ ...healthy, bargeInRate: 0.48 });
    expect(breaches.map((b) => b.metric)).toEqual(["bargeInRate"]);
  });

  it("catches the classic trade: latency bought with silence", () => {
    const breaches = checkBudgets({
      ...healthy,
      firstWordLatencyP95Ms: 300,
      turnTakeRate: 0.78,
    });
    expect(breaches.map((b) => b.metric)).toEqual(["turnTakeRate"]);
  });

  it("reports every breach at once, not just the first", () => {
    const breaches = checkBudgets({
      ...healthy,
      firstWordLatencyP95Ms: 9_000,
      turnLatencyP95Ms: 9_000,
      turnTakeRate: 0.1,
      bargeInRate: 0.9,
    });
    expect(breaches).toHaveLength(4);
  });
});
