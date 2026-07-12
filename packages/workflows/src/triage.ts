import {
  isCorrected,
  type AuditStore,
  type BookingOutcome,
  type ClassificationRecord,
  type Clock,
  type CorrectionTriager,
  type HumanLabelRecord,
  type OutcomeClassification,
  type PendingBookingPayload,
  type TriageCase,
  type TriageStore,
} from "@ledgerline/contracts";

/**
 * The four store types moved into `contracts` in Step 7, so `packages/db` can
 * implement them without depending on `workflows`. Re-exported from where they are
 * used — the same move `machine.ts` makes with `Effect`.
 */
export type { AuditStore, ClassificationRecord, HumanLabelRecord, TriageStore };

/**
 * Correction triage (plan, Step 6.1–6.3).
 *
 * `observeOutcome()` records *that* the contractor changed something. This asks
 * *why* — and the entire design of the file is an argument with itself about how
 * a model that grades our own homework could cheat, and what stops it:
 *
 *   1. **The raw diff is never written.** `TriageStore.classify` takes the derived
 *      columns and *only* the derived columns, so an edit that "cleans up" a diff
 *      the classifier disagrees with does not typecheck. This is the same move as
 *      `OutcomeDeps.crm = Pick<CrmAdapter, "readJob">`: the poller cannot repair
 *      what it measures, and the triager cannot rewrite what it judges.
 *   2. **Silence costs us.** A declined verdict, an outage, a batch that never ran
 *      — none of them writes anything, and `packages/telemetry` counts an
 *      unclassified correction as an agent error. Every failure mode of this file
 *      makes the published number *worse*, which is the only direction it is safe
 *      for a failure mode to point (cf. the missed webhook, plan §7).
 *   3. **A human checks 10% of it, weekly**, and we publish the agreement rate
 *      beside the correction rate. If they disagree more than ~5% of the time,
 *      `publishedCorrectionRate()` in `packages/telemetry` stops using the
 *      classifier at all.
 */

export interface TriageDeps {
  readonly triager: CorrectionTriager;
  readonly store: TriageStore;
  readonly clock: Clock;
  /** Recorded on every row as `classified_by`. */
  readonly model: string;
}

export interface TriageReport {
  readonly reviewed: number;
  readonly classified: number;
  /** The model looked and could not tell. Still counts against us. */
  readonly declined: number;
  /** The model could not be reached. Still counts against us. */
  readonly unavailable: number;
  /**
   * Rows the store offered that carried no correction at all. Never sent to the
   * model: asked why a booking nobody touched was changed, a model invents a
   * reason, and the reason lands in a column we publish from.
   */
  readonly skipped: number;
}

/** Default nightly batch size. A cap, not a target — the store decides what is due. */
export const TRIAGE_BATCH_LIMIT = 200;

/**
 * The nightly pass.
 *
 * An outage does not abort the batch: the remaining bookings are independent, and
 * a run that stops at the first `529` leaves a backlog that — by rule (2) above —
 * makes tonight's published number worse than it should be for no reason. It
 * reports what it could not do instead.
 */
export async function runTriage(
  deps: TriageDeps,
  options: { readonly limit?: number } = {},
): Promise<TriageReport> {
  const cases = await deps.store.pending(options.limit ?? TRIAGE_BATCH_LIMIT);

  let classified = 0;
  let declined = 0;
  let unavailable = 0;
  let skipped = 0;

  for (const triageCase of cases) {
    if (!isCorrected(triageCase.outcome)) {
      skipped += 1;
      continue;
    }

    const verdict = await deps.triager.classify(triageCase);
    switch (verdict.kind) {
      case "classified":
        await deps.store.classify({
          bookingId: triageCase.outcome.bookingId,
          observedAt: triageCase.outcome.observedAt,
          classification: verdict.classification,
          rationale: verdict.rationale,
          classifiedBy: deps.model,
          classifiedAt: deps.clock.now().toISOString(),
        });
        classified += 1;
        break;
      case "declined":
        declined += 1;
        break;
      case "unavailable":
        unavailable += 1;
        break;
    }
  }

  return { reviewed: cases.length, classified, declined, unavailable, skipped };
}

/* -------------------------------------------------------------------------- */
/* The weekly human audit (Step 6.3)                                           */
/* -------------------------------------------------------------------------- */

/** One in ten. The rate we publish the agreement over, so it is a constant, not a knob. */
export const AUDIT_SAMPLE_RATE = 0.1;

/**
 * Which corrections a human re-labels this week.
 *
 * **Chosen by hashing the booking id, not by rolling a die.** Two properties, and
 * both are about not being able to cheat:
 *
 * - It is *stable*. The same booking is in or out of the sample forever, so
 *   nobody can re-roll an audit whose result they disliked, and a re-run of the
 *   week's audit picks the same rows.
 * - It is *ours to check but not to choose*. The sample is a deterministic
 *   function of an id assigned before the outcome existed, so we cannot steer it
 *   toward the bookings the classifier found easy.
 *
 * A `Math.random()` sample would be neither, and nothing in this repo reads a
 * source of entropy it did not inject anyway.
 */
export function auditSample(
  outcomes: readonly BookingOutcome[],
  rate: number = AUDIT_SAMPLE_RATE,
): readonly BookingOutcome[] {
  return outcomes
    .filter(isCorrected)
    .filter((outcome) => bucket(outcome.bookingId) < rate);
}

/** A stable `[0, 1)` from an id. FNV-1a, then a division. */
function bucket(bookingId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bookingId.length; i++) {
    hash ^= bookingId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x100000000;
}

/* -------------------------------------------------------------------------- */
/* A store you can hold in your hand                                           */
/* -------------------------------------------------------------------------- */

/** One booking's evidence, as the store holds it. */
export interface TriageRow {
  readonly outcome: BookingOutcome;
  readonly booked: PendingBookingPayload;
}

/**
 * The test double for both ports. `PgTriageStore` (Step 7) is the one that ships, and
 * the same suite runs against both — a store that satisfies this contract in memory
 * and not in Postgres is a contract that was only ever describing the double.
 *
 * `classify` and `recordHumanLabel` write *new* outcome objects with the derived
 * column set. `correctedFields` is copied through untouched — which is not a
 * courtesy, it is the contract: the raw diff is retained forever so that anyone,
 * including someone who thinks we are lying, can recount from it.
 */
export class InMemoryTriageStore implements TriageStore, AuditStore {
  private readonly rows: TriageRow[];
  readonly classifications: ClassificationRecord[] = [];
  readonly humanLabels: HumanLabelRecord[] = [];

  constructor(rows: readonly TriageRow[] = []) {
    this.rows = [...rows];
  }

  /** Every outcome, with whatever labels have been written onto it. */
  get outcomes(): readonly BookingOutcome[] {
    return this.rows.map((row) => row.outcome);
  }

  async pending(limit: number): Promise<readonly TriageCase[]> {
    return this.rows
      .filter((row) => isCorrected(row.outcome) && row.outcome.classification === null)
      .slice(0, limit)
      .map((row) => ({ outcome: row.outcome, booked: row.booked }));
  }

  async classify(record: ClassificationRecord): Promise<void> {
    this.classifications.push(record);
    this.update(record.bookingId, record.observedAt, {
      classification: record.classification,
    });
  }

  async recordHumanLabel(record: HumanLabelRecord): Promise<void> {
    this.humanLabels.push(record);
    this.update(record.bookingId, record.observedAt, { humanLabel: record.humanLabel });
  }

  private update(
    bookingId: string,
    observedAt: string,
    derived: Partial<Pick<BookingOutcome, "classification" | "humanLabel">>,
  ): void {
    const index = this.rows.findIndex(
      (row) =>
        row.outcome.bookingId === bookingId && row.outcome.observedAt === observedAt,
    );
    if (index === -1) throw new Error(`no outcome for ${bookingId} at ${observedAt}`);

    const row = this.rows[index]!;
    // Spread, then set: the diff rides through by copy, and there is no expression
    // in this method that could overwrite it.
    this.rows[index] = { ...row, outcome: { ...row.outcome, ...derived } };
  }
}
