-- Hand-added, and the only hand-written line in any migration here.
-- `drizzle-kit generate` emits `vector(1024)` and the HNSW index but never the
-- extension that makes the type exist, so a generated-only migration fails on
-- its first statement against a fresh Neon database. Drizzle's own docs say to
-- add this by hand. Migrations are append-only — regenerating never rewrites
-- this file — but a future `0002` that reintroduces `vector` on a database
-- where this never ran would need it again.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "faq_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outcomes" ADD COLUMN "classification_rationale" text;--> statement-breakpoint
ALTER TABLE "outcomes" ADD COLUMN "classified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outcomes" ADD COLUMN "audited_by" text;--> statement-breakpoint
ALTER TABLE "outcomes" ADD COLUMN "audited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "faq_entries" ADD CONSTRAINT "faq_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "faq_entries_embedding_idx" ON "faq_entries" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "faq_entries_tenant_idx" ON "faq_entries" USING btree ("tenant_id");