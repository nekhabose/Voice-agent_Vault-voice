/**
 * @ledgerline/db — the Drizzle schema, the tenant-scoped client, and the Postgres
 * stores.
 *
 * Until Step 7 this package was **schema only**, and the reason was honest: nothing in
 * the tree had a database, and a pool nobody opens is a lie about what is built. Step 7
 * is when the database arrives, so the client and the stores arrive with it — and they
 * are exercised in the PR suite against a *real* Postgres (`testing.ts` applies the real
 * migrations in-process), which is a stronger claim than any other vendor binding in
 * this repo can make.
 *
 * The enums are spread from `@ledgerline/contracts` so the tables cannot drift from the
 * domain, and every store implements a port defined there — so this package depends on
 * `contracts` alone, and nothing depends on it but the edge (`apps/web`).
 *
 * `testing.ts` is deliberately **not** exported: it pulls in a WebAssembly Postgres, and
 * `apps/web` has no business bundling one.
 */
export * from "./client.js";
export * from "./neon.js";
export * from "./schema.js";
export * from "./stores.js";
