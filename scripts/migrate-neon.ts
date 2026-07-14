/**
 * Task 7.7 — apply the migrations to a live Neon, and mint the role that is
 * allowed to talk to it.
 *
 * Everything in `packages/db` already runs against a real Postgres in the PR
 * suite (PGlite, in-process, no credential): the schema, all five migrations, the
 * RLS policies, the composite FKs, the column grants, and `pgvector`'s cosine
 * ranking. What has never been proven is **one `Pool` and a URL**. This is that.
 *
 * ## The whole reason this is a script and not a `psql` one-liner
 *
 * Migration `0002` creates `ledgerline_app` as **`NOLOGIN`**. That is deliberate:
 * a migration is committed to a git repository, and a migration that sets a
 * password is a password in a git repository. So the role exists, owns nothing,
 * and cannot connect — and giving it a password is a deployment act, done here,
 * once, with the value written to a gitignored file rather than to a terminal.
 *
 * And it *must* be done, because the alternative is the trap this whole design is
 * arranged around: **Neon's default connection string is the table owner, and
 * Postgres exempts an owner from row-level security unless the table is FORCEd —
 * and a superuser even then.** Connect as the owner and every policy in `0002`
 * does exactly nothing. No error. No warning. Every test written against that
 * connection passes with the policies deleted. `rls.test.ts` has a *passing* test
 * asserting the owner sees both tenants' rows, precisely so that nobody reads this
 * paragraph and thinks it is theoretical.
 *
 * So: connect as the owner exactly once, to run the migrations and mint the role.
 * Then hand the application a URL that names `ledgerline_app`, and prove — against
 * the live database, not PGlite — that the two connections see different things.
 *
 * Usage. `DATABASE_URL` must be the **owner** URL Neon gives you by default:
 *
 *   npx tsx --env-file=.env scripts/migrate-neon.ts
 *
 * It prints no secret. The app-role URL is written to `.env.ledgerline_app`
 * (gitignored) for you to paste into `.env` yourself.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Run: npx tsx --env-file=.env scripts/migrate-neon.ts");
  process.exit(1);
}

const APP_ROLE = "ledgerline_app";
const MIGRATIONS = join(process.cwd(), "packages/db/migrations");

/** Redact everything but the host, so a paste of this output is safe. */
const hostOf = (raw: string): string => {
  try {
    return new URL(raw).host;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
};

const pool = new Pool({ connectionString: url });

async function one<T = Record<string, unknown>>(sql: string): Promise<T> {
  const { rows } = await pool.query(sql);
  return rows[0] as T;
}

console.log(`\nConnecting to ${hostOf(url)} …`);

const who = await one<{ role: string; db: string; superuser: boolean }>(
  `SELECT current_user AS role, current_database() AS db,
          (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`,
);
console.log(`  role=${who.role}  db=${who.db}  superuser=${who.superuser}`);

if (who.role === APP_ROLE) {
  // The app role owns nothing and holds no DDL grants. It could not create a
  // table if it tried — but the failure would be a confusing permission error
  // twelve statements in, so say the real thing instead.
  console.error(
    `\n  DATABASE_URL names ${APP_ROLE}, which is the role the *application* uses.\n` +
      `  Migrations must run as the owner. Use the default URL Neon gave you here,\n` +
      `  and the ${APP_ROLE} URL in the app.`,
  );
  process.exit(1);
}

/* -- 1. The extension. `0001` needs it and drizzle-kit never emits it. --------- */
await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
console.log("  vector extension: ready");

/* -- 2. The migrations, in order, each in a transaction. ----------------------- */
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort();

await pool.query(
  `CREATE TABLE IF NOT EXISTS __ledgerline_migrations (
     name text PRIMARY KEY,
     applied_at timestamptz NOT NULL DEFAULT now()
   )`,
);

const { rows: applied } = await pool.query<{ name: string }>(
  "SELECT name FROM __ledgerline_migrations",
);
const done = new Set(applied.map((r) => r.name));

console.log(`\n${files.length} migrations, ${done.size} already applied:`);

for (const file of files) {
  if (done.has(file)) {
    console.log(`  ${file}  (already applied)`);
    continue;
  }

  const sql = readFileSync(join(MIGRATIONS, file), "utf8");
  // drizzle's own separator. Splitting on `;` would break on the `DO $$ … $$`
  // block that creates the role and on every function body in `0004`.
  const statements = sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s !== "");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of statements) await client.query(statement);
    await client.query("INSERT INTO __ledgerline_migrations (name) VALUES ($1)", [file]);
    await client.query("COMMIT");
    console.log(`  ${file}  applied (${statements.length} statements)`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`  ${file}  FAILED — rolled back`);
    throw error;
  } finally {
    client.release();
  }
}

/* -- 3. Mint the role. `0002` created it NOLOGIN, on purpose. ------------------ */
const password = randomBytes(24).toString("base64url");
await pool.query(`ALTER ROLE ${APP_ROLE} WITH LOGIN PASSWORD '${password}'`);
console.log(`\n${APP_ROLE}: LOGIN granted, password rotated`);

// Neon puts every table in the owner role's default privileges; without this the
// app role can reach the tables `0002` granted and nothing created after.
await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);

const appUrl = new URL(url);
appUrl.username = APP_ROLE;
appUrl.password = password;

/* -- 4. Prove it. Against the live database, not PGlite. ----------------------- */
console.log("\nVerifying, on the live database:");

const tables = await one<{ n: string }>(
  `SELECT count(*)::text AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
);
const forced = await one<{ n: string }>(
  `SELECT count(*)::text AS n FROM pg_class c
     JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relrowsecurity AND c.relforcerowsecurity`,
);
const policies = await one<{ n: string }>(
  "SELECT count(*)::text AS n FROM pg_policies WHERE schemaname = 'public'",
);
console.log(`  ${tables.n} tables, ${forced.n} with RLS ENABLEd AND FORCEd, ${policies.n} policies`);

// The cross-tenant aggregate must be SECURITY DEFINER, or the published number is
// computed over nothing. Flipping it to INVOKER fails four tests; it would also
// silently publish 0.0% here, which is the one number we must never publish by
// accident.
const definer = await one<{ prosecdef: boolean }>(
  `SELECT prosecdef FROM pg_proc WHERE proname = 'app_reliability_cohort'`,
);
console.log(`  app_reliability_cohort: SECURITY ${definer?.prosecdef ? "DEFINER" : "INVOKER  <-- BROKEN"}`);

const appPool = new Pool({ connectionString: appUrl.toString() });
try {
  const appWho = await appPool.query<{ role: string }>("SELECT current_user AS role");
  console.log(`  ${APP_ROLE} can connect: ${appWho.rows[0]?.role === APP_ROLE}`);

  // The load-bearing assertion. An unscoped connection — no `app.tenant_id` set —
  // must see NOTHING. If this returns a row count above zero, RLS is decoration:
  // either the app role owns a table, or a policy is missing, or the connection is
  // secretly the owner.
  const leak = await appPool.query<{ n: string }>("SELECT count(*)::text AS n FROM tenants");
  const rows = Number(leak.rows[0]?.n ?? -1);
  console.log(`  ${APP_ROLE} unscoped sees ${rows} tenant rows` + (rows === 0 ? "  ✓" : "  <-- LEAK"));

  const ddl = await appPool
    .query("CREATE TABLE __should_not_exist (id int)")
    .then(() => "SUCCEEDED  <-- the app role owns things, RLS will not apply to them")
    .catch(() => "refused  ✓");
  console.log(`  ${APP_ROLE} DDL: ${ddl}`);
} finally {
  await appPool.end();
}

await pool.end();

/* -- 5. Hand back the URL, without printing it. -------------------------------- */
writeFileSync(
  ".env.ledgerline_app",
  `# Written by scripts/migrate-neon.ts. Gitignored.\n` +
    `# Replace DATABASE_URL in .env with this line, then delete this file.\n` +
    `# It names ${APP_ROLE}, which owns nothing — so row-level security actually applies.\n` +
    `# The role Neon gives you by default is the table OWNER, and Postgres exempts an\n` +
    `# owner from RLS. Connect as it and every policy in migration 0002 is decoration.\n` +
    `DATABASE_URL=${appUrl.toString()}\n`,
  { mode: 0o600 },
);

console.log(
  `\nWrote .env.ledgerline_app (gitignored, 0600).\n` +
    `Copy its DATABASE_URL line into .env, replacing the owner URL, then delete it.\n` +
    `Keep the owner URL somewhere safe — future migrations need it, and nothing else does.\n`,
);
