import { sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";
import { TENANT_GUC } from "./schema.js";

/**
 * The tenant-scoped transaction. Everything that touches a tenant's data goes
 * through it, and Postgres row-level security is what happens when something forgets.
 *
 * `packages/db` is driver-agnostic on purpose: `Db` is any Drizzle Postgres handle, so
 * the PR suite runs the real stores and the real migrations against PGlite (an
 * in-process Postgres) and production runs them against Neon. There is no fake here —
 * the tests use a *real* Postgres, and the only thing they do not have is a network.
 */

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type Tx = PgTransaction<
  PgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** Either handle works: a store built on `Tx` inside `withTenant` is the normal case. */
export type Queryable = Db | Tx;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` as one tenant, inside one transaction.
 *
 * Three decisions, and each one is a way this goes wrong if you make the obvious
 * choice instead:
 *
 * 1. **`set_config(..., is_local => true)`, not `SET`.** The connection is pooled. A
 *    session-level `SET` outlives the request that made it and hands the *next*
 *    request the previous tenant's id — a cross-tenant read with no bug in any query.
 *    `is_local` ties the setting to the transaction, so it dies whether that
 *    transaction commits or rolls back.
 *
 * 2. **A bind parameter, not string interpolation.** `SET LOCAL` cannot take one at
 *    all, which is the real reason `set_config()` is used here: it is a function, so
 *    the tenant id is a value rather than a fragment of SQL text.
 *
 * 3. **The id is checked before it is sent.** `app_current_tenant()` casts the GUC to
 *    `uuid`, so garbage would raise inside the policy — correct, but reported from a
 *    place that has nothing to do with the caller who passed it.
 */
export async function withTenant<T>(
  db: Db,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID.test(tenantId)) {
    throw new Error(`withTenant: ${JSON.stringify(tenantId)} is not a tenant id`);
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config(${TENANT_GUC}, ${tenantId}, true)`);
    return fn(tx);
  });
}
