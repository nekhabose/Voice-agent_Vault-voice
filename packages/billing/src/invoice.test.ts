import type { BookingOutcome, OutcomeClassification } from "@ledgerline/contracts";
import { computeMetrics } from "@ledgerline/telemetry";
import { describe, expect, it } from "vitest";
import { invoiceFor, type CommittedJob } from "./invoice.js";

/**
 * Billing per booked job, and the rule that makes the wedge survivable: **we do not
 * charge for a booking we got wrong.**
 *
 * The tests below are mostly about the *directions* the money moves when something in
 * the pipeline breaks. Every one of them has to point at us.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";
const PRICE = 900;
const PERIOD = { periodStart: "2026-07-01T00:00:00.000Z", periodEnd: "2026-08-01T00:00:00.000Z" };

const job = (id: string, committedAt = "2026-07-10T15:00:00.000Z"): CommittedJob => ({
  bookingId: id,
  committedAt,
});

const outcome = (
  bookingId: string,
  over: Partial<BookingOutcome> = {},
): BookingOutcome => ({
  bookingId,
  cancelled: false,
  correctedFields: {},
  source: "CRM_POLL",
  classification: null,
  humanLabel: null,
  observedAt: "2026-07-11T15:00:00.000Z",
  ...over,
});

const corrected = (
  bookingId: string,
  classification: OutcomeClassification | null,
  humanLabel: OutcomeClassification | null = null,
): BookingOutcome =>
  outcome(bookingId, {
    correctedFields: { service_address: { line1: "88 Alhambra Cir" } },
    classification,
    humanLabel,
  });

const invoice = (jobs: CommittedJob[], outcomes: BookingOutcome[]) =>
  invoiceFor({ tenantId: TENANT, ...PERIOD, jobs, outcomes, pricePerBookingCents: PRICE });

describe("invoiceFor", () => {
  it("bills a booking the contractor kept", () => {
    const result = invoice([job("a")], [outcome("a")]);

    expect(result.booked).toBe(1);
    expect(result.billed).toBe(1);
    expect(result.totalCents).toBe(900);
  });

  it("bills a booking the poller never had anything to say about", () => {
    // Three polls over seven days found nothing to report. That is the agent working.
    const result = invoice([job("a")], []);
    expect(result.totalCents).toBe(900);
  });

  it("does not bill for a cancelled booking", () => {
    const result = invoice([job("a")], [outcome("a", { cancelled: true })]);

    expect(result.billed).toBe(0);
    expect(result.totalCents).toBe(0);
    expect(result.lines[0]!.waived).toBe("cancelled");
  });

  it("does not bill for a correction the classifier says was ours", () => {
    const result = invoice([job("a")], [corrected("a", "agent_error")]);

    expect(result.totalCents).toBe(0);
    expect(result.lines[0]!.waived).toBe("agent_error");
  });

  it("**does not bill for a correction nobody has classified** — null is guilt here too", () => {
    // The load-bearing test. A triage backlog, a declined verdict, an Anthropic outage, a
    // cron nobody wired up: each leaves `classification` null, and each now costs us
    // money rather than merely a worse published number. The inverse — bill it, refund it
    // if triage later says it was ours — is a company that profits from its own broken
    // cron, which is exactly the incentive this pricing model exists to destroy.
    const result = invoice([job("a")], [corrected("a", null)]);

    expect(result.totalCents).toBe(0);
    expect(result.lines[0]!.waived).toBe("untriaged");
  });

  it("reports untriaged waivers separately, so a broken cron is not a quiet revenue drop", () => {
    // "We were wrong" and "our triage is behind" have the same price and are different
    // problems. A `staleTriage` that climbs means `runTriage()` is not running, and the
    // first symptom of that must not be an unexplained dip in the invoice.
    const result = invoice(
      [job("a"), job("b"), job("c")],
      [corrected("a", null), corrected("b", "agent_error"), outcome("c")],
    );

    expect(result.waived).toBe(2);
    expect(result.staleTriage).toBe(1);
    expect(result.totalCents).toBe(900);
  });

  it("bills a correction that was the customer's change of mind, not our mistake", () => {
    const result = invoice([job("a")], [corrected("a", "business_change")]);

    expect(result.totalCents).toBe(900);
    expect(result.lines[0]!.waived).toBeNull();
  });

  it("bills a correction that was the CRM enriching what we captured", () => {
    const result = invoice([job("a")], [corrected("a", "enrichment")]);
    expect(result.totalCents).toBe(900);
  });

  it("the human auditor overrules the model, and it costs us", () => {
    // The model said the contractor changed their mind; the auditor said we misheard the
    // street. The audit is only worth running if it can move money, and it moves it
    // against us.
    const result = invoice([job("a")], [corrected("a", "business_change", "agent_error")]);

    expect(result.totalCents).toBe(0);
    expect(result.lines[0]!.waived).toBe("agent_error");
  });

  it("the human auditor can also overrule the model in our favour", () => {
    const result = invoice([job("a")], [corrected("a", "agent_error", "business_change")]);
    expect(result.totalCents).toBe(900);
  });

  it("counts a booking once, however many times it was polled", () => {
    // Three polls per booking. Counting rows would bill one job three times — the same
    // bug that put `correctionRate` above 1.0 in Step 2, arriving at the invoice instead
    // of the dashboard, where it would be a chargeback rather than a crash.
    const result = invoice(
      [job("a")],
      [
        outcome("a", { observedAt: "2026-07-11T15:00:00.000Z" }),
        outcome("a", { observedAt: "2026-07-13T15:00:00.000Z" }),
        outcome("a", { observedAt: "2026-07-17T15:00:00.000Z" }),
      ],
    );

    expect(result.booked).toBe(1);
    expect(result.totalCents).toBe(900);
  });

  it("takes the latest observation: a job fixed and then cancelled is not billed", () => {
    const result = invoice(
      [job("a")],
      [
        corrected("a", "business_change"),
        outcome("a", { cancelled: true, observedAt: "2026-07-18T15:00:00.000Z" }),
      ],
    );

    expect(result.lines[0]!.waived).toBe("cancelled");
    expect(result.totalCents).toBe(0);
  });

  it("excludes jobs committed outside the period, and the end is exclusive", () => {
    // Exclusive, so a job committed at exactly midnight on the 1st is billed once, by
    // August, rather than twice or never.
    const result = invoice(
      [
        job("before", "2026-06-30T23:59:59.999Z"),
        job("inside", "2026-07-01T00:00:00.000Z"),
        job("after", "2026-08-01T00:00:00.000Z"),
      ],
      [],
    );

    expect(result.booked).toBe(1);
    expect(result.lines.map((line) => line.bookingId)).toEqual(["inside"]);
  });
});

describe("the invoice and the published number cannot disagree about whose fault it was", () => {
  /**
   * `isAgentError` lives in `contracts` and both packages import it. This is the test
   * that says why: if `billing` and `telemetry` drifted, we would invoice a contractor
   * for a booking we had publicly called our own error — and we are the company that
   * publishes its own error rate. The two claims cannot both be made by one business.
   *
   * So the assertion is an *identity*, over the same outcomes: every booking the metrics
   * count as an agent error is a booking the invoice waives, and every booking it bills
   * is one the metrics do not.
   */
  it("every booking counted as an agent error is a booking we did not charge for", () => {
    const outcomes = [
      outcome("kept"),
      corrected("ours", "agent_error"),
      corrected("untriaged", null),
      corrected("theirs", "business_change"),
      outcome("cancelled", { cancelled: true }),
      corrected("overruled", "business_change", "agent_error"),
    ];
    const jobs = outcomes.map((o) => job(o.bookingId));

    const metrics = computeMetrics({
      calls: [],
      turns: [],
      outcomes,
      committedBookings: jobs.length,
    });
    const result = invoice(jobs, outcomes);

    // 4 of 6 are our fault: `ours`, `untriaged`, `cancelled`, and `overruled`.
    const agentErrors = Math.round(metrics.agentErrorRate * jobs.length);
    expect(agentErrors).toBe(4);
    expect(result.waived).toBe(agentErrors);
    expect(result.billed).toBe(jobs.length - agentErrors);
    expect(result.totalCents).toBe(2 * PRICE);
  });
});
