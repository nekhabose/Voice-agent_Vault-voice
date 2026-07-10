CREATE TYPE "public"."booking_status" AS ENUM('PENDING', 'COMMITTING', 'COMMITTED', 'FAILED', 'ROLLED_BACK');--> statement-breakpoint
CREATE TYPE "public"."call_outcome" AS ENUM('BOOKED', 'ESCALATED_EMERGENCY', 'ESCALATED_OTHER', 'CALLER_HUNG_UP', 'OUT_OF_SERVICE_AREA', 'AGENT_ERROR');--> statement-breakpoint
CREATE TYPE "public"."call_state" AS ENUM('GREETING', 'IDENTIFY', 'TRIAGE', 'QUALIFY', 'SCHEDULE', 'CONFIRM', 'CLOSE', 'EMERGENCY', 'HANDOFF');--> statement-breakpoint
CREATE TYPE "public"."crm_provider" AS ENUM('housecall_pro', 'jobber');--> statement-breakpoint
CREATE TYPE "public"."escalation_reason" AS ENUM('EMERGENCY_HAZARD', 'OUT_OF_SERVICE_AREA', 'CALLER_REQUESTED_HUMAN', 'REPEATED_EXTRACTION_FAILURE', 'AGENT_ERROR');--> statement-breakpoint
CREATE TYPE "public"."locale" AS ENUM('en', 'es', 'hi', 'tl', 'vi');--> statement-breakpoint
CREATE TYPE "public"."outcome_classification" AS ENUM('agent_error', 'business_change', 'enrichment');--> statement-breakpoint
CREATE TYPE "public"."outcome_source" AS ENUM('CRM_POLL', 'CONTRACTOR_DASHBOARD', 'MANUAL_AUDIT');--> statement-breakpoint
CREATE TYPE "public"."slot_key" AS ENUM('caller_name', 'callback_phone', 'service_address', 'problem_description', 'urgency', 'appointment_window');--> statement-breakpoint
CREATE TYPE "public"."urgency" AS ENUM('ROUTINE', 'SOON', 'SAME_DAY', 'EMERGENCY');--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pending_booking_id" uuid NOT NULL,
	"crm_job_id" text NOT NULL,
	"crm_customer_id" text NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	"completed_polls" smallint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_hours" (
	"tenant_id" uuid NOT NULL,
	"dow" smallint NOT NULL,
	"open" text NOT NULL,
	"close" text NOT NULL,
	"emergency_after_hours" boolean DEFAULT false NOT NULL,
	CONSTRAINT "business_hours_tenant_id_dow_pk" PRIMARY KEY("tenant_id","dow")
);
--> statement-breakpoint
CREATE TABLE "call_turns" (
	"call_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	"role" text NOT NULL,
	"state" "call_state" NOT NULL,
	"text" text NOT NULL,
	"first_word_latency_ms" integer,
	"turn_latency_ms" integer,
	"barge_in" boolean DEFAULT false NOT NULL,
	"turn_take_ok" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_turns_call_id_idx_pk" PRIMARY KEY("call_id","idx")
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_e164" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"locales_detected" "locale"[] DEFAULT '{}' NOT NULL,
	"outcome" "call_outcome",
	"containment" boolean DEFAULT false NOT NULL,
	"recording_url" text,
	"transcript_url" text
);
--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"reason" "escalation_reason" NOT NULL,
	"triggered_at" timestamp with time zone NOT NULL,
	"transferred_to" text,
	"human_ack_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"polled_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"requires_photo" boolean DEFAULT false NOT NULL,
	"emergency_eligible" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"cancelled" boolean DEFAULT false NOT NULL,
	"corrected_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" "outcome_source" NOT NULL,
	"classification" "outcome_classification",
	"classified_by" text,
	"human_label" "outcome_classification",
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "booking_status" DEFAULT 'PENDING' NOT NULL,
	"workflow_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"e164" text NOT NULL,
	"twilio_sid" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"geojson_polygon" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slots" (
	"call_id" uuid NOT NULL,
	"key" "slot_key" NOT NULL,
	"value" jsonb NOT NULL,
	"confidence" real NOT NULL,
	"confirmed_by_caller" boolean DEFAULT false NOT NULL,
	"validator_result" jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "slots_call_id_key_pk" PRIMARY KEY("call_id","key")
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"trade" text NOT NULL,
	"crm_provider" "crm_provider" NOT NULL,
	"crm_credentials_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_pending_booking_id_pending_bookings_id_fk" FOREIGN KEY ("pending_booking_id") REFERENCES "public"."pending_bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_turns" ADD CONSTRAINT "call_turns_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_snapshots" ADD CONSTRAINT "job_snapshots_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_types" ADD CONSTRAINT "job_types_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_bookings" ADD CONSTRAINT "pending_bookings_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_bookings" ADD CONSTRAINT "pending_bookings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_areas" ADD CONSTRAINT "service_areas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slots" ADD CONSTRAINT "slots_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_tenant_started_idx" ON "calls" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE INDEX "job_snapshots_booking_idx" ON "job_snapshots" USING btree ("booking_id","polled_at");--> statement-breakpoint
CREATE INDEX "outcomes_booking_idx" ON "outcomes" USING btree ("booking_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_numbers_e164_key" ON "phone_numbers" USING btree ("e164");