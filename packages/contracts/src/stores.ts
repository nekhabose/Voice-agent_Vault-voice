/**
 * The persistence ports.
 *
 * Every one of these was defined in the package that *consumes* it — `SnapshotStore`
 * and `TriageStore` in `workflows`, `FaqIndex` and `Embedder` in `faq` — which was
 * right for as long as the only implementations were in-memory doubles living beside
 * them. Step 7 gives them a database, and `packages/db` cannot implement a port it
 * would have to depend on `workflows` to see. So they move here, for exactly the
 * reason `Effect` moved here in Step 3 and `HttpTransport` in Step 4: **a port that
 * crosses a package boundary belongs in the spine.** The alternative — `db` →
 * `workflows` → `crm` — points the dependency graph backwards, and `db` has depended
 * on `contracts` alone since it was written.
 *
 * The in-memory implementations stay where they are. They are test doubles, not
 * contracts, and `packages/db` holds the Postgres ones.
 *
 * **Every store here is tenant-scoped by construction**, not by a `WHERE` clause
 * somebody remembers to write. `packages/db` builds them inside `withTenant()`, and
 * Postgres row-level security is the backstop underneath that — see `db/src/rls.sql`.
 * Two independent mechanisms, because one of them is a habit and habits lapse.
 */
import type { BookingOutcome, PendingBookingPayload } from "./booking.js";
import type { FaqEntry } from "./faq.js";
import type { TriageCase } from "./ports.js";
import type { OutcomeClassification } from "./booking.js";

/* -------------------------------------------------------------------------- */
/* Snapshots — the raw evidence (Step 2)                                       */
/* -------------------------------------------------------------------------- */

/** One row of `job_snapshots` (plan, §7). The vendor payload, verbatim. */
export interface JobSnapshotRecord {
  readonly bookingId: string;
  readonly polledAt: string;
  readonly payload: unknown;
}

/**
 * Where raw snapshots go, forever.
 *
 * Retained unclassified so that triage stays a *derived* column. A model asked
 * whether a contractor's edit was its own fault has an obvious bias, and the only
 * defence is that anyone can recount from the raw diff.
 */
export interface SnapshotStore {
  record(snapshot: JobSnapshotRecord): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Outcomes — the number itself                                                */
/* -------------------------------------------------------------------------- */

/**
 * Where `observeOutcome()`'s verdict lands.
 *
 * `record` takes a whole `BookingOutcome` — including `correctedFields` — because
 * this is the *only* port allowed to write the raw diff, and it writes it exactly
 * once, on the poll that observed it. Everything downstream (`TriageStore.classify`,
 * `AuditStore.recordHumanLabel`) is narrowed so that it structurally cannot touch
 * that column again.
 */
export interface OutcomeStore {
  record(outcome: BookingOutcome): Promise<void>;
  /** Every outcome observed at or after `since`. Feeds `computeMetrics()` and the invoice. */
  since(since: string): Promise<readonly BookingOutcome[]>;
}

/* -------------------------------------------------------------------------- */
/* Bookings — what the poller is owed                                          */
/* -------------------------------------------------------------------------- */

/** A committed booking the cron still owes a poll on. */
export interface DueBooking {
  readonly bookingId: string;
  readonly committedAt: string;
  /** How many of `POLL_OFFSETS_MS` have already run. Drives `nextDuePoll()`. */
  readonly completedPolls: number;
  /** What the call captured, to diff the CRM's copy against. */
  readonly booked: PendingBookingPayload;
  readonly crmJobId: string;
  readonly crmCustomerId: string;
}

/**
 * The cron's view of `bookings` (plan, §7).
 *
 * `completedPolls` is a counter rather than a timestamp because **a cron that missed
 * its window still owes the poll it missed.** A poller keyed on "is it 24h since
 * commit" silently skips every booking it was down for, and a booking never polled is
 * a correction never counted — which reports a *better* number than the truth, the
 * failure mode this whole subsystem exists to refuse (plan, §7).
 *
 * The *schedule* is not in here on purpose. `POLL_OFFSETS_MS` and `nextDuePoll()` are
 * `packages/workflows`' policy, and a store that knew them would put a product decision
 * — when a correction is likely to land — inside a SQL file. So this port answers the
 * storage question ("which bookings still owe a poll, and were committed long enough
 * ago to possibly be due") and the caller answers the policy one.
 */
export interface BookingStore {
  /**
   * Committed bookings that have run fewer than `maxPolls` polls and were committed at
   * or before `committedBefore` — the caller's earliest possible due time. Oldest
   * commit first, so a backlog drains in the order it accrued.
   */
  unfinished(
    committedBefore: Date,
    maxPolls: number,
    limit: number,
  ): Promise<readonly DueBooking[]>;
  /**
   * One poll ran and *succeeded*. Only ever called after the outcome is recorded:
   * incrementing on a failed read would consume the poll the cron still owes, and an
   * unobserved correction is one we would never report.
   */
  recordPoll(bookingId: string): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Triage — the derived columns, and only those (Step 6)                       */
/* -------------------------------------------------------------------------- */

/** One row of the derived columns. Never a diff, never a `correctedFields`. */
export interface ClassificationRecord {
  readonly bookingId: string;
  /** Identifies *which* observation is being labeled: a booking has up to three. */
  readonly observedAt: string;
  readonly classification: OutcomeClassification;
  /** What the auditor reads before agreeing or disagreeing. Never empty. */
  readonly rationale: string;
  /** The model id. A label is only as good as the thing that produced it. */
  readonly classifiedBy: string;
  readonly classifiedAt: string;
}

/** The weekly 10% audit (Step 6.3). Written by a person, and it overrides the model. */
export interface HumanLabelRecord {
  readonly bookingId: string;
  readonly observedAt: string;
  readonly humanLabel: OutcomeClassification;
  readonly auditedBy: string;
  readonly auditedAt: string;
}

/**
 * What the nightly pass reads and writes.
 *
 * `classify` cannot express an edit to `correctedFields`, and that is the type system
 * carrying Step 6.2 rather than a comment asking nicely. The Postgres implementation
 * keeps the guarantee: its `UPDATE` names the derived columns and the raw diff is not
 * among them.
 */
export interface TriageStore {
  /** Corrected bookings with no classification yet, oldest first. */
  pending(limit: number): Promise<readonly TriageCase[]>;
  classify(record: ClassificationRecord): Promise<void>;
}

/** Deliberately a separate port: the nightly model pass must not hold this one. */
export interface AuditStore {
  recordHumanLabel(record: HumanLabelRecord): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* FAQ retrieval (Step 6.4, given a database in Step 7)                        */
/* -------------------------------------------------------------------------- */

/** An entry with the vector `pgvector` searches on. */
export interface IndexedFaqEntry extends FaqEntry {
  /** Exactly `FAQ_EMBEDDING_DIMENSIONS` numbers. See `contracts/faq.ts`. */
  readonly embedding: readonly number[];
}

export interface RetrievedFaqEntry {
  readonly entry: FaqEntry;
  /** Cosine similarity, `-1..1`. Higher is closer. */
  readonly score: number;
}

/**
 * Turns a caller's question into a vector.
 *
 * **Nothing in this repo binds a real one.** Anthropic has no embeddings endpoint,
 * and picking a vendor without a credential to test against would be guessing at a
 * wire format. `HashingEmbedder` is what the tests use; the production binding is
 * task 6.6, and it needs a key rather than a database — which is why Step 7 could
 * ship `PgVectorFaqIndex` and could not ship this.
 */
export interface Embedder {
  embed(text: string): Promise<readonly number[]>;
}

/**
 * Vector search over one tenant's FAQ.
 *
 * **Tenant-scoped in the signature rather than in a `WHERE` clause somebody remembers
 * to write**: an FAQ answer leaking across tenants speaks one contractor's prices to
 * another's caller. `PgVectorFaqIndex` passes the id *and* runs under RLS, so the
 * argument is checked twice by two mechanisms that fail independently.
 */
export interface FaqIndex {
  search(
    tenantId: string,
    embedding: readonly number[],
    limit: number,
  ): Promise<readonly RetrievedFaqEntry[]>;
}
