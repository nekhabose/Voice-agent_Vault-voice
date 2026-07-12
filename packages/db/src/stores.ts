import {
  BookingOutcomeSchema,
  FAQ_EMBEDDING_DIMENSIONS,
  PendingBookingPayloadSchema,
  type AuditStore,
  type BookingOutcome,
  type BookingStore,
  type ClassificationRecord,
  type DueBooking,
  type FaqIndex,
  type HumanLabelRecord,
  type IndexedFaqEntry,
  type JobSnapshotRecord,
  type OutcomeStore,
  type RetrievedFaqEntry,
  type SnapshotStore,
  type TriageCase,
  type TriageStore,
} from "@ledgerline/contracts";
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import type { Queryable } from "./client.js";
import {
  bookings,
  faqEntries,
  jobSnapshots,
  outcomes,
  pendingBookings,
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
