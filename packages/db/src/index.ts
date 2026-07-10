/**
 * @ledgerline/db — the Drizzle schema for plan.md §7.
 *
 * Schema only. No connection, no client, no query helpers: nothing in the tree
 * has a database yet, and a pool that nobody opens is a lie about what is built.
 * The enums are spread from `@ledgerline/contracts` so the tables cannot drift
 * from the domain.
 */
export * from "./schema.js";
