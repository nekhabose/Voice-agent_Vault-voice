-- Step 7 — tenancy.
--
-- TWO HAND-EDITS to `drizzle-kit generate`'s output, and both are load-bearing.
--
-- 1. **The statements are reordered.** drizzle-kit emitted every composite foreign
--    key *before* the UNIQUE constraint it references, and Postgres rejects a
--    foreign key whose referenced columns carry no unique constraint yet. The
--    generated file did not apply. We know because it was run — see `rls.test.ts`,
--    which applies these migrations to a real Postgres in the PR suite.
--
-- 2. **The RLS section at the bottom is written by hand**, as `0001`'s
--    `CREATE EXTENSION` is. drizzle-kit does not emit `FORCE ROW LEVEL SECURITY`,
--    the app role, or the column-level grants, and those three are the entire
--    isolation guarantee.

--> ---------------------------------------------------------------------------
--> The denormalized tenant_id, and the constraints that keep it honest
--> ---------------------------------------------------------------------------

ALTER TABLE "bookings" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "call_turns" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "escalations" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "job_snapshots" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "outcomes" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "slots" ADD COLUMN "tenant_id" uuid NOT NULL;--> statement-breakpoint

-- The UNIQUE constraints come first: they are what the composite FKs below point at.
ALTER TABLE "calls" ADD CONSTRAINT "calls_id_tenant_key" UNIQUE("id","tenant_id");--> statement-breakpoint
ALTER TABLE "pending_bookings" ADD CONSTRAINT "pending_bookings_id_tenant_key" UNIQUE("id","tenant_id");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_id_tenant_key" UNIQUE("id","tenant_id");--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_booking_observed_key" UNIQUE("booking_id","observed_at");--> statement-breakpoint

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_turns" ADD CONSTRAINT "call_turns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_snapshots" ADD CONSTRAINT "job_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- The composite keys. A child row cannot name a tenant its parent does not.
ALTER TABLE "call_turns" ADD CONSTRAINT "call_turns_call_tenant_fk" FOREIGN KEY ("call_id","tenant_id") REFERENCES "public"."calls"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_call_tenant_fk" FOREIGN KEY ("call_id","tenant_id") REFERENCES "public"."calls"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_call_tenant_fk" FOREIGN KEY ("call_id","tenant_id") REFERENCES "public"."calls"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_bookings" ADD CONSTRAINT "pending_bookings_call_tenant_fk" FOREIGN KEY ("call_id","tenant_id") REFERENCES "public"."calls"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_pending_tenant_fk" FOREIGN KEY ("pending_booking_id","tenant_id") REFERENCES "public"."pending_bookings"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_snapshots" ADD CONSTRAINT "job_snapshots_booking_tenant_fk" FOREIGN KEY ("booking_id","tenant_id") REFERENCES "public"."bookings"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_booking_tenant_fk" FOREIGN KEY ("booking_id","tenant_id") REFERENCES "public"."bookings"("id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "bookings_due_idx" ON "bookings" USING btree ("completed_polls","committed_at");--> statement-breakpoint

--> ---------------------------------------------------------------------------
--> Row-level security
--> ---------------------------------------------------------------------------

-- Which tenant is this transaction acting for.
--
-- `current_setting(..., true)` returns NULL when the GUC was never set, so an
-- unscoped connection matches `tenant_id = NULL`, which is NULL, which is not TRUE,
-- which is **no rows**. The failure mode of forgetting `withTenant()` is an empty
-- result set, not somebody else's data. Fail closed, and prove it (`rls.test.ts`).
CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;--> statement-breakpoint

-- The role the application connects as.
--
-- **It must not be the table owner.** Postgres exempts the owner from RLS unless the
-- table is FORCEd, and exempts a superuser *even then* — so a deployment that connects
-- with Neon's default `neondb_owner` string has policies that do exactly nothing, and
-- every test run as that role passes. That is not a hypothetical: it is what this
-- migration's own first draft did, and `rls.test.ts` now pins the bypass so nobody can
-- mistake the policies for the guarantee.
--
-- NOLOGIN, and no password: a password in a migration is a password in git. The
-- deployment grants LOGIN and sets the secret out of band, and `DATABASE_URL` must
-- name *this* role.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ledgerline_app') THEN
    CREATE ROLE ledgerline_app NOLOGIN;
  END IF;
END $$;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO ledgerline_app;--> statement-breakpoint

-- Tenant configuration: the contractor owns it, so they may delete from it.
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, phone_numbers, service_areas, business_hours, job_types, faq_entries TO ledgerline_app;--> statement-breakpoint

-- The record of what happened on the phone. No DELETE: a call is evidence.
GRANT SELECT, INSERT, UPDATE ON calls, call_turns, slots, escalations, pending_bookings, bookings TO ledgerline_app;--> statement-breakpoint

-- The raw evidence behind the published number. Append-only, by privilege.
GRANT SELECT, INSERT ON job_snapshots TO ledgerline_app;--> statement-breakpoint

-- `outcomes` is the load-bearing grant in this file.
--
-- INSERT and SELECT, and UPDATE on **the derived columns only**. The application role
-- has no privilege that can rewrite `corrected_fields`, `cancelled`, or `source` — the
-- raw diff — and no privilege that can delete an outcome at all.
--
-- `TriageStore.classify` already cannot express that edit (Step 6.2, a type error).
-- This is the same guarantee arrived at independently, in the database, where it holds
-- even for a `db.execute(sql\`...\`)` that never went near the port. A model grading our
-- own homework must not be able to erase the homework, and one mechanism guarding that
-- is one mechanism away from none.
GRANT SELECT, INSERT ON outcomes TO ledgerline_app;--> statement-breakpoint
GRANT UPDATE (classification, classified_by, classification_rationale, classified_at, human_label, audited_by, audited_at) ON outcomes TO ledgerline_app;--> statement-breakpoint

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenants USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());--> statement-breakpoint

ALTER TABLE phone_numbers ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE phone_numbers FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON phone_numbers USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

ALTER TABLE service_areas ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE service_areas FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON service_areas USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

ALTER TABLE business_hours ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE business_hours FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON business_hours USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

ALTER TABLE job_types ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE job_types FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON job_types USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

ALTER TABLE calls ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE calls FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON calls USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

ALTER TABLE call_turns ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE call_turns FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON call_turns USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

ALTER TABLE slots ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE slots FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON slots USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

ALTER TABLE escalations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE escalations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON escalations USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

ALTER TABLE pending_bookings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE pending_bookings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON pending_bookings USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE bookings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON bookings USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

ALTER TABLE job_snapshots ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE job_snapshots FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON job_snapshots USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

ALTER TABLE outcomes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE outcomes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON outcomes USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());--> statement-breakpoint

ALTER TABLE faq_entries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE faq_entries FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON faq_entries USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
