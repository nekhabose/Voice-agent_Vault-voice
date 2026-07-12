import { describe, expect, it } from "vitest";
import type { BookingOutcome, CallOutcome, CallRecord, CallTurn } from "@ledgerline/contracts";
import {
  AUDIT_AGREEMENT_FLOOR,
  MIN_AUDITED_OUTCOMES,
  checkBudgets,
  computeMetrics,
  percentile,
  publishedCorrectionRate,
} from "./metrics.js";

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
  source: "CRM_POLL",
  classification: null,
  humanLabel: null,
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

  it("counts one booking once, however many times the poller saw it", () => {
    // The poller re-reads every job at 24h, 72h, and 7d, so one corrected
    // booking arrives as three outcome rows. Counting rows would put
    // correctionRate at 3.0 — a value ReliabilityMetricsSchema rejects outright.
    const bookingId = uuid();
    const corrected = { service_address: "1249 Calle Ocho" };
    const metrics = computeMetrics({
      calls: [],
      turns: [],
      outcomes: [
        outcome({ bookingId, correctedFields: corrected, observedAt: "2026-07-10T09:00:00.000Z" }),
        outcome({ bookingId, correctedFields: corrected, observedAt: "2026-07-12T09:00:00.000Z" }),
        outcome({ bookingId, correctedFields: corrected, observedAt: "2026-07-16T09:00:00.000Z" }),
      ],
      committedBookings: 1,
    });
    expect(metrics.correctionRate).toBe(1);
  });

  it("believes the latest poll, not the first", () => {
    // The 24h poll found the job clean; by 7d the contractor had cancelled it.
    // Keeping the earlier observation would report a booking that never failed.
    const bookingId = uuid();
    const metrics = computeMetrics({
      calls: [],
      turns: [],
      outcomes: [
        outcome({ bookingId, observedAt: "2026-07-10T09:00:00.000Z" }),
        outcome({ bookingId, cancelled: true, observedAt: "2026-07-16T09:00:00.000Z" }),
      ],
      committedBookings: 1,
    });
    expect(metrics.correctionRate).toBe(1);
  });

  it("does not let a stale poll un-fail a booking", () => {
    // Same two observations, delivered out of order. `observedAt` decides, not
    // array position — a cron does not guarantee ordering.
    const bookingId = uuid();
    const metrics = computeMetrics({
      calls: [],
      turns: [],
      outcomes: [
        outcome({ bookingId, cancelled: true, observedAt: "2026-07-16T09:00:00.000Z" }),
        outcome({ bookingId, observedAt: "2026-07-10T09:00:00.000Z" }),
      ],
      committedBookings: 1,
    });
    expect(metrics.correctionRate).toBe(1);
  });
});

/**
 * Step 6. Triage answers *why* a booking was corrected, and the only thing it is
 * allowed to do with the answer is produce a second number beside the first. The
 * suite below is mostly a list of ways it could have been allowed to do more.
 */
describe("computeMetrics — agent-error rate", () => {
  const corrected = { service_address: "1247 SW 8th St" };

  const scored = (outcomes: BookingOutcome[], committedBookings = 4) =>
    computeMetrics({ calls: [], turns: [], outcomes, committedBookings });

  /**
   * The load-bearing default. A triage backlog, a declined verdict, an Anthropic
   * outage, a cron nobody wired up — all of them leave `classification` null, and
   * all of them must make the published number *worse*. The opposite reading
   * ("unclassified, so probably not our fault") is the missed webhook again: a
   * metric whose failure mode is "looks perfect".
   */
  it("counts an untriaged correction as our fault", () => {
    const metrics = scored([outcome({ correctedFields: corrected })]);
    expect(metrics.correctionRate).toBe(0.25);
    expect(metrics.agentErrorRate).toBe(0.25);
  });

  it("drops a correction the triage pass attributed to the world, not to us", () => {
    const metrics = scored([
      outcome({ correctedFields: corrected, classification: "business_change" }),
      outcome({ correctedFields: corrected, classification: "enrichment" }),
    ]);
    expect(metrics.correctionRate).toBe(0.5);
    expect(metrics.agentErrorRate).toBe(0);
  });

  /** The raw rate never moves. Redefining it is the one thing that kills the wedge. */
  it("never lets triage lower the raw correction rate", () => {
    const metrics = scored([
      outcome({ correctedFields: corrected, classification: "agent_error" }),
      outcome({ correctedFields: corrected, classification: "business_change" }),
    ]);
    expect(metrics.correctionRate).toBe(0.5);
    expect(metrics.agentErrorRate).toBe(0.25);
    expect(metrics.agentErrorRate).toBeLessThanOrEqual(metrics.correctionRate);
  });

  it("lets the human auditor overrule the model, in both directions", () => {
    const exonerated = scored([
      outcome({
        correctedFields: corrected,
        classification: "agent_error",
        humanLabel: "business_change",
      }),
    ]);
    expect(exonerated.agentErrorRate).toBe(0);

    const convicted = scored([
      outcome({
        correctedFields: corrected,
        classification: "enrichment",
        humanLabel: "agent_error",
      }),
    ]);
    expect(convicted.agentErrorRate).toBe(0.25);
  });

  it("reports how often the model and the human agreed", () => {
    const metrics = scored([
      outcome({
        correctedFields: corrected,
        classification: "agent_error",
        humanLabel: "agent_error",
      }),
      outcome({
        correctedFields: corrected,
        classification: "enrichment",
        humanLabel: "agent_error",
      }),
      outcome({ correctedFields: corrected, classification: "agent_error" }),
    ]);

    expect(metrics.auditedOutcomes).toBe(2);
    expect(metrics.triageAgreementRate).toBe(0.5);
  });

  it("has no agreement rate to report when nobody has audited anything", () => {
    const metrics = scored([outcome({ correctedFields: corrected })]);
    expect(metrics.auditedOutcomes).toBe(0);
    expect(metrics.triageAgreementRate).toBe(0);
  });

  /** Three polls per booking. The label rides on the latest, and it is one booking. */
  it("scores the latest observation of a booking, not all three", () => {
    const bookingId = uuid();
    const metrics = scored([
      outcome({ bookingId, correctedFields: corrected, observedAt: "2026-07-10T09:00:00.000Z" }),
      outcome({
        bookingId,
        correctedFields: corrected,
        classification: "business_change",
        observedAt: "2026-07-16T09:00:00.000Z",
      }),
    ]);
    expect(metrics.correctionRate).toBe(0.25);
    expect(metrics.agentErrorRate).toBe(0);
  });
});

describe("publishedCorrectionRate", () => {
  const corrected = { service_address: "1247 SW 8th St" };

  /** `n` corrections, all triaged as not-our-fault, `audited` of them re-labeled by a human. */
  const withAudit = (n: number, audited: number, agreeing: number): BookingOutcome[] =>
    Array.from({ length: n }, (_, i) =>
      outcome({
        correctedFields: corrected,
        classification: "business_change",
        humanLabel:
          i < agreeing ? "business_change" : i < audited ? "agent_error" : null,
      }),
    );

  const scored = (outcomes: BookingOutcome[]) =>
    computeMetrics({ calls: [], turns: [], outcomes, committedBookings: 100 });

  /**
   * The classifier is *earned*, not assumed. Until a human audit of meaningful
   * size vouches for it, the number we publish is the raw one — which is worse for
   * us, and true.
   */
  it("publishes the raw rate while the audit is too small to mean anything", () => {
    const published = publishedCorrectionRate(scored(withAudit(30, 3, 3)));
    expect(published.basis).toBe("raw");
    expect(published.rate).toBe(0.3);
    expect(published.reason).toContain("has not earned its place");
  });

  /** Plan, Step 6: "if model and human disagree more than ~5%... drop the classifier". */
  it("drops the classifier when the human auditor disagrees too often", () => {
    const published = publishedCorrectionRate(scored(withAudit(40, 25, 20)));
    expect(published.basis).toBe("raw");
    expect(published.rate).toBe(0.4);
    expect(published.reason).toContain("80.0%");
  });

  it("publishes the triaged rate once the audit vouches for it", () => {
    const metrics = scored(withAudit(40, 25, 25));
    const published = publishedCorrectionRate(metrics);

    expect(published.basis).toBe("agent_error");
    expect(published.rate).toBe(metrics.agentErrorRate);
    expect(published.rate).toBeLessThan(metrics.correctionRate);
    expect(published.reason).toContain("25 audited labels");
  });

  it("states its basis, always: a rate without a method is a claim", () => {
    for (const outcomes of [withAudit(30, 3, 3), withAudit(40, 25, 25)]) {
      expect(publishedCorrectionRate(scored(outcomes)).reason).not.toBe("");
    }
  });

  it("agrees with the constants the plan names", () => {
    expect(AUDIT_AGREEMENT_FLOOR).toBe(0.95);
    expect(MIN_AUDITED_OUTCOMES).toBe(20);
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

/* -------------------------------------------------------------------------- */
/* Step 8 — the retention interlock                                            */
/* -------------------------------------------------------------------------- */

/**
 * **The reliability numbers outlive the words they were computed beside.**
 *
 * Step 8's retention job blanks `call_turns.text` and leaves the latency, barge-in, and
 * turn-take columns standing, and this is the assertion that makes that safe: every metric
 * in this file is computed from turn *shape*, never turn *content*.
 *
 * It reads like a tautology and it is not. The obvious way to build any of these — a
 * containment heuristic over the transcript, a barge-in detector that looks for a cut-off
 * word — would have coupled the number we publish to the caller's own words, and a
 * retention policy would then have been a choice between deleting somebody's voice and
 * being able to prove our error rate. Nobody would have made that choice on purpose; it
 * would have been discovered, late, by somebody looking for a way out of it.
 *
 * So: same calls, same turns, every `text` blanked. Identical metrics.
 */
describe("computeMetrics survives a retention purge", () => {
  const calls = [call("BOOKED"), call("ESCALATED_OTHER")];
  const turns: CallTurn[] = [
    agentTurn({ firstWordLatencyMs: 300, turnLatencyMs: 800 }),
    agentTurn({ firstWordLatencyMs: 900, turnLatencyMs: 1_500, bargeIn: true }),
    agentTurn({ turnTakeOk: false, firstWordLatencyMs: null, turnLatencyMs: null }),
    { ...agentTurn(), role: "caller", text: "my water heater is leaking" },
  ];

  const outcomes = [outcome({ correctedFields: { service_address: "88 Brickell Ave" } })];

  it("computes the same numbers over turns whose text has been deleted", () => {
    const before = computeMetrics({ calls, turns, outcomes, committedBookings: 2 });
    const purged = turns.map((t) => ({ ...t, text: "" }));
    const after = computeMetrics({ calls, turns: purged, outcomes, committedBookings: 2 });

    expect(after).toEqual(before);
  });
});
