import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import type { Db } from "./client.js";
import * as schema from "./schema.js";
import { APP_ROLE } from "./schema.js";

/**
 * A real Postgres, in this process, with the real committed migrations applied.
 *
 * Not a fake. PGlite is Postgres compiled to WebAssembly, so the RLS policies, the
 * composite foreign keys, the column-level grants, and `pgvector`'s cosine operator
 * are the *actual* ones — the same DDL that will run against Neon, executed by the
 * same migrator, in the PR suite, with no credential and no network. Every other vendor
 * in this repo is stubbed behind a port because we could not afford to guess at its
 * wire format (`GoogleGeocoder`, the CRM adapters, the model bindings). Postgres is the
 * one vendor we do not have to guess about, so we do not.
 *
 * It earned its place immediately: `drizzle-kit generate` emitted `0002`'s composite
 * foreign keys *before* the unique constraints they reference, and the migration did
 * not apply. Nothing short of running it would have found that.
 *
 * **Not exported from `index.ts`**, so `apps/web` never bundles a WASM Postgres.
 */
export interface TestDatabase {
  /**
   * The handle. Runs as the *owner* (a superuser, in PGlite) unless you are inside
   * {@link TestDatabase.asApp}.
   *
   * Postgres exempts a table's owner from row-level security unless the table is
   * FORCEd — and exempts a superuser **even then**. So this handle sees every tenant's
   * rows, which is exactly why the isolation tests do not use it. It is here to seed
   * fixtures and to demonstrate the bypass, which is a fact about Postgres that a
   * deployment can get wrong silently.
   */
  readonly db: Db;
  /**
   * Run `fn` as `ledgerline_app` — the role production connects as, which owns nothing
   * and holds no `BYPASSRLS`.
   *
   * Every assertion about tenant isolation in this repo is made in here. One made
   * outside it would pass with the policies deleted.
   */
  asApp<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

export async function testDatabase(): Promise<TestDatabase> {
  const client = new PGlite({ extensions: { vector } });
  const db = drizzle(client, { schema });

  await migrate(db, { migrationsFolder: MIGRATIONS });

  return {
    db,
    async asApp<T>(fn: (handle: Db) => Promise<T>): Promise<T> {
      // PGlite is one session, so the role is switched on it rather than dialled as a
      // second connection. The privilege difference is the real one either way: what
      // `ledgerline_app` may read, write, and be shown is decided by the grants and
      // policies in migration 0002, not by which client object holds the socket.
      await db.execute(sql.raw(`SET ROLE ${APP_ROLE}`));
      try {
        return await fn(db);
      } finally {
        await db.execute(sql.raw("RESET ROLE"));
      }
    },
    async close() {
      await client.close();
    },
  };
}

/** `db.execute()` hands back the driver's result object; `select()` hands back an array. */
export const rowsOf = <T>(result: unknown): T[] => (result as { rows: T[] }).rows;

/**
 * The message Postgres actually gave, from the exception Drizzle wrapped it in.
 *
 * Drizzle rethrows as `Failed query: <sql>` and hangs the driver's error off `cause`,
 * so a test asserting on `permission denied` or `row-level security` against the
 * top-level message asserts on nothing. Returning the whole chain means a refusal is
 * matched on *why* Postgres refused, not merely that something threw — and "something
 * threw" is exactly what a typo in the SQL also does.
 */
export async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const chain: string[] = [];
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      chain.push(current.message);
    }
    return chain.join(" / ");
  }
  throw new Error("expected Postgres to refuse this, and it did not");
}
