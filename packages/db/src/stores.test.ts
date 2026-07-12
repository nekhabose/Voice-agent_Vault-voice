import {
  isCorrected,
  type BookingOutcome,
  type PendingBookingPayload,
} from "@ledgerline/contracts";
import { HashingEmbedder, InMemoryFaqIndex } from "@ledgerline/faq";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTenant, type Tx } from "./client.js";
import * as schema from "./schema.js";
import {
  PgBookingStore,
  PgFaqStore,
  PgOutcomeStore,
  PgSnapshotStore,
  PgTriageStore,
  PgVectorFaqIndex,
} from "./stores.js";
import { refusal, testDatabase, type TestDatabase } from "./testing.js";

/**
 * The Postgres stores, against a real Postgres, as the role production connects as.
 *
 * Every assertion here runs inside `pg.asApp()` — as `ledgerline_app`, which owns
 * nothing and bypasses nothing. A suite that ran as the owner would pass with every RLS
 * policy dropped (`rls.test.ts` proves that, which is why it is worth saying).
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const RIVAL = "22222222-2222-4222-8222-222222222222";
const COMMITTED_AT = "2026-07-01T15:00:00.000Z";

let pg: TestDatabase;
let acmeBookingId: string;
let rivalBookingId: string;

const payloadFor = (callId: string, tenantId: string): PendingBookingPayload => ({
  callId,
  tenantId,
  customer: { name: "Rosa Peña", phone: "+13055551234", locale: "en" },
  address: {
    line1: "1247 Calle Ocho",
    city: "Miami",
    state: "FL",
    postalCode: "33135",
    formatted: "1247 SW 8th St, Miami, FL 33135",
    lat: 25.765,
    lng: -80.22,
  },
  problemDescription: "Water heater leaking into the garage",
  urgency: "SAME_DAY",
  window: { startsAt: "2026-07-02T18:00:00.000Z", endsAt: "2026-07-02T22:00:00.000Z" },
  jobTypeId: null,
});

beforeAll(async () => {
  pg = await testDatabase();

  await pg.db.insert(schema.tenants).values([
    {
      id: ACME,
      name: "Acme Plumbing",
      timezone: "America/New_York",
      trade: "plumbing",
      crmProvider: "housecall_pro",
      crmCredentials: "enc:acme",
    },
    {
      id: RIVAL,
      name: "Rival Rooter",
      timezone: "America/Chicago",
      trade: "plumbing",
      crmProvider: "jobber",
      crmCredentials: "enc:rival",
    },
  ]);

  acmeBookingId = await seedBooking(ACME, "hcp-901");
  rivalBookingId = await seedBooking(RIVAL, "jobber-77");
}, 60_000);

afterAll(async () => {
  await pg.close();
});

/** A call → a pending booking → a committed booking, as the saga would have left it. */
async function seedBooking(tenantId: string, crmJobId: string): Promise<string> {
  const [call] = await pg.db
    .insert(schema.calls)
    .values({ tenantId, fromE164: "+13055551234", startedAt: new Date(COMMITTED_AT) })
    .returning();

  const [pending] = await pg.db
    .insert(schema.pendingBookings)
    .values({
      callId: call!.id,
      tenantId,
      payload: payloadFor(call!.id, tenantId),
      status: "COMMITTED",
    })
    .returning();

  const [booking] = await pg.db
    .insert(schema.bookings)
    .values({
      pendingBookingId: pending!.id,
      tenantId,
      crmJobId,
      crmCustomerId: "cust-1",
      committedAt: new Date(COMMITTED_AT),
    })
    .returning();

  return booking!.id;
}

/** Run as `ledgerline_app`, scoped to one tenant. The only way these stores are used. */
const asTenant = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  pg.asApp((db) => withTenant(db, tenantId, fn));

const outcomeAt = (
  bookingId: string,
  observedAt: string,
  fields: Record<string, unknown> = {},
  cancelled = false,
): BookingOutcome => ({
  bookingId,
  cancelled,
  correctedFields: fields,
  source: "CRM_POLL",
  classification: null,
  humanLabel: null,
  observedAt,
});

/* -------------------------------------------------------------------------- */

describe("PgOutcomeStore", () => {
  beforeEach(async () => {
    await pg.db.delete(schema.outcomes);
  });

  it("round-trips an outcome through the contract", async () => {
    const written = outcomeAt(acmeBookingId, "2026-07-02T15:00:00.000Z", {
      service_address: { line1: "1247 SW 8th St" },
    });

    const read = await asTenant(ACME, async (tx) => {
      const store = new PgOutcomeStore(tx, ACME);
      await store.record(written);
      return store.since("2026-07-01T00:00:00.000Z");
    });

    expect(read).toEqual([written]);
  });

  it("is idempotent on (booking, observation) — a retried cron does not double-count", async () => {
    // Three polls per booking already forced `computeMetrics()` to count distinct
    // bookings rather than rows (Step 2, surprise #5). A duplicate row would still
    // corrupt the `triageAgreementRate` denominator, so the database refuses one.
    const outcome = outcomeAt(acmeBookingId, "2026-07-02T15:00:00.000Z", { caller_name: "Rose" });

    const read = await asTenant(ACME, async (tx) => {
      const store = new PgOutcomeStore(tx, ACME);
      await store.record(outcome);
      await store.record(outcome);
      return store.since("2026-07-01T00:00:00.000Z");
    });

    expect(read).toHaveLength(1);
  });

  it("does not show one tenant the other's outcomes", async () => {
    await asTenant(ACME, (tx) =>
      new PgOutcomeStore(tx, ACME).record(
        outcomeAt(acmeBookingId, "2026-07-02T15:00:00.000Z", { caller_name: "Rose" }),
      ),
    );
    await asTenant(RIVAL, (tx) =>
      new PgOutcomeStore(tx, RIVAL).record(
        outcomeAt(rivalBookingId, "2026-07-02T15:00:00.000Z", { caller_name: "Someone else" }),
      ),
    );

    const acme = await asTenant(ACME, (tx) =>
      new PgOutcomeStore(tx, ACME).since("2026-07-01T00:00:00.000Z"),
    );

    expect(acme).toHaveLength(1);
    expect(acme[0]!.bookingId).toBe(acmeBookingId);
  });

  it("cannot write an outcome onto a booking it does not own", async () => {
    // The tenant argument is a lie here — Acme's transaction, the rival's booking. The
    // store's own `WHERE` would not catch it; RLS's `WITH CHECK` does.
    const why = await refusal(() =>
      asTenant(ACME, (tx) =>
        new PgOutcomeStore(tx, ACME).record(outcomeAt(rivalBookingId, "2026-07-02T15:00:00.000Z")),
      ),
    );
    expect(why).toMatch(/row-level security|foreign key|violates/i);
  });
});

describe("PgBookingStore", () => {
  beforeEach(async () => {
    await pg.db.update(schema.bookings).set({ completedPolls: 0 });
  });

  it("offers bookings that still owe a poll, oldest commit first", async () => {
    const due = await asTenant(ACME, (tx) =>
      new PgBookingStore(tx, ACME).unfinished(new Date("2026-07-02T15:00:00.000Z"), 3, 10),
    );

    expect(due).toHaveLength(1);
    expect(due[0]!.bookingId).toBe(acmeBookingId);
    expect(due[0]!.completedPolls).toBe(0);
    expect(due[0]!.crmJobId).toBe("hcp-901");
    // The payload comes back through the contract, not as a cast: a booking written by
    // an older deploy is exactly the drift `contracts` exists to catch.
    expect(due[0]!.booked.customer.name).toBe("Rosa Peña");
  });

  it("withholds a booking committed after the cutoff", async () => {
    const due = await asTenant(ACME, (tx) =>
      new PgBookingStore(tx, ACME).unfinished(new Date("2026-06-30T00:00:00.000Z"), 3, 10),
    );
    expect(due).toEqual([]);
  });

  it("withholds a booking that has run all its polls", async () => {
    await asTenant(ACME, async (tx) => {
      const store = new PgBookingStore(tx, ACME);
      await store.recordPoll(acmeBookingId);
      await store.recordPoll(acmeBookingId);
      await store.recordPoll(acmeBookingId);
    });

    const due = await asTenant(ACME, (tx) =>
      new PgBookingStore(tx, ACME).unfinished(new Date("2026-07-30T00:00:00.000Z"), 3, 10),
    );
    expect(due).toEqual([]);
  });

  it("increments relatively, so two overlapping crons cannot lose a poll", async () => {
    // `SET completed_polls = ${n + 1}` from a value read a moment ago means a slow run
    // and its retry both read 0 and both write 1 — the booking is polled twice at 24h
    // and never at 72h. The increment happens in the database.
    await asTenant(ACME, async (tx) => {
      const store = new PgBookingStore(tx, ACME);
      await store.recordPoll(acmeBookingId);
      await store.recordPoll(acmeBookingId);
    });

    const due = await asTenant(ACME, (tx) =>
      new PgBookingStore(tx, ACME).unfinished(new Date("2026-07-30T00:00:00.000Z"), 3, 10),
    );
    expect(due[0]!.completedPolls).toBe(2);
  });

  it("never offers another tenant's booking", async () => {
    const due = await asTenant(RIVAL, (tx) =>
      new PgBookingStore(tx, RIVAL).unfinished(new Date("2026-07-30T00:00:00.000Z"), 3, 10),
    );
    expect(due.map((booking) => booking.crmJobId)).toEqual(["jobber-77"]);
  });
});

describe("PgSnapshotStore", () => {
  it("keeps the vendor's body verbatim, so anyone can recount", async () => {
    await asTenant(ACME, (tx) =>
      new PgSnapshotStore(tx, ACME).record({
        bookingId: acmeBookingId,
        polledAt: "2026-07-02T15:00:00.000Z",
        payload: { work_status: "scheduled", address: { street: "1247 SW 8th St" } },
      }),
    );

    const [row] = await asTenant(ACME, (tx) => tx.select().from(schema.jobSnapshots));
    expect(row!.payload).toEqual({
      work_status: "scheduled",
      address: { street: "1247 SW 8th St" },
    });
  });
});

describe("PgTriageStore", () => {
  const CORRECTED = "2026-07-02T15:00:00.000Z";
  const CLEAN = "2026-07-05T15:00:00.000Z";
  const CANCELLED = "2026-07-08T15:00:00.000Z";

  beforeEach(async () => {
    await pg.db.delete(schema.outcomes);
    await asTenant(ACME, async (tx) => {
      const store = new PgOutcomeStore(tx, ACME);
      await store.record(outcomeAt(acmeBookingId, CORRECTED, { caller_name: "Rose Pena" }));
      await store.record(outcomeAt(acmeBookingId, CLEAN));
      await store.record(outcomeAt(acmeBookingId, CANCELLED, {}, true));
    });
  });

  it("offers exactly the corrected, unclassified outcomes — and `isCorrected` agrees", async () => {
    // The SQL `WHERE` and `contracts`' `isCorrected()` are the same predicate written
    // twice. If they disagreed, the model would be handed a booking nobody touched and
    // would invent a reason for a change that never happened — in a column we publish
    // from. So the assertion is that they agree, over the same rows.
    const cases = await asTenant(ACME, (tx) => new PgTriageStore(tx, ACME).pending(10));

    expect(cases.map((c) => c.outcome.observedAt)).toEqual([CORRECTED, CANCELLED]);
    expect(cases.every((c) => isCorrected(c.outcome))).toBe(true);

    const all = await asTenant(ACME, (tx) =>
      new PgOutcomeStore(tx, ACME).since("2026-07-01T00:00:00.000Z"),
    );
    expect(all.filter(isCorrected).map((o) => o.observedAt)).toEqual([CORRECTED, CANCELLED]);
  });

  it("labels one observation, not the booking — and leaves the raw diff alone", async () => {
    await asTenant(ACME, (tx) =>
      new PgTriageStore(tx, ACME).classify({
        bookingId: acmeBookingId,
        observedAt: CORRECTED,
        classification: "agent_error",
        rationale: "The caller said Peña; the CRM shows Pena. We dropped the tilde.",
        classifiedBy: "claude-opus-4-8",
        classifiedAt: "2026-07-09T02:00:00.000Z",
      }),
    );

    const all = await asTenant(ACME, (tx) =>
      new PgOutcomeStore(tx, ACME).since("2026-07-01T00:00:00.000Z"),
    );

    const labeled = all.find((o) => o.observedAt === CORRECTED)!;
    expect(labeled.classification).toBe("agent_error");
    // The raw diff rode through untouched. It is retained forever so that anyone —
    // including somebody who thinks we are lying — can recount from it.
    expect(labeled.correctedFields).toEqual({ caller_name: "Rose Pena" });

    // The booking's *other* two observations are untouched: a booking has up to three,
    // and a classification names one.
    expect(all.find((o) => o.observedAt === CANCELLED)!.classification).toBeNull();
  });

  it("the human label overrides the model's, and both are kept", async () => {
    await asTenant(ACME, async (tx) => {
      const store = new PgTriageStore(tx, ACME);
      await store.classify({
        bookingId: acmeBookingId,
        observedAt: CORRECTED,
        classification: "enrichment",
        rationale: "The CRM normalised the name.",
        classifiedBy: "claude-opus-4-8",
        classifiedAt: "2026-07-09T02:00:00.000Z",
      });
      await store.recordHumanLabel({
        bookingId: acmeBookingId,
        observedAt: CORRECTED,
        humanLabel: "agent_error",
        auditedBy: "nekha",
        auditedAt: "2026-07-10T09:00:00.000Z",
      });
    });

    const [row] = await asTenant(ACME, (tx) =>
      tx
        .select()
        .from(schema.outcomes)
        .where(eq(schema.outcomes.observedAt, new Date(CORRECTED))),
    );

    // Both survive. The audit is only meaningful if the disagreement is recoverable.
    expect(row!.classification).toBe("enrichment");
    expect(row!.humanLabel).toBe("agent_error");
  });

  it("never offers another tenant's corrections to the model", async () => {
    await asTenant(RIVAL, (tx) =>
      new PgOutcomeStore(tx, RIVAL).record(
        outcomeAt(rivalBookingId, CORRECTED, { service_address: "somewhere else" }),
      ),
    );

    const cases = await asTenant(ACME, (tx) => new PgTriageStore(tx, ACME).pending(10));
    expect(cases.every((c) => c.outcome.bookingId === acmeBookingId)).toBe(true);
  });
});

describe("PgVectorFaqIndex", () => {
  const embedder = new HashingEmbedder();

  const ACME_FAQ = "33333333-3333-4333-8333-333333333333";
  const ACME_HOURS = "44444444-4444-4444-8444-444444444444";
  const RIVAL_FAQ = "55555555-5555-4555-8555-555555555555";

  beforeAll(async () => {
    await asTenant(ACME, async (tx) => {
      const store = new PgFaqStore(tx, ACME);
      await store.upsert({
        id: ACME_FAQ,
        tenantId: ACME,
        question: "Do you charge for an estimate?",
        answer: "Estimates are free, and there is no call-out fee.",
        embedding: await embedder.embed("Do you charge for an estimate?"),
      });
      await store.upsert({
        id: ACME_HOURS,
        tenantId: ACME,
        question: "What are your hours?",
        answer: "We are open seven to seven, Monday through Saturday.",
        embedding: await embedder.embed("What are your hours?"),
      });
    });

    await asTenant(RIVAL, async (tx) =>
      new PgFaqStore(tx, RIVAL).upsert({
        id: RIVAL_FAQ,
        tenantId: RIVAL,
        question: "Do you charge for an estimate?",
        answer: "Rival charges $89 for an estimate.",
        embedding: await embedder.embed("Do you charge for an estimate?"),
      }),
    );
  }, 30_000);

  it("ranks by cosine similarity, exactly as InMemoryFaqIndex does", async () => {
    // The two implementations must agree, because `SIMILARITY_FLOOR` (0.15) is compared
    // against whatever they return. `<=>` is cosine *distance*; the port's contract is
    // *similarity*. Getting that backwards would invert the ranking silently, and the
    // agent would answer the least relevant question it could find.
    const query = await embedder.embed("Do you charge for an estimate?");

    const fromPg = await asTenant(ACME, (tx) =>
      new PgVectorFaqIndex(tx).search(ACME, query, 5),
    );

    const memory = new InMemoryFaqIndex([
      {
        id: ACME_FAQ,
        tenantId: ACME,
        question: "Do you charge for an estimate?",
        answer: "Estimates are free, and there is no call-out fee.",
        embedding: await embedder.embed("Do you charge for an estimate?"),
      },
      {
        id: ACME_HOURS,
        tenantId: ACME,
        question: "What are your hours?",
        answer: "We are open seven to seven, Monday through Saturday.",
        embedding: await embedder.embed("What are your hours?"),
      },
    ]);
    const fromMemory = await memory.search(ACME, query, 5);

    expect(fromPg.map((r) => r.entry.id)).toEqual(fromMemory.map((r) => r.entry.id));
    expect(fromPg[0]!.entry.answer).toBe("Estimates are free, and there is no call-out fee.");
    expect(fromPg[0]!.score).toBeCloseTo(fromMemory[0]!.score, 5);
    expect(fromPg[0]!.score).toBeGreaterThan(fromPg[1]!.score);
  });

  it("cannot be made to speak one contractor's prices to another's caller", async () => {
    // The belt is a lie here: the index is *asked* for the rival's entries. RLS is what
    // refuses. This is the failure that would be worst in production and least visible
    // in a code review — the caller hears a fluent, confident, wrong price.
    const query = await embedder.embed("Do you charge for an estimate?");

    const leaked = await asTenant(ACME, (tx) =>
      new PgVectorFaqIndex(tx).search(RIVAL, query, 5),
    );

    expect(leaked).toEqual([]);
  });

  it("refuses an embedding of the wrong width, where the embedder was called", async () => {
    // pgvector rejects this at insert time with a message about the column. Raising it
    // here names the actual culprit: an `Embedder` that disagrees with
    // `FAQ_EMBEDDING_DIMENSIONS` is an insert that fails in production and nowhere else.
    await expect(
      asTenant(ACME, (tx) =>
        new PgFaqStore(tx, ACME).upsert({
          id: ACME_FAQ,
          tenantId: ACME,
          question: "q",
          answer: "a",
          embedding: [1, 2, 3],
        }),
      ),
    ).rejects.toThrow(/3-dimension embedding, expected 1024/);
  });
});
