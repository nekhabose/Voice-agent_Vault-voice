import {
  fixedClock,
  type BookingOutcome,
  type TriageCase,
} from "@ledgerline/contracts";
import {
  BOOKED,
  FakeTriager,
  TRIAGE_MODEL,
  classified,
  declined,
  triageUnavailable,
} from "@ledgerline/triage";
import { describe, expect, it } from "vitest";
import {
  AUDIT_SAMPLE_RATE,
  InMemoryTriageStore,
  auditSample,
  runTriage,
  type TriageRow,
  type TriageStore,
} from "./triage.js";

const CLOCK = fixedClock("2026-07-12T04:00:00.000Z");

const MISHEARD = { service_address: { line1: "1247 SW 8th St" } };

function outcome(id: string, over: Partial<BookingOutcome> = {}): BookingOutcome {
  return {
    bookingId: id,
    cancelled: false,
    correctedFields: MISHEARD,
    source: "CRM_POLL",
    classification: null,
    humanLabel: null,
    observedAt: "2026-07-11T18:00:00.000Z",
    ...over,
  };
}

const uuid = (n: number): string =>
  `b8f0d3c2-9a1e-4c7b-8f2d-6e5a4b3c2d${String(n).padStart(2, "0")}`;

const row = (o: BookingOutcome): TriageRow => ({ outcome: o, booked: BOOKED });

const deps = (store: TriageStore, triager: FakeTriager) => ({
  triager,
  store,
  clock: CLOCK,
  model: TRIAGE_MODEL,
});

describe("the nightly pass", () => {
  it("classifies every corrected booking that has no label yet", async () => {
    const store = new InMemoryTriageStore([row(outcome(uuid(1))), row(outcome(uuid(2)))]);
    const triager = new FakeTriager([
      classified("agent_error", "service_address: same street, two names."),
      classified("business_change", "appointment_window: the customer moved it."),
    ]);

    const report = await runTriage(deps(store, triager));

    expect(report).toEqual({
      reviewed: 2,
      classified: 2,
      declined: 0,
      unavailable: 0,
      skipped: 0,
    });
    expect(store.outcomes.map((o) => o.classification)).toEqual([
      "agent_error",
      "business_change",
    ]);
  });

  it("records the model, the time, and an argument a human can check", async () => {
    const store = new InMemoryTriageStore([row(outcome(uuid(1)))]);
    await runTriage(
      deps(store, new FakeTriager([classified("agent_error", "service_address: misheard.")])),
    );

    expect(store.classifications).toEqual([
      {
        bookingId: uuid(1),
        observedAt: "2026-07-11T18:00:00.000Z",
        classification: "agent_error",
        rationale: "service_address: misheard.",
        classifiedBy: TRIAGE_MODEL,
        classifiedAt: "2026-07-12T04:00:00.000Z",
      },
    ]);
  });

  /**
   * Step 6.2, and the reason `TriageStore.classify` takes the derived columns and
   * nothing else. The raw diff is the evidence, it is kept forever, and anyone —
   * including someone who thinks we are lying — can recount from it.
   */
  it("never touches the raw diff", async () => {
    const store = new InMemoryTriageStore([row(outcome(uuid(1), { cancelled: true }))]);
    await runTriage(deps(store, new FakeTriager([classified("business_change")])));

    const [after] = store.outcomes;
    expect(after!.correctedFields).toEqual(MISHEARD);
    expect(after!.cancelled).toBe(true);
    expect(after!.source).toBe("CRM_POLL");
    expect(after!.observedAt).toBe("2026-07-11T18:00:00.000Z");
  });

  /** A booking nobody corrected has no "why". Asked for one, a model invents it. */
  it("never asks the model about a booking nobody corrected", async () => {
    const untouched: TriageCase = { outcome: outcome(uuid(3), { correctedFields: {} }), booked: BOOKED };
    const store: TriageStore = {
      pending: async () => [untouched],
      classify: async () => {
        throw new Error("must not classify an uncorrected booking");
      },
    };
    const triager = new FakeTriager([classified("agent_error")]);

    const report = await runTriage(deps(store, triager));

    expect(report.skipped).toBe(1);
    expect(report.classified).toBe(0);
    expect(triager.cases).toEqual([]);
  });

  it("does not re-triage what it has already labeled", async () => {
    const store = new InMemoryTriageStore([row(outcome(uuid(1)))]);
    await runTriage(deps(store, new FakeTriager([classified("enrichment")])));

    const second = new FakeTriager([classified("agent_error")]);
    const report = await runTriage(deps(store, second));

    expect(report.reviewed).toBe(0);
    expect(second.cases).toEqual([]);
    expect(store.outcomes[0]!.classification).toBe("enrichment");
  });

  it("honours the batch limit", async () => {
    const store = new InMemoryTriageStore([
      row(outcome(uuid(1))),
      row(outcome(uuid(2))),
      row(outcome(uuid(3))),
    ]);
    const report = await runTriage(deps(store, new FakeTriager([classified("agent_error")])), {
      limit: 1,
    });
    expect(report.reviewed).toBe(1);
  });
});

/**
 * Every failure mode of this file leaves the correction *unlabeled*, and
 * `packages/telemetry` counts an unlabeled correction as an agent error. So a
 * model that shrugs, an Anthropic outage, and a cron that never fires all push the
 * published number **up**. That is the only direction it is safe for them to point.
 */
describe("when triage fails, it fails against us", () => {
  it("writes nothing when the model declines", async () => {
    const store = new InMemoryTriageStore([row(outcome(uuid(1)))]);
    const report = await runTriage(deps(store, new FakeTriager([declined("cannot tell")])));

    expect(report.declined).toBe(1);
    expect(store.classifications).toEqual([]);
    expect(store.outcomes[0]!.classification).toBeNull();
  });

  it("writes nothing when the model is down, and does not abort the batch", async () => {
    const store = new InMemoryTriageStore([row(outcome(uuid(1))), row(outcome(uuid(2)))]);
    const triager = new FakeTriager([
      triageUnavailable("529 overloaded"),
      classified("agent_error", "service_address: misheard."),
    ]);

    const report = await runTriage(deps(store, triager));

    expect(report).toMatchObject({ reviewed: 2, classified: 1, unavailable: 1 });
    expect(store.outcomes[0]!.classification).toBeNull();
    expect(store.outcomes[1]!.classification).toBe("agent_error");
  });
});

/* -------------------------------------------------------------------------- */
/* The weekly human audit (Step 6.3)                                           */
/* -------------------------------------------------------------------------- */

describe("the audit sample", () => {
  const many = Array.from({ length: 400 }, (_, i) =>
    outcome(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`),
  );

  it("takes roughly one corrected booking in ten", () => {
    const sample = auditSample(many);
    expect(sample.length).toBeGreaterThan(400 * 0.05);
    expect(sample.length).toBeLessThan(400 * 0.16);
  });

  /**
   * Stable, and not ours to choose. A `Math.random()` sample could be re-rolled
   * by anyone who disliked the week's agreement rate; hashing an id assigned
   * before the outcome existed cannot be steered toward the easy cases.
   */
  it("picks the same bookings every time it is run", () => {
    expect(auditSample(many)).toEqual(auditSample(many));
    expect(auditSample([...many].reverse()).map((o) => o.bookingId).sort()).toEqual(
      auditSample(many).map((o) => o.bookingId).sort(),
    );
  });

  it("only ever audits bookings that were actually corrected", () => {
    const clean = outcome(uuid(1), { correctedFields: {} });
    expect(auditSample([clean], 1)).toEqual([]);
    expect(auditSample([outcome(uuid(1))], 1)).toHaveLength(1);
  });

  it("publishes one rate, so the rate is a constant rather than a knob", () => {
    expect(AUDIT_SAMPLE_RATE).toBe(0.1);
  });

  it("records a human label without disturbing the model's, or the diff", async () => {
    const store = new InMemoryTriageStore([row(outcome(uuid(1)))]);
    await runTriage(deps(store, new FakeTriager([classified("enrichment")])));

    await store.recordHumanLabel({
      bookingId: uuid(1),
      observedAt: "2026-07-11T18:00:00.000Z",
      humanLabel: "agent_error",
      auditedBy: "nekha",
      auditedAt: "2026-07-13T09:00:00.000Z",
    });

    const [after] = store.outcomes;
    // Both labels survive: the disagreement *is* the thing we publish.
    expect(after!.classification).toBe("enrichment");
    expect(after!.humanLabel).toBe("agent_error");
    expect(after!.correctedFields).toEqual(MISHEARD);
  });

  it("refuses to label an outcome it does not have", async () => {
    const store = new InMemoryTriageStore([]);
    await expect(
      store.recordHumanLabel({
        bookingId: uuid(9),
        observedAt: "2026-07-11T18:00:00.000Z",
        humanLabel: "agent_error",
        auditedBy: "nekha",
        auditedAt: "2026-07-13T09:00:00.000Z",
      }),
    ).rejects.toThrow(/no outcome/);
  });
});
