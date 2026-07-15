import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "./client.js";
import * as schema from "./schema.js";
import { TENANT_SCOPED_TABLES } from "./schema.js";
import { refusal, rowsOf, testDatabase, type TestDatabase } from "./testing.js";

/**
 * Tenant isolation, against a real Postgres running the real migrations.
 *
 * The claim Step 7 has to earn is that one contractor cannot read another's calls. It
 * is not earned by a `WHERE tenant_id = $1` in every query, because that is a habit and
 * habits lapse; it is earned by row-level security underneath, which is a property of
 * the database. These tests are the evidence, and they run in the PR suite with no
 * credential.
 */

const ACME = "11111111-1111-4111-8111-111111111111";
const RIVAL = "22222222-2222-4222-8222-222222222222";

let pg: TestDatabase;

beforeAll(async () => {
  pg = await testDatabase();

  // Seeded as the owner: a superuser bypasses RLS, which is precisely what the first
  // test below is about.
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

  await pg.db.insert(schema.faqEntries).values([
    {
      tenantId: ACME,
      question: "Do you charge for an estimate?",
      answer: "Estimates are free for Acme.",
      embedding: unit(0),
    },
    {
      tenantId: RIVAL,
      question: "Do you charge for an estimate?",
      answer: "Rival charges $89 for an estimate.",
      embedding: unit(0),
    },
  ]);
}, 60_000);

afterAll(async () => {
  await pg.close();
});

describe("the policies exist, on every table that holds a tenant's data", () => {
  /**
   * The drift guard. `TENANT_SCOPED_TABLES` in `schema.ts` is the specification; this
   * reads the database back and checks it. Add a table with a `tenant_id`, forget its
   * policy in the migration, and this fails — which is the only version of the
   * guarantee worth having, because the alternative is a comment that says "remember
   * the RLS policy" and is read one day by somebody in a hurry.
   */
  it.each([...TENANT_SCOPED_TABLES, "tenants"])(
    "%s has RLS enabled, FORCEd, and a policy",
    async (table) => {
      const [row] = rowsOf<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        policies: number;
      }>(
        await pg.db.execute(sql`
          SELECT c.relrowsecurity,
                 c.relforcerowsecurity,
                 (SELECT count(*)::int FROM pg_policies p
                   WHERE p.tablename = c.relname AND p.schemaname = 'public') AS policies
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = ${table}
        `),
      );

      expect(row?.relrowsecurity, `${table}: ENABLE ROW LEVEL SECURITY`).toBe(true);
      expect(row?.relforcerowsecurity, `${table}: FORCE ROW LEVEL SECURITY`).toBe(true);
      expect(row?.policies, `${table}: a tenant_isolation policy`).toBeGreaterThan(0);
    },
  );
});

describe("the owner bypasses row-level security, and that is why the app is not the owner", () => {
  /**
   * The finding that shaped this step, pinned so nobody can un-learn it.
   *
   * RLS is enabled *and* FORCEd on `faq_entries`, and the owner still sees both
   * tenants' rows, because Postgres exempts superusers unconditionally. Neon's default
   * connection string is an owner. A deployment that uses it has policies that do
   * nothing, and a test suite that runs as it would pass with every policy dropped.
   *
   * The mitigation is `ledgerline_app`: no ownership, no BYPASSRLS. `DATABASE_URL` must
   * name it, and this test is what says why.
   */
  it("sees every tenant's rows with no GUC set at all", async () => {
    const rows = await pg.db.select().from(schema.faqEntries);
    expect(rows).toHaveLength(2);
  });
});

describe("as the application role", () => {
  it("an unscoped connection sees nothing — the failure mode is empty, not somebody else's data", async () => {
    // No `withTenant`, so `app.tenant_id` is unset, so `app_current_tenant()` is NULL,
    // so `tenant_id = NULL` is NULL, which is not TRUE. Fail closed.
    const rows = await pg.asApp((db) => db.select().from(schema.faqEntries));
    expect(rows).toEqual([]);
  });

  it("sees only its own tenant's FAQ entries", async () => {
    const acme = await pg.asApp((db) =>
      withTenant(db, ACME, (tx) => tx.select().from(schema.faqEntries)),
    );
    expect(acme.map((row) => row.answer)).toEqual(["Estimates are free for Acme."]);

    const rival = await pg.asApp((db) =>
      withTenant(db, RIVAL, (tx) => tx.select().from(schema.faqEntries)),
    );
    expect(rival.map((row) => row.answer)).toEqual(["Rival charges $89 for an estimate."]);
  });

  it("cannot read another tenant's rows even when it asks for them by id", async () => {
    // The belt (`WHERE tenant_id = $1`) removed on purpose: this query *tries* to read
    // the rival's FAQ, and the braces (RLS) are all that stop it. If a store ever gets
    // its tenant argument wrong, this is the behaviour that saves us.
    const rows = await pg.asApp((db) =>
      withTenant(db, ACME, (tx) =>
        tx.execute(sql`SELECT answer FROM faq_entries WHERE tenant_id = ${RIVAL}`),
      ),
    );
    expect(rowsOf(rows)).toEqual([]);
  });

  it("cannot write a row into another tenant", async () => {
    const why = await refusal(() =>
      pg.asApp((db) =>
        withTenant(db, ACME, (tx) =>
          tx.insert(schema.faqEntries).values({
            tenantId: RIVAL,
            question: "planted",
            answer: "Rival's estimates are now free.",
            embedding: unit(1),
          }),
        ),
      ),
    );
    expect(why).toMatch(/row-level security/i);
  });

  it("does not leak the tenant across transactions on the same connection", async () => {
    // `set_config(..., is_local => true)`. The connection is pooled in production, and a
    // session-level `SET` would hand the next request the previous tenant's id — a
    // cross-tenant read with no bug in any query.
    await pg.asApp(async (db) => {
      await withTenant(db, RIVAL, async (tx) => {
        await tx.select().from(schema.faqEntries);
      });

      const after = await db.select().from(schema.faqEntries);
      expect(after, "the GUC outlived its transaction").toEqual([]);
    });
  });

  it("refuses a tenant id that is not one", async () => {
    await expect(
      pg.asApp((db) => withTenant(db, "'; DROP TABLE tenants; --", async () => "unreachable")),
    ).rejects.toThrow(/is not a tenant id/);
  });
});

describe("the denormalized tenant_id cannot disagree with its parent", () => {
  /**
   * RLS needs `tenant_id` on `call_turns`, `outcomes`, and the rest, because a policy is
   * a per-row `USING` clause and cannot afford a three-level join up to the owning
   * tenant. Denormalized data can lie, and a row whose `tenant_id` says one thing while
   * its parent call says another is a row RLS shows to the wrong contractor.
   *
   * So it is not allowed to lie: `(call_id, tenant_id)` is a composite foreign key into
   * `calls (id, tenant_id)`. The lie is not caught in review. It is caught here.
   */
  it("rejects a call turn filed under a tenant that does not own the call", async () => {
    const [call] = await pg.db
      .insert(schema.calls)
      .values({
        tenantId: ACME,
        fromE164: "+13055551234",
        startedAt: new Date("2026-07-11T15:00:00Z"),
      })
      .returning();

    const why = await refusal(() =>
      pg.db.insert(schema.callTurns).values({
        callId: call!.id,
        tenantId: RIVAL, // the lie
        idx: 0,
        role: "caller",
        state: "GREETING",
        text: "hello",
      }),
    );
    expect(why).toMatch(/call_turns_call_tenant_fk/);
  });
});

describe("the raw diff is append-only, by privilege", () => {
  /**
   * `TriageStore.classify` already cannot express an edit to `correctedFields` (Step
   * 6.2 — a type error, and the stronger guarantee). This is the same rule arrived at
   * independently, in the database, where it holds even for a raw `db.execute()` that
   * never went near the port.
   *
   * The application role has `UPDATE` on the seven derived columns of `outcomes` and on
   * nothing else, and no `DELETE` at all. A model grading our own homework must not be
   * able to erase the homework, and one mechanism guarding that is one mechanism away
   * from none.
   */
  it("the app role may not UPDATE outcomes.corrected_fields", async () => {
    const why = await refusal(() =>
      pg.asApp((db) =>
        withTenant(db, ACME, (tx) =>
          tx.execute(sql`UPDATE outcomes SET corrected_fields = '{}'::jsonb`),
        ),
      ),
    );
    expect(why).toMatch(/permission denied/i);
  });

  it("the app role may not DELETE an outcome", async () => {
    const why = await refusal(() =>
      pg.asApp((db) => withTenant(db, ACME, (tx) => tx.execute(sql`DELETE FROM outcomes`))),
    );
    expect(why).toMatch(/permission denied/i);
  });

  it("the app role may not DELETE a job snapshot — the evidence behind the number", async () => {
    const why = await refusal(() =>
      pg.asApp((db) =>
        withTenant(db, ACME, (tx) => tx.execute(sql`DELETE FROM job_snapshots`)),
      ),
    );
    expect(why).toMatch(/permission denied/i);
  });

  it("but it may write the derived columns — otherwise triage could not run", async () => {
    const granted = rowsOf<{ column_name: string }>(
      await pg.db.execute(sql`
        SELECT column_name
          FROM information_schema.column_privileges
         WHERE table_name = 'outcomes'
           AND privilege_type = 'UPDATE'
           AND grantee = 'ledgerline_app'
         ORDER BY column_name
      `),
    );

    expect(granted.map((row) => row.column_name)).toEqual([
      "audited_at",
      "audited_by",
      "classification",
      "classification_rationale",
      "classified_at",
      "classified_by",
      "human_label",
    ]);
  });
});

/** A unit vector pointing at one axis. Enough to insert; retrieval is `stores.test.ts`. */
function unit(axis: number): number[] {
  const v = new Array<number>(1024).fill(0);
  v[axis] = 1;
  return v;
}
