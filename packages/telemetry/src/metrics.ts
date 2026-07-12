import {
  CONTAINED_OUTCOMES,
  effectiveLabel,
  isCorrected,
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

  const corrected = latestPerBooking(input.outcomes).filter(isCorrected);
  const audited = corrected.filter(
    (o) => o.humanLabel !== null && o.classification !== null,
  );
  const agreed = audited.filter((o) => o.humanLabel === o.classification);

  return {
    calls: input.calls.length,
    containmentRate: ratio(contained.length, finished.length),
    correctionRate: ratio(corrected.length, input.committedBookings),
    agentErrorRate: ratio(corrected.filter(isAgentError).length, input.committedBookings),
    auditedOutcomes: audited.length,
    triageAgreementRate: ratio(agreed.length, audited.length),
    bargeInRate: ratio(agentTurns.filter((t) => t.bargeIn).length, agentTurns.length),
    turnTakeRate: ratio(agentTurns.filter((t) => t.turnTakeOk).length, agentTurns.length),
    firstWordLatencyP50Ms: percentile(firstWord, 0.5),
    firstWordLatencyP95Ms: percentile(firstWord, 0.95),
    turnLatencyP95Ms: percentile(turnLatency, 0.95),
  };
}

/**
 * A booking is "corrected" if the contractor cancelled it or edited any field
 * (`isCorrected`, in `contracts`). Either way we got it wrong; counting them
 * separately would let us report the flattering half.
 *
 * **Counted per booking, not per outcome.** The poller re-reads each job at 24h,
 * 72h, and 7d, so one corrected booking arrives as up to three `BookingOutcome`
 * rows. Counting rows would put `correctionRate` above 1.0 — a number that
 * `ReliabilityMetricsSchema` rejects and that no reader would believe. The
 * latest observation wins: a contractor who fixed an address and then cancelled
 * outright has told us the booking failed once.
 */
function latestPerBooking(outcomes: readonly BookingOutcome[]): BookingOutcome[] {
  const latest = new Map<string, BookingOutcome>();
  for (const outcome of outcomes) {
    const seen = latest.get(outcome.bookingId);
    if (!seen || Date.parse(outcome.observedAt) >= Date.parse(seen.observedAt)) {
      latest.set(outcome.bookingId, outcome);
    }
  }
  return [...latest.values()];
}

/**
 * **An untriaged correction is an agent error until someone shows otherwise.**
 *
 * This one line is what keeps Step 6 from being a way to make the number look
 * better. `null` — the nightly pass has not run, the model declined, Anthropic was
 * down, the cron is broken — reads as *our fault*, so every failure mode of the
 * triage pipeline pushes `agentErrorRate` up toward the raw correction rate. A
 * classifier can only ever *lower* the published number, and only by producing an
 * argument a human auditor can check.
 *
 * The inverse — unclassified means "not our fault" — is the missed webhook wearing
 * its third hat (plan, §7): a metric whose failure mode is "looks perfect".
 */
const isAgentError = (outcome: BookingOutcome): boolean => {
  const label = effectiveLabel(outcome);
  return label === null || label === "agent_error";
};

/* -------------------------------------------------------------------------- */
/* What we are allowed to publish                                              */
/* -------------------------------------------------------------------------- */

/**
 * "If model and human disagree more than ~5% of the time, publish the raw
 * correction rate and drop the classifier until it earns its place" (plan, Step
 * 6). That sentence, as a function.
 */
export const AUDIT_AGREEMENT_FLOOR = 0.95;

/**
 * Below this many audited corrections, the agreement rate is noise and cannot
 * license anything. Three audits that happened to agree is not evidence; it is a
 * small number that flatters us, and the whole point of Step 6.3 is to stop
 * ourselves from reasoning that way.
 */
export const MIN_AUDITED_OUTCOMES = 20;

export interface PublishedRate {
  /** The number that goes on the website. */
  readonly rate: number;
  readonly basis: "agent_error" | "raw";
  /** Published with it, always. A rate without its basis is a claim without a method. */
  readonly reason: string;
}

/**
 * The number we are entitled to put in front of a contractor, and why.
 *
 * The triaged rate is *earned*, not assumed: it is used only while a human audit
 * of meaningful size says the classifier is telling the truth. Until then — and
 * the moment agreement slips — we publish the raw correction rate, which is worse
 * for us and true.
 *
 * This is principle #5's corollary made mechanical. The temptation, on the day the
 * raw number embarrasses us, is to point at the classifier and say most of those
 * were not really our fault. This function is what we wrote down *before* that
 * day, and it is deliberately hard to argue with afterwards.
 */
export function publishedCorrectionRate(metrics: ReliabilityMetrics): PublishedRate {
  if (metrics.auditedOutcomes < MIN_AUDITED_OUTCOMES) {
    return {
      rate: metrics.correctionRate,
      basis: "raw",
      reason: `only ${metrics.auditedOutcomes} audited corrections; the classifier has not earned its place (needs ${MIN_AUDITED_OUTCOMES})`,
    };
  }

  if (metrics.triageAgreementRate < AUDIT_AGREEMENT_FLOOR) {
    return {
      rate: metrics.correctionRate,
      basis: "raw",
      reason: `the classifier agrees with the human auditor only ${(metrics.triageAgreementRate * 100).toFixed(1)}% of the time; below ${AUDIT_AGREEMENT_FLOOR * 100}% we do not use it`,
    };
  }

  return {
    rate: metrics.agentErrorRate,
    basis: "agent_error",
    reason: `corrections attributed to the agent, over ${metrics.auditedOutcomes} audited labels at ${(metrics.triageAgreementRate * 100).toFixed(1)}% human agreement`,
  };
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
