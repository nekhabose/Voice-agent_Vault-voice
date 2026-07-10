import { defineConfig } from "drizzle-kit";

/**
 * `drizzle-kit generate` reads only the schema — no database, no credential.
 * The migration is therefore reviewable in the same PR as the schema change,
 * which is the point: `contracts` widens an enum, the SQL to widen the column
 * shows up in the diff, and nobody discovers the drift in production.
 *
 * `migrate`/`push` need `DATABASE_URL` (Neon). No such database exists yet.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: { url: process.env["DATABASE_URL"] ?? "" },
});
