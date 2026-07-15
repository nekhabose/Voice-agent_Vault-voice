import { describe, expect, it } from "vitest";
import { neonDatabase } from "./neon.js";

/**
 * The production connection factory, and the *only* thing in `packages/db` that has never
 * met a real Postgres.
 *
 * Everything else in this package — the schema, both migrations, every store, and every
 * RLS policy — is exercised against an actual Postgres in the PR suite. What is left
 * unproven here is a `Pool` and a URL, and this test says exactly that much: the handle
 * builds, and it is a Drizzle handle. It does not connect, and no Neon instance exists to
 * connect to (task 7.7).
 *
 * A test that pretended to more than that would be worse than none.
 */
describe("neonDatabase", () => {
  it("builds a Drizzle handle without dialling anything", async () => {
    const { db, close } = neonDatabase("postgresql://ledgerline_app:pw@db.invalid/main");

    expect(typeof db.select).toBe("function");
    expect(typeof db.transaction).toBe("function");

    // Transactions are the whole reason this is the WebSocket pool and not
    // `drizzle-orm/neon-http`: no transaction means no `set_config(..., is_local)`, which
    // means no `app.tenant_id`, which means every RLS policy evaluates against NULL. See
    // the note on `neonDatabase`.
    await close();
  });
});
