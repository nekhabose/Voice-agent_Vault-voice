import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTenant } from "./client.js";
import * as schema from "./schema.js";
import { PgRetentionStore } from "./stores.js";
import { refusal, testDatabase, type TestDatabase } from "./testing.js";

/**
 * The retention store, against a real Postgres, as the role production connects as.
 *
 * Two things are proven here that no in-memory double could be, and both are about what
 * the app role **cannot** do:
 *
 * 1. It cannot `DELETE` a call, so retention has to *redact* — which is what preserves
 *    the reliability metrics through a purge.
 * 2. It cannot `DELETE` an outcome, so the deletion policy structurally cannot reach the
 *    evidence behind the number we publish.
 *
 * Neither is a rule we wrote in this file. Both fall out of migration `0002`'s grants, and
 * the tests below are how we know they still hold.
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const RIVAL = "22222222-2222-4222-8222-222222222222";

/** Older than the 90-day recording window and the 365-day transcript window. */
const ANCIENT = new Date("2024-01-01T10:00:00.000Z");
/** Older than the recording window, inside the transcript window. */
const OLD = new Date("2026-01-01T10:00:00.000Z");
/** Yesterday. Expired for nothing. */
const RECENT = new Date("2026-07-10T10:00:00.000Z");

const NOW = new Date("2026-07-11T03:00:00.000Z");
const RECORDINGS_BEFORE = new Date("2026-04-12T03:00:00.000Z");
const TRANSCRIPTS_BEFORE = new Date("2025-07-11T03:00:00.000Z");

let pg: TestDatabase;

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
}, 60_000);

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  // The owner's handle, which bypasses RLS — the only correct way to reset fixtures for
  // both tenants at once, and the reason `testDatabase()` exposes it at all.
  await pg.db.delete(schema.callTurns);
  await pg.db.delete(schema.calls);
});

async function seedCall(options: {
  readonly tenantId: string;
  readonly startedAt: Date;
  readonly recordingUrl?: string | null;
}): Promise<string> {
  const [call] = await pg.db
    .insert(schema.calls)
    .values({
      tenantId: options.tenantId,
      fromE164: "+13055551234",
      startedAt: options.startedAt,
      recordingUrl: options.recordingUrl ?? null,
      transcriptUrl: "/transcripts/x.json",
      outcome: "BOOKED",
    })
    .returning({ id: schema.calls.id });

  // One agent turn, with the three columns `computeMetrics()` actually reads.
  await pg.db.insert(schema.callTurns).values({
    callId: call!.id,
    tenantId: options.tenantId,
    idx: 0,
    role: "agent",
    state: "GREETING",
    text: "Thanks for calling. You're speaking with an automated assistant.",
    firstWordLatencyMs: 310,
    turnLatencyMs: 940,
    bargeIn: false,
    turnTakeOk: true,
  });

  return call!.id;
}

const store = (tx: Parameters<Parameters<typeof withTenant>[2]>[0], tenantId: string) =>
  new PgRetentionStore(tx, tenantId);

describe("PgRetentionStore — expiredRecordings", () => {
  it("offers a recording past its window, oldest first", async () => {
    const ancient = await seedCall({ tenantId: ACME, startedAt: ANCIENT, recordingUrl: "/rec/a" });
    const old = await seedCall({ tenantId: ACME, startedAt: OLD, recordingUrl: "/rec/b" });

    const expired = await pg.asApp((db) =>
      withTenant(db, ACME, (tx) => store(tx, ACME).expiredRecordings(RECORDINGS_BEFORE, 10)),
    );

    expect(expired.map((r) => r.callId)).toEqual([ancient, old]);
    expect(expired.map((r) => r.recordingUrl)).toEqual(["/rec/a", "/rec/b"]);
  });

  it("does not offer a recording still inside its window", async () => {
    await seedCall({ tenantId: ACME, startedAt: RECENT, recordingUrl: "/rec/new" });

    const expired = await pg.asApp((db) =>
      withTenant(db, ACME, (tx) => store(tx, ACME).expiredRecordings(RECORDINGS_BEFORE, 10)),
    );
    expect(expired).toEqual([]);
  });

  it("does not offer a call that never had a recording", async () => {
    await seedCall({ tenantId: ACME, startedAt: ANCIENT, recordingUrl: null });

    const expired = await pg.asApp((db) =>
      withTenant(db, ACME, (tx) => store(tx, ACME).expiredRecordings(RECORDINGS_BEFORE, 10)),
    );
    expect(expired).toEqual([]);
  });

  /**
   * One contractor's retention job must not be handed another contractor's recordings —
   * and note that it could not delete them anyway, because the URL it would be given is one
   * RLS never shows it. Two mechanisms, and this asserts the outcome of both.
   */
  it("never offers another tenant's recording", async () => {
    await seedCall({ tenantId: RIVAL, startedAt: ANCIENT, recordingUrl: "/rec/rival" });

    const expired = await pg.asApp((db) =>
      withTenant(db, ACME, (tx) => store(tx, ACME).expiredRecordings(RECORDINGS_BEFORE, 10)),
    );
    expect(expired).toEqual([]);
  });
});

describe("PgRetentionStore — the tombstone", () => {
  /**
   * A null `recording_url` could mean the call was never recorded, that the carrier lost
   * it, or that we deleted it as promised. Three different sentences, and a deletion policy
   * whose only evidence is a *missing value* can prove none of them. So both facts are
   * written: the URL points at nothing, and the reason is that we deleted it, on this date.
   */
  it("writes the fact of the deletion, not merely the absence of a URL", async () => {
    const callId = await seedCall({ tenantId: ACME, startedAt: ANCIENT, recordingUrl: "/rec/a" });

    await pg.asApp((db) =>
      withTenant(db, ACME, (tx) => store(tx, ACME).markRecordingDeleted(callId, NOW)),
    );

    const [row] = await pg.db.select().from(schema.calls).where(eq(schema.calls.id, callId));
    expect(row!.recordingUrl).toBeNull();
    expect(row!.recordingDeletedAt).toEqual(NOW);
  });

  /** Tombstoned means done. A second run must not keep re-offering a finished deletion. */
  it("takes the call out of the working set", async () => {
    const callId = await seedCall({ tenantId: ACME, startedAt: ANCIENT, recordingUrl: "/rec/a" });

    const remaining = await pg.asApp((db) =>
      withTenant(db, ACME, async (tx) => {
        await store(tx, ACME).markRecordingDeleted(callId, NOW);
        return store(tx, ACME).expiredRecordings(RECORDINGS_BEFORE, 10);
      }),
    );

    expect(remaining).toEqual([]);
  });
});

describe("PgRetentionStore — the words go, the numbers stay", () => {
  /**
   * **The property the whole retention design turns on.**
   *
   * `redactTranscript` blanks `call_turns.text` and leaves `first_word_latency_ms`,
   * `barge_in`, and `turn_take_ok` standing — which are exactly the columns
   * `computeMetrics()` reads, and none of them is the caller's words. So the reliability
   * numbers this company exists to publish can still be recomputed, from scratch, over a
   * database that has forgotten every caller who ever phoned.
   *
   * That is not a lucky accident of the schema. Principle #5 defined the metrics over turn
   * *shape* rather than turn *content*, and this is the day that decision pays: a retention
   * policy that cost us the measurement would be a policy somebody eventually argued their
   * way out of.
   */
  it("blanks the text and keeps every column the metrics are computed from", async () => {
    const callId = await seedCall({ tenantId: ACME, startedAt: ANCIENT });

    await pg.asApp((db) =>
      withTenant(db, ACME, (tx) => store(tx, ACME).redactTranscript(callId, NOW)),
    );

    const [turn] = await pg.db
      .select()
      .from(schema.callTurns)
      .where(eq(schema.callTurns.callId, callId));

    expect(turn!.text).toBe("");
    expect(turn!.firstWordLatencyMs).toBe(310);
    expect(turn!.turnLatencyMs).toBe(940);
    expect(turn!.bargeIn).toBe(false);
    expect(turn!.turnTakeOk).toBe(true);

    const [call] = await pg.db.select().from(schema.calls).where(eq(schema.calls.id, callId));
    expect(call!.transcriptRedactedAt).toEqual(NOW);
    expect(call!.transcriptUrl).toBeNull();
    // The call itself survives. It is evidence, and the row is how the metric knows it
    // happened at all.
    expect(call!.outcome).toBe("BOOKED");
  });

  it("offers a transcript past its window, and not one inside it", async () => {
    const ancient = await seedCall({ tenantId: ACME, startedAt: ANCIENT });
    await seedCall({ tenantId: ACME, startedAt: OLD });

    const expired = await pg.asApp((db) =>
      withTenant(db, ACME, (tx) => store(tx, ACME).expiredTranscripts(TRANSCRIPTS_BEFORE, 10)),
    );

    expect(expired).toEqual([ancient]);
  });

  it("never redacts another tenant's transcript", async () => {
    const rival = await seedCall({ tenantId: RIVAL, startedAt: ANCIENT });

    await pg.asApp((db) =>
      withTenant(db, ACME, (tx) => store(tx, ACME).redactTranscript(rival, NOW)),
    );

    const [turn] = await pg.db
      .select()
      .from(schema.callTurns)
      .where(eq(schema.callTurns.callId, rival));
    expect(turn!.text).not.toBe("");
  });
});

/**
 * What the retention job cannot do, and it is not this file that stops it.
 *
 * Migration `0002` granted the app role no `DELETE` on `calls`, `call_turns`,
 * `job_snapshots`, or `outcomes` — "a call is evidence", and the raw diff is append-only by
 * privilege. Step 8 did not add a single grant, and these two tests are why: the deletion
 * policy was *already* unable to reach the things it must not reach, and a `PgRetentionStore`
 * that grew a `delete()` would compile, ship, and be refused by Postgres.
 */
describe("what the deletion policy is not allowed to delete", () => {
  it("cannot delete a call — retention redacts, and has no choice", async () => {
    const callId = await seedCall({ tenantId: ACME, startedAt: ANCIENT });

    const message = await refusal(() =>
      pg.asApp((db) =>
        withTenant(db, ACME, (tx) =>
          tx.delete(schema.calls).where(eq(schema.calls.id, callId)),
        ),
      ),
    );

    expect(message).toMatch(/permission denied/i);
  });

  /**
   * The interlock. `outcomes` holds the raw diff every published reliability number is
   * computed from, and a retention job with a `DELETE` on it would be a mechanism for
   * quietly shredding the corrections that made our number look bad — the missed-webhook
   * failure mode wearing a fourth hat, and this time wearing a compliance badge.
   */
  it("cannot delete an outcome, however good the reason sounds", async () => {
    const message = await refusal(() =>
      pg.asApp((db) => withTenant(db, ACME, (tx) => tx.delete(schema.outcomes))),
    );

    expect(message).toMatch(/permission denied/i);
  });
});
