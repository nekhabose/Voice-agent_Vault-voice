import { neonDatabase, type Db } from "@ledgerline/db";

/**
 * What the two cron routes share: a database handle, and the rule about who may call them.
 *
 * `plan.md` has said since Step 2 that `pollSchedule()` says *when* a booking is due and
 * `runTriage()` says *what to do* with the corrections it finds — and that **nothing
 * called either**. `bookings.completed_polls` was a column nobody incremented. These two
 * routes are what call them, and `vercel.json` is what calls the routes.
 */

/**
 * A Vercel Cron invocation, and nothing else.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` on scheduled invocations. Without
 * this check the routes are public, and a public triage endpoint is an endpoint a
 * stranger can run 10,000 times against our Anthropic bill — or, worse, one they can use
 * to *drain* the poll backlog: every `runOutcomePolls` call they trigger consumes real
 * polls, and a booking polled by an attacker at the wrong moment is a correction we look
 * for too early and never look for again.
 *
 * Missing `CRON_SECRET` is a **refusal**, not a bypass. The tempting `if (!secret) return
 * true` — so it works in development — is how the check ships disabled.
 */
export function isCronRequest(request: Request, env = process.env): boolean {
  const secret = env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * The database, as `ledgerline_app`.
 *
 * `DATABASE_URL` must name that role rather than Neon's default owner: Postgres exempts a
 * table's owner from row-level security unless the table is FORCEd, and exempts a
 * superuser even then, so the owner's connection has policies that do nothing. See
 * `packages/db/src/neon.ts`, and `rls.test.ts`, which pins the bypass.
 *
 * **No Neon instance exists yet** (task 7.7), so nothing has ever called this.
 */
export function database(env = process.env): { db: Db; close(): Promise<void> } {
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neonDatabase(url);
}
