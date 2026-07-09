import {
  CONTAINED_OUTCOMES,
  type BookingOutcome,
  type CallRecord,
  type CallTurn,
  type ReliabilityMetrics,
} from "@ledgerline/contracts";

/**
 * The numbers `idea.md` §7 says nobody in this field publishes.
 *
 * Barge-in and turn-take are defined the way Full-Duplex-Bench-v3 defines them,
 * so our figures are comparable to the literature rather than merely internally
 * consistent. Latency is reported as a distribution, never as a mean: a mean
 * first-word latency hides the calls where the caller heard silence.
 */

/**
 * Nearest-rank percentile. `p` is a fraction, so p95 is `0.95`.
 *
 * Nearest-rank rather than interpolated because a latency percentile should be
 * a number some real turn actually took.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  if (p <= 0) return Math.min(...values);

  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[index]!;
}

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

export interface MetricsInput {
  readonly calls: readonly CallRecord[];
  readonly turns: readonly CallTurn[];
  /** Ground truth: bookings the contractor later cancelled or corrected. */
  readonly outcomes: readonly BookingOutcome[];
  /** Bookings that reached the CRM. The denominator for correction rate. */
  readonly committedBookings: number;
}

export function computeMetrics(input: MetricsInput): ReliabilityMetrics {
  // Calls still in flight have no outcome and cannot be scored either way.
  const finished = input.calls.filter((c) => c.outcome !== null);
  const contained = finished.filter(
    (c) => c.outcome !== null && CONTAINED_OUTCOMES.includes(c.outcome),
  );

  const agentTurns = input.turns.filter((t) => t.role === "agent");
  const firstWord = agentTurns
    .map((t) => t.firstWordLatencyMs)
    .filter((ms): ms is number => ms !== null);
  const turnLatency = agentTurns
    .map((t) => t.turnLatencyMs)
    .filter((ms): ms is number => ms !== null);

  return {
    calls: input.calls.length,
    containmentRate: ratio(contained.length, finished.length),
    correctionRate: ratio(countCorrected(input.outcomes), input.committedBookings),
    bargeInRate: ratio(agentTurns.filter((t) => t.bargeIn).length, agentTurns.length),
    turnTakeRate: ratio(agentTurns.filter((t) => t.turnTakeOk).length, agentTurns.length),
    firstWordLatencyP50Ms: percentile(firstWord, 0.5),
    firstWordLatencyP95Ms: percentile(firstWord, 0.95),
    turnLatencyP95Ms: percentile(turnLatency, 0.95),
  };
}

/**
 * A booking is "corrected" if the contractor cancelled it or edited any field.
 * Either way we got it wrong; counting them separately would let us report the
 * flattering half.
 */
function countCorrected(outcomes: readonly BookingOutcome[]): number {
  return outcomes.filter(
    (o) => o.cancelled || Object.keys(o.correctedFields).length > 0,
  ).length;
}

/** The latency budget from the plan. Exceeding either is a release blocker. */
export const LATENCY_BUDGET = {
  firstWordP95Ms: 1_200,
  turnP95Ms: 2_000,
} as const;

/**
 * Turn-take and barge-in targets, taken from GPT-Realtime's measured profile —
 * the best balance in Full-Duplex-Bench-v3 (96% turn-take, 13.5% interruption).
 * A regression past these blocks a merge (plan, Phase 2).
 */
export const TURN_TAKING_TARGET = {
  minTurnTakeRate: 0.96,
  maxBargeInRate: 0.135,
} as const;

export interface BudgetBreach {
  readonly metric: string;
  readonly observed: number;
  readonly budget: number;
}

/**
 * What CI checks on every agent change. Returns the breaches rather than a
 * boolean, because "which one regressed" is the only useful failure message.
 */
export function checkBudgets(metrics: ReliabilityMetrics): BudgetBreach[] {
  const breaches: BudgetBreach[] = [];

  if (metrics.firstWordLatencyP95Ms > LATENCY_BUDGET.firstWordP95Ms) {
    breaches.push({
      metric: "firstWordLatencyP95Ms",
      observed: metrics.firstWordLatencyP95Ms,
      budget: LATENCY_BUDGET.firstWordP95Ms,
    });
  }
  if (metrics.turnLatencyP95Ms > LATENCY_BUDGET.turnP95Ms) {
    breaches.push({
      metric: "turnLatencyP95Ms",
      observed: metrics.turnLatencyP95Ms,
      budget: LATENCY_BUDGET.turnP95Ms,
    });
  }
  if (metrics.turnTakeRate < TURN_TAKING_TARGET.minTurnTakeRate) {
    breaches.push({
      metric: "turnTakeRate",
      observed: metrics.turnTakeRate,
      budget: TURN_TAKING_TARGET.minTurnTakeRate,
    });
  }
  if (metrics.bargeInRate > TURN_TAKING_TARGET.maxBargeInRate) {
    breaches.push({
      metric: "bargeInRate",
      observed: metrics.bargeInRate,
      budget: TURN_TAKING_TARGET.maxBargeInRate,
    });
  }
  return breaches;
}
