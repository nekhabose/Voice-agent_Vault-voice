import {
  BookingStatusSchema,
  CallOutcomeSchema,
  CallStateSchema,
  EscalationReasonSchema,
  FAQ_EMBEDDING_DIMENSIONS,
  LocaleSchema,
  OutcomeClassificationSchema,
  OutcomeSourceSchema,
  PublicationBasisSchema,
  SLOT_KEYS,
  UrgencySchema,
} from "@ledgerline/contracts";
import {
  boolean,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/**
 * The data model from plan.md §7.
 *
 * **Every enum here is spread from a Zod schema in `@ledgerline/contracts`, not
 * retyped.** `contracts` is the spine, and a hand-written `pgEnum` that says
 * `'SOON'` while `UrgencySchema` has moved on is a silent production bug of
 * exactly the kind defining these shapes once is supposed to eliminate. Adding a
 * variant to a contract enum and forgetting the migration now fails at
 * `drizzle-kit generate`, not at 2am.
 *
 * Four columns make principles #3 and #5 real, and without them we would be
 * asserting reliability rather than measuring it:
 *
 *   - `slots.confirmed_by_caller` — the read-back actually happened.
 *   - `outcomes.corrected_fields` — ground truth. The raw diff.
 *   - `outcomes.classification`   — was the edit ours, a business change, or an
 *     enrichment? Written by Step 6's nightly pass. **Never destructive.**
 *   - `outcomes.human_label`      — the weekly 10% audit, published beside the
 *     correction rate. An unaudited classifier grading our own homework is
 *     marketing with extra steps.
 *
 * ## Tenancy (Step 7)
 *
 * **Every tenant-scoped table carries `tenant_id` directly, and Postgres enforces
 * that the copy agrees with its parent.** Row-level security policies are the
 * isolation mechanism (`rls.sql`), and a policy is a `USING` clause evaluated per
 * row: it can afford `tenant_id = current_tenant()` and it cannot afford
 * `EXISTS (SELECT ... JOIN ... JOIN ...)` three levels up to `outcomes`' owning
 * tenant. So `tenant_id` is denormalized onto `call_turns`, `slots`, `escalations`,
 * `bookings`, `job_snapshots`, and `outcomes`.
 *
 * Denormalized data can disagree with its source, and a row whose `tenant_id` says
 * one thing while its parent call says another is a row RLS shows to the wrong
 * contractor. So it is not allowed to disagree: each child declares a **composite
 * foreign key** on `(parent_id, tenant_id)`, and each parent a matching unique
 * constraint. An insert that files a call turn under the wrong tenant does not fail a
 * review — it fails the database. That is `TriageStore.classify`'s move (a guarantee
 * the type system carries) done in DDL.
 */

/** `z.enum(...).options` is a readonly tuple; pgEnum wants a mutable one. */
const variants = <T extends string>(options: readonly [T, ...T[]]): [T, ...T[]] => [
  ...options,
];

export const localeEnum = pgEnum("locale", variants(LocaleSchema.options));
export const urgencyEnum = pgEnum("urgency", variants(UrgencySchema.options));
export const callStateEnum = pgEnum("call_state", variants(CallStateSchema.options));
export const callOutcomeEnum = pgEnum("call_outcome", variants(CallOutcomeSchema.options));
export const slotKeyEnum = pgEnum("slot_key", variants(SLOT_KEYS));
export const bookingStatusEnum = pgEnum("booking_status", variants(BookingStatusSchema.options));
export const outcomeSourceEnum = pgEnum("outcome_source", variants(OutcomeSourceSchema.options));
export const outcomeClassificationEnum = pgEnum(
  "outcome_classification",
  variants(OutcomeClassificationSchema.options),
);
export const escalationReasonEnum = pgEnum(
  "escalation_reason",
  variants(EscalationReasonSchema.options),
);
export const crmProviderEnum = pgEnum("crm_provider", ["housecall_pro", "jobber"]);
export const publicationBasisEnum = pgEnum(
  "publication_basis",
  variants(PublicationBasisSchema.options),
);

/* -------------------------------------------------------------------------- */
/* Tenant configuration                                                        */
/* -------------------------------------------------------------------------- */

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** IANA zone. Every appointment window is rendered through it. */
  timezone: text("timezone").notNull(),
  trade: text("trade").notNull(),
  crmProvider: crmProviderEnum("crm_provider").notNull(),
  /** Encrypted at the application boundary. Never selected into a log line. */
  crmCredentials: text("crm_credentials_enc").notNull(),
  /**
   * USPS code of the contractor's own state — the one end of a call whose location we
   * actually know (`packages/compliance`, `assessConsent`).
   *
   * `XX` is not a state, and that is the default on purpose: an unconfigured tenant
   * resolves to `UNKNOWN`, which is the all-party branch, which means notice before
   * recording. **A `NOT NULL DEFAULT` that fails safe is the cheapest compliance
   * control in this file**, because it is the one that applies to the rows nobody
   * remembered to fill in.
   */
  stateCode: text("state_code").notNull().default("XX"),
  /** Off until the contractor turns it on. An unfinished onboarding records nobody. */
  recordingEnabled: boolean("recording_enabled").notNull().default(false),
  /**
   * The DPA version this contractor accepted (`compliance/src/dpa.ts`), or null.
   *
   * A version rather than a boolean, because what somebody agreed to is a document with
   * contents — and a *stale* acceptance stops recording just as a missing one does
   * (`recordingDecision`). Bumping `DPA_VERSION` therefore costs us recordings until
   * every tenant re-accepts, which is what makes the bump a thing somebody reads.
   */
  dpaVersion: text("dpa_version"),
  dpaAcceptedAt: timestamp("dpa_accepted_at", { withTimezone: true }),
  dpaAcceptedBy: text("dpa_accepted_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const phoneNumbers = pgTable(
  "phone_numbers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    e164: text("e164").notNull(),
    twilioSid: text("twilio_sid").notNull(),
  },
  (table) => [uniqueIndex("phone_numbers_e164_key").on(table.e164)],
);

/** "Do we even serve this address." GeoJSON polygon, checked before booking. */
export const serviceAreas = pgTable("service_areas", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  geojsonPolygon: jsonb("geojson_polygon").notNull(),
});

export const businessHours = pgTable(
  "business_hours",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** 0 = Sunday, matching `Date.prototype.getDay`. */
    dow: smallint("dow").notNull(),
    /** Local wall clock, `HH:MM`. Resolved against `tenants.timezone`. */
    open: text("open").notNull(),
    close: text("close").notNull(),
    emergencyAfterHours: boolean("emergency_after_hours").notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.dow] })],
);

export const jobTypes = pgTable("job_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  name: text("name").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  requiresPhoto: boolean("requires_photo").notNull().default(false),
  emergencyEligible: boolean("emergency_eligible").notNull().default(false),
});

/* -------------------------------------------------------------------------- */
/* Calls                                                                       */
/* -------------------------------------------------------------------------- */

export const calls = pgTable(
  "calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    fromE164: text("from_e164").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    localesDetected: localeEnum("locales_detected").array().notNull().default([]),
    /** Null while the call is still in flight. Such calls are never scored. */
    outcome: callOutcomeEnum("outcome"),
    /** Booked with no human involvement. Derived, never hand-set. */
    containment: boolean("containment").notNull().default(false),
    recordingUrl: text("recording_url"),
    transcriptUrl: text("transcript_url"),
    /**
     * The retention tombstones (Step 8). **Facts, not absences.**
     *
     * A null `recording_url` could mean the call was never recorded, that the carrier
     * lost it, or that we deleted it as promised — three very different sentences, and
     * a deletion policy whose evidence is a *missing value* can prove none of them.
     * Same reasoning as "absence is never a correction" (principle #5): what a system
     * failed to say is not a claim about the world.
     *
     * Written only after the media is gone from the vendor (`runRetention`), never
     * before.
     */
    recordingDeletedAt: timestamp("recording_deleted_at", { withTimezone: true }),
    /**
     * Every `call_turns.text` on this call has been blanked.
     *
     * The latency, barge-in, and turn-take columns survive it, so `computeMetrics()`
     * still scores a call whose words we have forgotten — which is what lets the
     * retention promise and the measurement promise both be kept.
     */
    transcriptRedactedAt: timestamp("transcript_redacted_at", { withTimezone: true }),
  },
  (table) => [
    index("calls_tenant_started_idx").on(table.tenantId, table.startedAt),
    // The retention cron's working set: the calls that still owe a deletion.
    index("calls_retention_idx").on(table.startedAt),
    // The target of every child's composite FK. `id` is already unique; Postgres
    // still requires a unique constraint on the exact referenced column pair.
    unique("calls_id_tenant_key").on(table.id, table.tenantId),
  ],
);

/**
 * Per-turn trace, emitted in production from day one (principle #5).
 *
 * `barge_in` and `turn_take_ok` are named for Full-Duplex-Bench-v3's
 * definitions, so our figures are comparable to the literature rather than
 * merely internally consistent.
 */
export const callTurns = pgTable(
  "call_turns",
  {
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id),
    /** Denormalized for RLS, and pinned to the call's own tenant by the FK below. */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    idx: integer("idx").notNull(),
    role: text("role").notNull(),
    state: callStateEnum("state").notNull(),
    text: text("text").notNull(),
    firstWordLatencyMs: integer("first_word_latency_ms"),
    turnLatencyMs: integer("turn_latency_ms"),
    bargeIn: boolean("barge_in").notNull().default(false),
    turnTakeOk: boolean("turn_take_ok").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.callId, table.idx] }),
    foreignKey({
      columns: [table.callId, table.tenantId],
      foreignColumns: [calls.id, calls.tenantId],
      name: "call_turns_call_tenant_fk",
    }),
  ],
);

export const slots = pgTable(
  "slots",
  {
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id),
    /** Denormalized for RLS, and pinned to the call's own tenant by the FK below. */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    key: slotKeyEnum("key").notNull(),
    value: jsonb("value").notNull(),
    /** The extractor's self-reported confidence, 0..1. A weak signal, recorded
     * anyway: calibrating it against the eval corpus is what decides whether
     * `if_low_confidence` read-backs are worth their extra turn. */
    confidence: real("confidence").notNull(),
    /**
     * The caller heard this value read back and said yes. Principle #3 is a
     * claim about the world, and this column is the only evidence for it.
     */
    confirmedByCaller: boolean("confirmed_by_caller").notNull().default(false),
    validatorResult: jsonb("validator_result").notNull(),
    /** Bumped each time the caller corrects this slot mid-call. */
    revision: integer("revision").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.callId, table.key] }),
    foreignKey({
      columns: [table.callId, table.tenantId],
      foreignColumns: [calls.id, calls.tenantId],
      name: "slots_call_tenant_fk",
    }),
  ],
);

export const escalations = pgTable(
  "escalations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id),
    /** Denormalized for RLS, and pinned to the call's own tenant by the FK below. */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    reason: escalationReasonEnum("reason").notNull(),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull(),
    transferredTo: text("transferred_to"),
    /** Null means a hazard transfer nobody picked up. Alert on it. */
    humanAckAt: timestamp("human_ack_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.callId, table.tenantId],
      foreignColumns: [calls.id, calls.tenantId],
      name: "escalations_call_tenant_fk",
    }),
  ],
);

/* -------------------------------------------------------------------------- */
/* Bookings                                                                    */
/* -------------------------------------------------------------------------- */

/** Nothing is written to the CRM during a call. This is what the call emits. */
export const pendingBookings = pgTable(
  "pending_bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** A `PendingBookingPayload`, parsed on the way in and on the way out. */
    payload: jsonb("payload").notNull(),
    status: bookingStatusEnum("status").notNull().default("PENDING"),
    workflowRunId: text("workflow_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.callId, table.tenantId],
      foreignColumns: [calls.id, calls.tenantId],
      name: "pending_bookings_call_tenant_fk",
    }),
    unique("pending_bookings_id_tenant_key").on(table.id, table.tenantId),
  ],
);

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pendingBookingId: uuid("pending_booking_id")
      .notNull()
      .references(() => pendingBookings.id),
    /** Denormalized for RLS, pinned to the pending booking's tenant by the FK below. */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    crmJobId: text("crm_job_id").notNull(),
    crmCustomerId: text("crm_customer_id").notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull(),
    /**
     * How many of `POLL_OFFSETS_MS` have run. Drives `nextDuePoll`.
     *
     * Incremented only by `PgBookingStore.recordPoll`, and only *after* the outcome
     * is recorded. A poll that threw is a poll we still owe: consuming it here would
     * turn a CRM outage into a booking we never re-read, and a correction we never
     * counted reads as a *better* number than the truth.
     */
    completedPolls: smallint("completed_polls").notNull().default(0),
  },
  (table) => [
    foreignKey({
      columns: [table.pendingBookingId, table.tenantId],
      foreignColumns: [pendingBookings.id, pendingBookings.tenantId],
      name: "bookings_pending_tenant_fk",
    }),
    unique("bookings_id_tenant_key").on(table.id, table.tenantId),
    index("bookings_due_idx").on(table.completedPolls, table.committedAt),
  ],
);

/**
 * The CRM's copy of a job, over time.
 *
 * This table exists because change detection is **polled, not webhooked**.
 * Webhook support differs across vendors and delivery is at-most-once, and a
 * missed webhook silently reports a 0% correction rate — exactly the number a
 * dishonest vendor would report. A metric whose failure mode is "looks perfect"
 * must not depend on at-most-once delivery (plan, §7).
 */
export const jobSnapshots = pgTable(
  "job_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id),
    /** Denormalized for RLS, and pinned to the booking's own tenant by the FK below. */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    polledAt: timestamp("polled_at", { withTimezone: true }).notNull(),
    /** The vendor's body, verbatim. Retained forever so anyone can recount. */
    payload: jsonb("payload").notNull(),
  },
  (table) => [
    index("job_snapshots_booking_idx").on(table.bookingId, table.polledAt),
    foreignKey({
      columns: [table.bookingId, table.tenantId],
      foreignColumns: [bookings.id, bookings.tenantId],
      name: "job_snapshots_booking_tenant_fk",
    }),
  ],
);

/**
 * Ground truth. The only number that matters, and the one nobody publishes.
 *
 * `classification` and `human_label` are nullable because they are *derived*:
 * the raw `corrected_fields` diff is written by the poller and never rewritten.
 * Step 6's nightly model pass fills `classification`; a weekly 10% human audit
 * fills `human_label`. We publish their agreement rate beside the correction
 * rate, because a model asked whether a contractor's edit was its own fault has
 * an obvious bias.
 */
export const outcomes = pgTable(
  "outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id),
    /** Denormalized for RLS, and pinned to the booking's own tenant by the FK below. */
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    cancelled: boolean("cancelled").notNull().default(false),
    /** Slot key → the contractor's fixed value. Never destructively updated. */
    correctedFields: jsonb("corrected_fields").notNull().default({}),
    source: outcomeSourceEnum("source").notNull(),
    classification: outcomeClassificationEnum("classification"),
    /** The model id that wrote `classification`. A label is only as good as its author. */
    classifiedBy: text("classified_by"),
    /**
     * Why the model said what it said. Not decoration: the weekly auditor has to
     * be able to disagree in thirty seconds, and "agent_error" with no argument
     * behind it is not something anybody can check. `runTriage` refuses to write a
     * classification without one.
     */
    classificationRationale: text("classification_rationale"),
    classifiedAt: timestamp("classified_at", { withTimezone: true }),
    /** The weekly 10% audit. Overrides `classification` wherever it exists. */
    humanLabel: outcomeClassificationEnum("human_label"),
    auditedBy: text("audited_by"),
    auditedAt: timestamp("audited_at", { withTimezone: true }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("outcomes_booking_idx").on(table.bookingId, table.observedAt),
    foreignKey({
      columns: [table.bookingId, table.tenantId],
      foreignColumns: [bookings.id, bookings.tenantId],
      name: "outcomes_booking_tenant_fk",
    }),
    // `(bookingId, observedAt)` is how `ClassificationRecord` and `HumanLabelRecord`
    // name the observation they are labeling — a booking has up to three. Without
    // this, a triage `UPDATE` could silently label two rows, or none.
    unique("outcomes_booking_observed_key").on(table.bookingId, table.observedAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* FAQ (plan, §6 call site #3 — Step 6.4)                                      */
/* -------------------------------------------------------------------------- */

/**
 * The contractor's own answers, and the vectors we find them by.
 *
 * `answer` is spoken to the caller **verbatim**: a model selects which row
 * responds to the question and never writes one (see `packages/faq`). That makes
 * this table a review surface in exactly the way `catalog.ts` is — with the
 * difference that the contractor, not us, is the reviewer, which is the only
 * arrangement in which the agent can quote a price at all.
 *
 * `embedding` is `vector(FAQ_EMBEDDING_DIMENSIONS)`, spread from the contract for
 * the same reason every `pgEnum` here is: two packages must agree on the width,
 * and disagreeing is an insert that fails in production and nowhere else.
 */
export const faqEntries = pgTable(
  "faq_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    embedding: vector("embedding", { dimensions: FAQ_EMBEDDING_DIMENSIONS }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Cosine, because the embedder normalises nothing and the retrieval in
    // `packages/faq` scores with cosine. An L2 index here and a cosine score
    // there would rank differently, and the disagreement would show up as the
    // agent answering the wrong question rather than as an error.
    index("faq_entries_embedding_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    index("faq_entries_tenant_idx").on(table.tenantId),
  ],
);

/* -------------------------------------------------------------------------- */
/* The published figure (Step 9)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every reliability figure we have ever published. **Append-only, and global.**
 *
 * ## Why it has no `tenant_id`, and is not in `TENANT_SCOPED_TABLES`
 *
 * It is the one table here that is nobody's data and everybody's. A published figure is an
 * aggregate over *every* tenant, so scoping it to one would be a category error — and
 * giving it an RLS policy keyed on `app_current_tenant()` would make it unreadable by the
 * public page, which has no tenant and must not have one. It holds no contractor's rows,
 * carries no id that could name one, and the floor in `MIN_COHORT_TENANTS` is what keeps
 * the *arithmetic* from identifying one.
 *
 * `schema.test.ts` asserts the absent column, because a future reader who "fixes" the
 * missing `tenant_id` would break the page and leak nothing — the worst kind of change,
 * one that looks like a security improvement and is a bug.
 *
 * ## Why nothing can rewrite a row
 *
 * `ReportStore` has no `update` and no `delete` (the type), and migration `0004` grants
 * the app role `SELECT` and `INSERT` and nothing else (the privilege) — the same pair of
 * mechanisms that make `outcomes.corrected_fields` unrewritable. **A quarter we did not
 * like cannot be withdrawn; it can only be followed by another quarter published beside
 * it.** A reliability number a vendor can quietly retract is a marketing claim with a
 * database behind it, and the gaps in this table's history are meant to be visible.
 *
 * `methodology_version` rides on every row because a rate is meaningless without the
 * definition of what counts as a correction. Two figures computed under different versions
 * are measurements of different things, and drawing a trend line through them would be a
 * lie told with true numbers.
 */
export const reliabilityReports = pgTable(
  "reliability_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    methodologyVersion: text("methodology_version").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),

    tenants: integer("tenants").notNull(),
    calls: integer("calls").notNull(),
    committedBookings: integer("committed_bookings").notNull(),

    /** The raw rate. Nothing is ever subtracted from it (principle #5). */
    correctionRate: doublePrecision("correction_rate").notNull(),
    /** The 95% Wilson bounds, stored so nobody has to recompute them to quote them. */
    correctionRateLow: doublePrecision("correction_rate_low").notNull(),
    correctionRateHigh: doublePrecision("correction_rate_high").notNull(),
    agentErrorRate: doublePrecision("agent_error_rate").notNull(),

    publishedRate: doublePrecision("published_rate").notNull(),
    publishedBasis: publicationBasisEnum("published_basis").notNull(),
    /** Why it is that rate and not the other one. A number without its basis is a claim without a method. */
    publishedReason: text("published_reason").notNull(),

    auditedOutcomes: integer("audited_outcomes").notNull(),
    triageAgreementRate: doublePrecision("triage_agreement_rate").notNull(),

    /** The worst single tenant, so the pooled average cannot hide them. No id — just the rate. */
    worstTenantCorrectionRate: doublePrecision("worst_tenant_correction_rate").notNull(),
    worstTenantBookings: integer("worst_tenant_bookings").notNull(),

    /** Matured bookings ÷ all bookings committed in the window. A rate's hole, measured. */
    observedCoverage: doublePrecision("observed_coverage").notNull(),
  },
  (table) => [
    index("reliability_reports_window_idx").on(table.windowEnd),
    /**
     * One figure per window per methodology. **This is what makes an append-only table
     * safe to write from a cron**: a retried invocation, or a schedule that fires monthly
     * against a quarterly window, must not stack duplicate reports for the same period —
     * and with no `UPDATE` and no `DELETE` grant, a duplicate could never be cleaned up.
     *
     * `methodology_version` is part of the key on purpose. If the definition of a
     * correction changes, the same quarter may be **restated** under the new definitions —
     * and the restatement is published *beside* the original, never over it. Both numbers
     * stay visible, which is the only honest way to change how you count.
     */
    unique("reliability_reports_window_method_key").on(
      table.windowStart,
      table.windowEnd,
      table.methodologyVersion,
    ),
  ],
);

/* -------------------------------------------------------------------------- */
/* The tenancy manifest (Step 7)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every table holding one contractor's data, and therefore every table that must
 * be `ENABLE`d, `FORCE`d, and policied in `rls.sql`.
 *
 * This list is the *specification*, and `rls.test.ts` checks the database against it
 * — against a real Postgres, after the real migrations have run. Add a table with a
 * `tenant_id` and forget its policy and the suite fails, which is the only version of
 * this guarantee worth having: a comment saying "remember the RLS policy" is a comment
 * that will one day be read by somebody in a hurry, and the cost of missing it is one
 * contractor reading another's calls.
 *
 * `tenants` is not here. It is the root, its policy is `id = current_tenant()`, and it
 * is checked separately — a tenant row scoped by a `tenant_id` column it does not have
 * would be a different bug.
 *
 * **`reliability_reports` is not here either, and that one is a decision rather than a
 * special case** (Step 9). It is an aggregate over every tenant, so it belongs to none of
 * them; it holds no `tenant_id`, and a policy keyed on `app_current_tenant()` would make
 * the *public* page — which has no tenant, and must not have one — unable to read the
 * number we published about ourselves. The thing standing between that table and a
 * contractor's identity is `MIN_COHORT_TENANTS`, not RLS.
 */
export const TENANT_SCOPED_TABLES = [
  "phone_numbers",
  "service_areas",
  "business_hours",
  "job_types",
  "calls",
  "call_turns",
  "slots",
  "escalations",
  "pending_bookings",
  "bookings",
  "job_snapshots",
  "outcomes",
  "faq_entries",
] as const;

/** The Postgres role the application connects as. **Never the table owner** — see `rls.sql`. */
export const APP_ROLE = "ledgerline_app";

/**
 * The GUC the RLS policies read, set per transaction by `withTenant()`.
 *
 * `app.tenant_id` rather than a session variable set at connect time, because the
 * connection is pooled: a `SET` that outlives its request hands the next request the
 * previous tenant's id. `withTenant` uses `set_config(..., is_local => true)` inside a
 * transaction, so it dies with the transaction whether it commits or rolls back.
 */
export const TENANT_GUC = "app.tenant_id";
