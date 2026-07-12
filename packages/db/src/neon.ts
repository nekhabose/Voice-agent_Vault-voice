import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import type { Db } from "./client.js";
import * as schema from "./schema.js";

/**
 * The production connection (plan, §4 — Neon Postgres on the Vercel Marketplace).
 *
 * **Never used against a live database.** No Neon instance exists in this environment,
 * so this is the same honesty as `GoogleGeocoder` and the CRM adapters: real code
 * against the real driver, unverified against the real vendor. What *is* verified is
 * everything it hands back — the schema, the migrations, the stores, and the RLS
 * policies all run against a real Postgres in the PR suite (`testing.ts`). The unproven
 * surface is one `Pool` and a URL.
 *
 * Two decisions, and the first one is not optional.
 *
 * ## The HTTP driver cannot be used, and it is the one Vercel's docs reach for first
 *
 * `drizzle-orm/neon-http` is the obvious choice for a serverless function: no pool, no
 * WebSocket, one round trip. It also **does not support transactions** — `db.transaction()`
 * throws. And no transaction means no `set_config(..., is_local => true)`, which means no
 * `app.tenant_id`, which means **every RLS policy in migration 0002 evaluates against a
 * NULL tenant and every query returns nothing.**
 *
 * The failure would at least be loud (an empty dashboard, not a leak). But the fix a
 * hurried engineer reaches for — set the GUC at the session level instead — is the one
 * that is quiet *and* wrong: a pooled connection carries that setting into the next
 * request, and the next request belongs to a different contractor.
 *
 * So: the WebSocket pool. It is the price of row-level security, and row-level security
 * is the price of multi-tenancy.
 *
 * ## `DATABASE_URL` must name `ledgerline_app`
 *
 * Neon's default connection string is the *owner* role. Postgres exempts a table's owner
 * from RLS unless the table is FORCEd, and exempts a superuser even then — so connecting
 * as the owner leaves the policies in place and does nothing with them. Migration 0002
 * creates `ledgerline_app` (see {@link APP_ROLE}); the deployment gives it a password out
 * of band, and this URL names it. `rls.test.ts` pins the bypass so that this paragraph is
 * a test result rather than a warning.
 */
export function neonDatabase(connectionString: string): { db: Db; close(): Promise<void> } {
  const pool = new Pool({ connectionString });
  return {
    db: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}
