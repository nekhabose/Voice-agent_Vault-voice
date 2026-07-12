-- Step 8 — compliance.
--
-- **No hand-edits**, unlike `0001` (the pgvector extension) and `0002` (the reordered
-- FKs and the whole RLS section). Worth saying out loud, because the reason is that
-- Step 8 needed no new privileges — and *that* is the interesting part:
--
--   * The retention job UPDATEs `calls` and `call_turns`, and `0002` already granted
--     the app role table-level UPDATE on both. A table grant covers columns added
--     later, so the two tombstones below are writable the moment they exist.
--   * The retention job has **no DELETE on anything**, because `0002` granted none —
--     "a call is evidence", and `outcomes`/`job_snapshots` are append-only by
--     privilege. So the deletion policy structurally cannot reach the raw diff behind
--     the number we publish, and it did not take a line of SQL here to arrange that.
--
-- `state_code DEFAULT 'XX'` and `recording_enabled DEFAULT false` are the load-bearing
-- defaults: `XX` is not a USPS state, so an unconfigured tenant resolves to the
-- all-party consent branch, and an unconfigured tenant records nobody at all. The rows
-- nobody remembered to fill in are the rows a compliance default exists for.
ALTER TABLE "calls" ADD COLUMN "recording_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "transcript_redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "state_code" text DEFAULT 'XX' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "recording_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "dpa_version" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "dpa_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "dpa_accepted_by" text;--> statement-breakpoint
CREATE INDEX "calls_retention_idx" ON "calls" USING btree ("started_at");