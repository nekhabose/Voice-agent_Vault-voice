import {
  BookingOutcomeSchema,
  CohortStatsSchema,
  FAQ_EMBEDDING_DIMENSIONS,
  PendingBookingPayloadSchema,
  ReliabilityReportSchema,
  type AuditStore,
  type BookingOutcome,
  type BookingStore,
  type ClassificationRecord,
  type CohortReader,
  type CohortStats,
  type DueBooking,
  type ExpiredRecording,
  type FaqIndex,
  type HumanLabelRecord,
  type IndexedFaqEntry,
  type JobSnapshotRecord,
  type OutcomeStore,
  type ReliabilityReport,
  type ReportStore,
  type RetentionStore,
  type RetrievedFaqEntry,
  type SnapshotStore,
  type TriageCase,
  type TriageStore,
} from "@ledgerline/contracts";
import { and, asc, desc, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Queryable } from "./client.js";
import {
  bookings,
  callTurns,
  calls,
  faqEntries,
  jobSnapshots,
  outcomes,
  pendingBookings,
  reliabilityReports,
} from "./schema.js";

/**
 * The Postgres implementations of the ports every earlier Step left with an in-memory
 * double and a note saying "the real one is Step 7's".
 *
 * **Every store is constructed for one tenant, and takes a handle that is already
 * inside `withTenant()`.** That is the belt. Row-level security is the braces: the same
 * queries, run with the wrong tenant id, return nothing and write nothing (`rls.test.ts`).
 * Two mechanisms rather than one, because the belt is a habit and habits lapse — a
 * missing `WHERE tenant_id` is one distracted afternoon away, and its consequence is a
 * plumber reading another plumber's calls.
 *
 * The suite that proves these is the same suite that proves the in-memory doubles, run
 * twice — `packages/crm`'s move, where one contract suite runs against Housecall Pro and
 * Jobber. A port only one implementation satisfies is a description of that
 * implementation.
 */

/* -------------------------------------------------------------------------- */
/* Snapshots                                                                   */
/* -------------------------------------------------------------------------- */

/** Append-only, and not merely by convention: the app role has no DELETE here. */
export class PgSnapshotStore implements SnapshotStore {
  constructor(
    private readonly db: Queryable,
    private readonly tenantId: string,
  ) {}

  async record(snapshot: JobSnapshotRecord): Promise<void> {
    await this.db.insert(jobSnapshots).values({
      bookingId: snapshot.bookingId,
      tenantId: this.tenantId,
      polledAt: new Date(snapshot.polledAt),
      payload: snapshot.payload,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Outcomes — the only place the raw diff is ever written                      */
/* -------------------------------------------------------------------------- */

export class PgOutcomeStore implements OutcomeStore {
  constructor(
    private readonly db: Queryable,
    private readonly tenantId: string,
  ) {}

  /**
   * Idempotent on `(booking_id, observed_at)`.
   *
   * A cron retried after a timeout must not write the same observation twice: three
   * polls per booking already means `computeMetrics()` counts distinct bookings rather
   * than rows (Step 2, surprise #5), and a duplicate row would still corrupt the
   * `triageAgreementRate` denominator. `DO NOTHING` rather than `DO UPDATE` because an
   * observation is a fact about a moment, and a second look at that same moment cannot
   * have seen anything new.
   */
  async record(outcome: BookingOutcome): Promise<void> {
    await this.db
      .insert(outcomes)
      .values({
        bookingId: outcome.bookingId,
        tenantId: this.tenantId,
        cancelled: outcome.cancelled,
        correctedFields: outcome.correctedFields,
        source: outcome.source,
        classification: outcome.classification,
        humanLabel: outcome.humanLabel,
        observedAt: new Date(outcome.observedAt),
      })
      .onConflictDoNothing({
        target: [outcomes.bookingId, outcomes.observedAt],
      });
  }

  async since(since: string): Promise<readonly BookingOutcome[]> {
    const rows = await this.db
      .select()
      .from(outcomes)
      .where(gte(outcomes.observedAt, new Date(since)))
      .orderBy(asc(outcomes.observedAt));

    return rows.map(toBookingOutcome);
  }
}

/* -------------------------------------------------------------------------- */
/* Bookings — what the poller still owes                                       */
/* -------------------------------------------------------------------------- */

export class PgBookingStore implements BookingStore {
  constructor(
    private readonly db: Queryable,
    private readonly tenantId: string,
  ) {}

  async unfinished(
    committedBefore: Date,
    maxPolls: number,
    limit: number,
  ): Promise<readonly DueBooking[]> {
    const rows = await this.db
      .select({
        bookingId: bookings.id,
        committedAt: bookings.committedAt,
        completedPolls: bookings.completedPolls,
        crmJobId: bookings.crmJobId,
        crmCustomerId: bookings.crmCustomerId,
        payload: pendingBookings.payload,
      })
      .from(bookings)
      .innerJoin(pendingBookings, eq(bookings.pendingBookingId, pendingBookings.id))
      .where(
        and(
          lt(bookings.completedPolls, maxPolls),
          // `<=` is deliberate: a booking committed exactly one offset ago is due.
          sql`${bookings.committedAt} <= ${committedBefore}`,
        ),
      )
      .orderBy(asc(bookings.committedAt))
      .limit(limit);

    return rows.map((row) => ({
      bookingId: row.bookingId,
      committedAt: row.committedAt.toISOString(),
      completedPolls: row.completedPolls,
      crmJobId: row.crmJobId,
      crmCustomerId: row.crmCustomerId,
      // Parsed, not cast. The payload is `jsonb`, and a booking written by an older
      // deploy is exactly the drift `contracts` exists to catch.
      booked: PendingBookingPayloadSchema.parse(row.payload),
    }));
  }

  /**
   * `completed_polls = completed_polls + 1`, read-modify-write inside the database.
   *
   * Not `SET completed_polls = ${n + 1}` from a value the caller read a moment ago: two
   * cron invocations overlapping — a slow run and its retry — would both read 0 and
   * both write 1, and the booking would be polled twice at 24h and never at 72h. The
   * increment is relative, so the database serializes it.
   */
  async recordPoll(bookingId: string): Promise<void> {
    await this.db
      .update(bookings)
      .set({ completedPolls: sql`${bookings.completedPolls} + 1` })
      .where(eq(bookings.id, bookingId));
  }
}

/* -------------------------------------------------------------------------- */
/* Triage — the derived columns, and the database agrees                       */
/* -------------------------------------------------------------------------- */

export class PgTriageStore implements TriageStore, AuditStore {
  constructor(
    private readonly db: Queryable,
    private readonly tenantId: string,
  ) {}

  /**
   * Corrected, unclassified, oldest first.
   *
   * `isCorrected()` in `contracts` is `cancelled || correctedFields non-empty`, and this
   * `WHERE` is that predicate in SQL. They must not disagree: `telemetry` puts exactly
   * these bookings in the numerator of `correctionRate`, and a store that offered the
   * model a booking nobody touched would get back an invented reason for a change that
   * never happened — in a column we publish from. `stores.test.ts` runs both over the
   * same rows.
   */
  async pending(limit: number): Promise<readonly TriageCase[]> {
    const rows = await this.db
      .select({ outcome: outcomes, payload: pendingBookings.payload })
      .from(outcomes)
      .innerJoin(bookings, eq(outcomes.bookingId, bookings.id))
      .innerJoin(pendingBookings, eq(bookings.pendingBookingId, pendingBookings.id))
      .where(
        and(
          sql`${outcomes.classification} IS NULL`,
          sql`(${outcomes.cancelled} OR ${outcomes.correctedFields} <> '{}'::jsonb)`,
        ),
      )
      .orderBy(asc(outcomes.observedAt))
      .limit(limit);

    return rows.map((row) => ({
      outcome: toBookingOutcome(row.outcome),
      booked: PendingBookingPayloadSchema.parse(row.payload),
    }));
  }

  /**
   * The `SET` clause names the derived columns, and `corrected_fields` is not among
   * them — the same guarantee `TriageStore.classify`'s *type* already makes (Step 6.2).
   *
   * It is worth having twice. The type stops a `classify()` that tries; the grant in
   * migration 0002 stops a raw `db.execute()` that never went near the port. A model
   * grading our own homework must not be able to erase the homework, and one mechanism
   * guarding that is one mechanism away from none.
   */
  async classify(record: ClassificationRecord): Promise<void> {
    await this.db
      .update(outcomes)
      .set({
        classification: record.classification,
        classificationRationale: record.rationale,
        classifiedBy: record.classifiedBy,
        classifiedAt: new Date(record.classifiedAt),
      })
      .where(observation(record.bookingId, record.observedAt));
  }

  async recordHumanLabel(record: HumanLabelRecord): Promise<void> {
    await this.db
      .update(outcomes)
      .set({
        humanLabel: record.humanLabel,
        auditedBy: record.auditedBy,
        auditedAt: new Date(record.auditedAt),
      })
      .where(observation(record.bookingId, record.observedAt));
  }
}

/** A booking has up to three observations. Both records name one of them. */
const observation = (bookingId: string, observedAt: string) =>
  and(eq(outcomes.bookingId, bookingId), eq(outcomes.observedAt, new Date(observedAt)));

/* -------------------------------------------------------------------------- */
/* FAQ retrieval — pgvector at last (Step 6.4's deferred half)                 */
/* -------------------------------------------------------------------------- */

/**
 * The `pgvector` implementation of `FaqIndex`.
 *
 * `InMemoryFaqIndex` brute-forces cosine over the same vectors, which is what the HNSW
 * index approximates, so the *answerer* above it was already exercised for real (Step
 * 6.4). What was never exercised is the SQL: the `<=>` operator, the `vector_cosine_ops`
 * index, and — the part that matters — whether one tenant's answers can reach another
 * tenant's caller. `stores.test.ts` asks this index for a rival's entries from inside
 * the wrong tenant's transaction, and gets nothing.
 *
 * **The embedder is still not real.** `HashingEmbedder` has no semantics, so
 * `SIMILARITY_FLOOR` remains calibrated against nothing and this index remains untuned.
 * That is task 6.6, and it needs an embedding *credential*, not a database — which is
 * exactly why Step 7 could ship this half and not that one.
 */
export class PgVectorFaqIndex implements FaqIndex {
  constructor(private readonly db: Queryable) {}

  async search(
    tenantId: string,
    embedding: readonly number[],
    limit: number,
  ): Promise<readonly RetrievedFaqEntry[]> {
    const query = toVector(embedding);

    const rows = await this.db
      .select({
        id: faqEntries.id,
        tenantId: faqEntries.tenantId,
        question: faqEntries.question,
        answer: faqEntries.answer,
        // `<=>` is cosine *distance*; the port's contract is cosine *similarity*, and
        // `InMemoryFaqIndex.cosine()` returns the latter. `SIMILARITY_FLOOR` compares
        // against one of them, and getting this backwards would silently invert the
        // ranking — the agent answering the least relevant question it could find.
        score: sql<number>`1 - (${faqEntries.embedding} <=> ${query}::vector)`.as("score"),
      })
      .from(faqEntries)
      .where(eq(faqEntries.tenantId, tenantId))
      .orderBy(sql`${faqEntries.embedding} <=> ${query}::vector`)
      .limit(limit);

    return rows.map(({ score, ...entry }) => ({ entry, score: Number(score) }));
  }
}

/** Writes the contractor's own answers. Onboarding's, not the call path's. */
export class PgFaqStore {
  constructor(
    private readonly db: Queryable,
    private readonly tenantId: string,
  ) {}

  async upsert(entry: IndexedFaqEntry): Promise<void> {
    if (entry.embedding.length !== FAQ_EMBEDDING_DIMENSIONS) {
      // The dimension mismatch `pgvector` rejects at insert time, raised where the
      // embedder was called rather than where the query runs.
      throw new Error(
        `FAQ entry ${entry.id}: ${entry.embedding.length}-dimension embedding, expected ${FAQ_EMBEDDING_DIMENSIONS}`,
      );
    }

    await this.db
      .insert(faqEntries)
      .values({
        id: entry.id,
        tenantId: this.tenantId,
        question: entry.question,
        answer: entry.answer,
        embedding: [...entry.embedding],
      })
      .onConflictDoUpdate({
        target: faqEntries.id,
        set: {
          question: entry.question,
          answer: entry.answer,
          embedding: [...entry.embedding],
          updatedAt: new Date(),
        },
      });
  }
}

/** pgvector's literal is `[1,0,...]`, and it is a bind parameter, never interpolated. */
const toVector = (embedding: readonly number[]): string => `[${embedding.join(",")}]`;

/* -------------------------------------------------------------------------- */
/* Retention — what we promised to forget (Step 8)                             */
/* -------------------------------------------------------------------------- */

/**
 * The deletion job's view of `calls`.
 *
 * **Every method here is an `UPDATE`, and there is no `DELETE` in the class.** Not
 * because we forgot one: the app role holds no `DELETE` privilege on `calls` or
 * `call_turns` at all (migration `0002` — "a call is evidence"), so a `delete()` here
 * would compile, ship, and be refused by Postgres in production. Retention therefore
 * *redacts*: the row survives, the metrics survive, and the words do not.
 *
 * The queries are `IS NULL`-guarded on the tombstones rather than on `recording_url`,
 * which is what makes the job re-entrant. A run that deleted the media and crashed
 * before writing the tombstone leaves the call in the working set, the second attempt
 * gets `already_absent` from the archive, and the tombstone lands. A job keyed on "has
 * a URL" would instead treat a successful deletion as unfinished work forever.
 */
export class PgRetentionStore implements RetentionStore {
  constructor(
    private readonly db: Queryable,
    private readonly tenantId: string,
  ) {}

  async expiredRecordings(before: Date, limit: number): Promise<readonly ExpiredRecording[]> {
    const rows = await this.db
      .select({ callId: calls.id, recordingUrl: calls.recordingUrl })
      .from(calls)
      .where(
        and(
          eq(calls.tenantId, this.tenantId),
          lt(calls.startedAt, before),
          isNotNull(calls.recordingUrl),
          isNull(calls.recordingDeletedAt),
        ),
      )
      .orderBy(asc(calls.startedAt))
      .limit(limit);

    // `isNotNull` above already established this; the narrowing is for the compiler,
    // which cannot read a `WHERE` clause.
    return rows.flatMap((row) =>
      row.recordingUrl === null ? [] : [{ callId: row.callId, recordingUrl: row.recordingUrl }],
    );
  }

  /**
   * The media is gone from the vendor. Record *both* facts: the URL no longer points at
   * anything, and the reason it does not is that we deleted it on this date.
   */
  async markRecordingDeleted(callId: string, at: Date): Promise<void> {
    await this.db
      .update(calls)
      .set({ recordingUrl: null, recordingDeletedAt: at })
      .where(and(eq(calls.id, callId), eq(calls.tenantId, this.tenantId)));
  }

  async expiredTranscripts(before: Date, limit: number): Promise<readonly string[]> {
    const rows = await this.db
      .select({ callId: calls.id })
      .from(calls)
      .where(
        and(
          eq(calls.tenantId, this.tenantId),
          lt(calls.startedAt, before),
          isNull(calls.transcriptRedactedAt),
        ),
      )
      .orderBy(asc(calls.startedAt))
      .limit(limit);

    return rows.map((row) => row.callId);
  }

  /**
   * The words, blanked. The numbers, untouched.
   *
   * `text = ''` rather than a `DELETE` of the turn rows — which we could not do anyway
   * — and that constraint turned out to be the right design. `first_word_latency_ms`,
   * `barge_in`, and `turn_take_ok` are what `computeMetrics()` reads; none of them is
   * the caller's words. So the reliability numbers this company exists to publish can
   * still be recomputed, from scratch, over a database that has forgotten every caller
   * who ever phoned. A retention policy that cost us the measurement would be a policy
   * somebody would eventually argue their way out of.
   */
  async redactTranscript(callId: string, at: Date): Promise<void> {
    await this.db
      .update(callTurns)
      .set({ text: "" })
      .where(and(eq(callTurns.callId, callId), eq(callTurns.tenantId, this.tenantId)));

    await this.db
      .update(calls)
      .set({ transcriptRedactedAt: at, transcriptUrl: null })
      .where(and(eq(calls.id, callId), eq(calls.tenantId, this.tenantId)));
  }
}

/* -------------------------------------------------------------------------- */
/* Publication — the only read in this file that is not one tenant's (Step 9)  */
/* -------------------------------------------------------------------------- */

/**
 * The cross-tenant cohort.
 *
 * **This is the only class in this package with no `tenantId` in its constructor**, and it
 * is not an oversight — it is the design, in the one place the design is hardest. Every
 * other store here is built inside `withTenant()` and reads one contractor's rows; the
 * number we publish is an aggregate over all of them, and there is no tenant to scope it to.
 *
 * The tempting implementations are both wrong, and each is wrong in a way that would have
 * shipped:
 *
 *  1. **Connect as the owner and count.** Postgres exempts the owner from RLS, so this
 *     works immediately, passes every test, and makes the one figure we publish to the
 *     world the one computed by the only connection in the system with no isolation
 *     (principle #6, and the passing bypass test in `rls.test.ts` that exists to warn you).
 *  2. **Loop `withTenant()` over every tenant and add up the results.** Which requires a
 *     list of tenants, which is a list somebody can shorten. Cherry-picking the customers
 *     who make us look good is the most obvious way to cheat at this and the easiest to
 *     hide — and `CohortReader.cohort()` deliberately has no parameter that could express it.
 *
 * So the aggregate is a `SECURITY DEFINER` function (migration `0004`) that sees every
 * tenant's rows and **can only return counts**. The app role calls it *unscoped* — no GUC,
 * no `withTenant` — and still cannot read a single row of anyone's data. The return type is
 * the guarantee, exactly as `Pick<CrmAdapter, "readJob">` is.
 */
export class PgCohortReader implements CohortReader {
  constructor(private readonly db: Queryable) {}

  async cohort(
    windowStart: Date,
    windowEnd: Date,
    requiredPolls: number,
  ): Promise<CohortStats> {
    const result = await this.db.execute(
      sql`SELECT * FROM app_reliability_cohort(${windowStart.toISOString()}::timestamptz, ${windowEnd.toISOString()}::timestamptz, ${requiredPolls}::integer)`,
    );

    const row = (result as unknown as { rows: readonly Record<string, unknown>[] }).rows[0];
    if (row === undefined) {
      // The function is `RETURNS TABLE` over aggregates, so it always yields exactly one
      // row — even over an empty database. No row at all means the function is not the one
      // we think it is, and a cohort silently defaulted to zeros would publish a *flawless*
      // correction rate over no data. Throw rather than invent.
      throw new Error("app_reliability_cohort returned no row");
    }

    // Postgres `bigint` arrives as a string over the wire (it does not fit a JS number
    // safely, and the driver refuses to guess). `Number()` is right here and would not be
    // for an id: these are counts of calls and bookings, orders of magnitude below 2^53.
    const count = (value: unknown): number => Number(value ?? 0);

    return CohortStatsSchema.parse({
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      tenants: count(row["tenants"]),
      calls: count(row["calls"]),
      committedBookings: count(row["committed_bookings"]),
      immatureBookings: count(row["immature_bookings"]),
      correctedBookings: count(row["corrected_bookings"]),
      agentErrorBookings: count(row["agent_error_bookings"]),
      auditedOutcomes: count(row["audited_outcomes"]),
      agreedOutcomes: count(row["agreed_outcomes"]),
      worstTenantCorrectionRate: count(row["worst_tenant_correction_rate"]),
      worstTenantBookings: count(row["worst_tenant_bookings"]),
    });
  }
}

/**
 * Where published figures go, and stay.
 *
 * No `update`, no `delete` — not in the port, and not in the grant (`0004` gives the app
 * role `SELECT` and `INSERT` on this table and nothing else). The two mechanisms are the
 * same pair that make `outcomes.corrected_fields` unrewritable, and they are here for the
 * same reason: **a reliability figure a vendor can retract is a marketing claim with a
 * database behind it.**
 */
export class PgReportStore implements ReportStore {
  constructor(private readonly db: Queryable) {}

  /**
   * Idempotent on `(window_start, window_end, methodology_version)`.
   *
   * An append-only table written by a cron needs this: a retried invocation must not stack
   * two figures for the same quarter, and with no `UPDATE` and no `DELETE` grant, a
   * duplicate could never be cleaned up afterwards. `DO NOTHING` rather than `DO UPDATE`,
   * because the first computation of a window is the one that was published — recomputing
   * it later and quietly overwriting is the retraction this table exists to prevent.
   */
  async publish(report: ReliabilityReport): Promise<void> {
    await this.db
      .insert(reliabilityReports)
      .values({
        id: report.id,
        methodologyVersion: report.methodologyVersion,
        windowStart: new Date(report.windowStart),
        windowEnd: new Date(report.windowEnd),
        publishedAt: new Date(report.publishedAt),
        tenants: report.tenants,
        calls: report.calls,
        committedBookings: report.committedBookings,
        correctionRate: report.correctionRate,
        correctionRateLow: report.correctionRateLow,
        correctionRateHigh: report.correctionRateHigh,
        agentErrorRate: report.agentErrorRate,
        publishedRate: report.publishedRate,
        publishedBasis: report.publishedBasis,
        publishedReason: report.publishedReason,
        auditedOutcomes: report.auditedOutcomes,
        triageAgreementRate: report.triageAgreementRate,
        worstTenantCorrectionRate: report.worstTenantCorrectionRate,
        worstTenantBookings: report.worstTenantBookings,
        observedCoverage: report.observedCoverage,
      })
      .onConflictDoNothing({
        target: [
          reliabilityReports.windowStart,
          reliabilityReports.windowEnd,
          reliabilityReports.methodologyVersion,
        ],
      });
  }

  /** Newest first. The gaps are visible on purpose — see `reliability_reports` in `schema.ts`. */
  async history(limit: number): Promise<readonly ReliabilityReport[]> {
    const rows = await this.db
      .select()
      .from(reliabilityReports)
      .orderBy(desc(reliabilityReports.windowEnd))
      .limit(limit);

    return rows.map((row) =>
      ReliabilityReportSchema.parse({
        id: row.id,
        methodologyVersion: row.methodologyVersion,
        windowStart: row.windowStart.toISOString(),
        windowEnd: row.windowEnd.toISOString(),
        publishedAt: row.publishedAt.toISOString(),
        tenants: row.tenants,
        calls: row.calls,
        committedBookings: row.committedBookings,
        correctionRate: row.correctionRate,
        correctionRateLow: row.correctionRateLow,
        correctionRateHigh: row.correctionRateHigh,
        agentErrorRate: row.agentErrorRate,
        publishedRate: row.publishedRate,
        publishedBasis: row.publishedBasis,
        publishedReason: row.publishedReason,
        auditedOutcomes: row.auditedOutcomes,
        triageAgreementRate: row.triageAgreementRate,
        worstTenantCorrectionRate: row.worstTenantCorrectionRate,
        worstTenantBookings: row.worstTenantBookings,
        observedCoverage: row.observedCoverage,
      }),
    );
  }
}

/* -------------------------------------------------------------------------- */

/** A row, back through the contract that defines what an outcome is. */
function toBookingOutcome(row: typeof outcomes.$inferSelect): BookingOutcome {
  return BookingOutcomeSchema.parse({
    bookingId: row.bookingId,
    cancelled: row.cancelled,
    correctedFields: row.correctedFields,
    source: row.source,
    classification: row.classification,
    humanLabel: row.humanLabel,
    observedAt: row.observedAt.toISOString(),
  });
}
