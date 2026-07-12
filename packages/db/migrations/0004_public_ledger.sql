-- Step 9 — publish the number.
--
-- ONE HAND-EDIT, and it is most of the file. `drizzle-kit generate` emitted the enum, the
-- table, and the index below; it cannot emit a function, a REVOKE, or a grant. Those are
-- the entire reason this Step needed a migration rather than a SELECT.
--
--> ---------------------------------------------------------------------------
--> The problem: the number we publish is the only one that has no tenant
--> ---------------------------------------------------------------------------
--
-- Every figure in this system is one contractor's, computed inside `withTenant()` with
-- row-level security underneath it (principle #6). The *published* figure is an aggregate
-- across every tenant — so it cannot be computed that way, and the obvious workaround is a
-- catastrophe: connect as the table owner and count. Postgres exempts an owner from RLS
-- unless the table is FORCEd, and a superuser even then, so that would make the one number
-- we show the world the one produced by the only connection in the system with no isolation
-- at all. `rls.test.ts` has a passing test proving that bypass exists, precisely so that
-- nobody reaches for it — and Step 9 is the step where somebody would have.
--
-- So: a `SECURITY DEFINER` function, owned by the migration runner (the owner, so it sees
-- every tenant's rows), granted to `ledgerline_app` — and whose **return type is a row of
-- counts**. The app role gains the ability to compute the statistic and gains no ability to
-- read a row it could not read a moment ago. That is `Pick<CrmAdapter, "readJob">` and
-- `TriageStore.classify` done in DDL: the signature is the guarantee.
--
--> ---------------------------------------------------------------------------
--> The table (generated)
--> ---------------------------------------------------------------------------

CREATE TYPE "public"."publication_basis" AS ENUM('agent_error', 'raw');--> statement-breakpoint
CREATE TABLE "reliability_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"methodology_version" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenants" integer NOT NULL,
	"calls" integer NOT NULL,
	"committed_bookings" integer NOT NULL,
	"correction_rate" double precision NOT NULL,
	"correction_rate_low" double precision NOT NULL,
	"correction_rate_high" double precision NOT NULL,
	"agent_error_rate" double precision NOT NULL,
	"published_rate" double precision NOT NULL,
	"published_basis" "publication_basis" NOT NULL,
	"published_reason" text NOT NULL,
	"audited_outcomes" integer NOT NULL,
	"triage_agreement_rate" double precision NOT NULL,
	"worst_tenant_correction_rate" double precision NOT NULL,
	"worst_tenant_bookings" integer NOT NULL,
	"observed_coverage" double precision NOT NULL,
	CONSTRAINT "reliability_reports_window_method_key" UNIQUE("window_start","window_end","methodology_version")
);
--> statement-breakpoint
CREATE INDEX "reliability_reports_window_idx" ON "reliability_reports" USING btree ("window_end");--> statement-breakpoint

--> ---------------------------------------------------------------------------
--> The privileges (hand-written)
--> ---------------------------------------------------------------------------

-- **SELECT and INSERT. No UPDATE, no DELETE.** The same pair of mechanisms that protect
-- `outcomes.corrected_fields`: the port has no method for it (`ReportStore`), and the role
-- has no privilege for it (this line). A published reliability figure is evidence about
-- *us*, which is the kind nobody keeps voluntarily — so a quarter we did not like cannot be
-- withdrawn. It can only be followed by another quarter published beside it, and the gaps
-- in this table's history are meant to be visible.
--
-- No RLS on this table: it has no `tenant_id`, and it is read by the public page, which has
-- no tenant and must not have one.
GRANT SELECT, INSERT ON reliability_reports TO ledgerline_app;--> statement-breakpoint

--> ---------------------------------------------------------------------------
--> The cross-tenant aggregate (hand-written)
--> ---------------------------------------------------------------------------

-- `required_polls` is a **parameter, not a literal**, and that is deliberate. How many times
-- a booking is re-read before its outcome is settled is `POLL_OFFSETS_MS.length` —
-- `packages/workflows`' policy, exactly as `pollSchedule()` and `nextDuePoll()` are. A `3`
-- hardcoded here would be a second copy of a product decision, living in a SQL file where
-- nobody would think to look when the schedule changed. Same reasoning already written on
-- `BookingStore`: the store answers the storage question, the caller answers the policy one.
--
-- `SET search_path = public` is not decoration. A SECURITY DEFINER function without a pinned
-- search_path resolves names, with the owner's privileges, against a path the *caller*
-- controls: anyone able to create objects in a schema earlier in that path can shadow a
-- table or an operator this body names and have it run as the owner. It is the most common
-- way this Postgres feature is misused, and the fix is one line.
CREATE FUNCTION app_reliability_cohort(
  window_start timestamptz,
  window_end timestamptz,
  required_polls integer
)
RETURNS TABLE (
  tenants bigint,
  calls bigint,
  committed_bookings bigint,
  immature_bookings bigint,
  corrected_bookings bigint,
  agent_error_bookings bigint,
  audited_outcomes bigint,
  agreed_outcomes bigint,
  worst_tenant_correction_rate double precision,
  worst_tenant_bookings bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH
-- Bookings committed in the window, split by whether their poll schedule has finished.
--
-- **A booking whose polls have not all run cannot show a correction**, so counting it in the
-- denominator dilutes the numerator with bookings that never had a chance to fail — which is
-- to say the newest bookings always flatter us, and a vendor publishing monthly from the
-- first of the month would never have to know they were doing it. Immature bookings leave
-- *both* sides of the ratio and are counted separately, and because that exclusion is itself
-- abusable (a CRM outage stops the polls, and the survivors publish a lovely number),
-- `MIN_OBSERVED_COVERAGE` in `packages/telemetry` makes coverage a publication gate.
  window_bookings AS (
    SELECT b.id, b.tenant_id, b.completed_polls >= required_polls AS matured
    FROM bookings b
    WHERE b.committed_at >= window_start AND b.committed_at < window_end
  ),
  matured AS (SELECT id, tenant_id FROM window_bookings WHERE matured),

-- One row per booking: the last thing we saw. The poller re-reads each job three times, so
-- one corrected booking arrives as up to three `outcomes` rows, and counting rows instead of
-- bookings is what once put `correctionRate` above 1.0 (Step 2, surprise #5). This is
-- `latestPerBooking()` from `contracts`, in SQL.
  latest AS (
    SELECT DISTINCT ON (o.booking_id)
      o.booking_id, o.cancelled, o.corrected_fields, o.classification, o.human_label
    FROM outcomes o
    JOIN matured m ON m.id = o.booking_id
    ORDER BY o.booking_id, o.observed_at DESC
  ),

-- `isCorrected()` and `isAgentError()` from `contracts`, in SQL. These expressions must agree
-- with the TypeScript exactly: `telemetry` puts these bookings in the numerator of the number
-- we publish and `billing` refuses to invoice for them, so a drift here would publish one
-- number and charge for another. `cohort.test.ts` runs both over the same rows.
--
-- `COALESCE(human_label, classification)` is `effectiveLabel()` — **the human wins**. And a
-- NULL label is an agent error rather than an absence of one, so every failure mode of triage
-- (a backlog, an outage, a cron nobody wired up) pushes the published number *up*.
  judged AS (
    SELECT
      l.booking_id,
      m.tenant_id,
      (l.cancelled OR l.corrected_fields <> '{}'::jsonb) AS corrected,
      (COALESCE(l.human_label, l.classification) IS NULL
        OR COALESCE(l.human_label, l.classification) = 'agent_error') AS blamed_on_us,
      (l.human_label IS NOT NULL AND l.classification IS NOT NULL) AS audited,
      (l.human_label IS NOT NULL AND l.classification IS NOT NULL
        AND l.human_label = l.classification) AS agreed
    FROM latest l
    JOIN matured m ON m.id = l.booking_id
  ),

-- The worst single tenant, so nine happy contractors cannot arithmetically bury the tenth.
-- **No tenant id leaves this function** — only the rate, and the count it is over, because
-- "100% corrected" over three bookings is noise and over three hundred is an emergency.
  per_tenant AS (
    SELECT
      m.tenant_id,
      COUNT(*)::bigint AS bookings,
      COUNT(*) FILTER (WHERE j.corrected)::bigint AS corrected
    FROM matured m
    LEFT JOIN judged j ON j.booking_id = m.id
    GROUP BY m.tenant_id
  ),
  worst AS (
    SELECT corrected::double precision / bookings AS rate, bookings
    FROM per_tenant
    WHERE bookings > 0
    ORDER BY rate DESC, bookings DESC
    LIMIT 1
  )

SELECT
  (SELECT COUNT(DISTINCT tenant_id) FROM matured)::bigint,
  (SELECT COUNT(*) FROM calls c
    WHERE c.started_at >= window_start AND c.started_at < window_end)::bigint,
  (SELECT COUNT(*) FROM matured)::bigint,
  (SELECT COUNT(*) FROM window_bookings WHERE NOT matured)::bigint,
  (SELECT COUNT(*) FROM judged WHERE corrected)::bigint,
  (SELECT COUNT(*) FROM judged WHERE corrected AND blamed_on_us)::bigint,
  (SELECT COUNT(*) FROM judged WHERE corrected AND audited)::bigint,
  (SELECT COUNT(*) FROM judged WHERE corrected AND agreed)::bigint,
  COALESCE((SELECT rate FROM worst), 0)::double precision,
  COALESCE((SELECT bookings FROM worst), 0)::bigint
$$;--> statement-breakpoint

-- Postgres grants EXECUTE on a new function to PUBLIC by default. On an ordinary function
-- that is merely untidy; on a SECURITY DEFINER function it hands every role the owner's
-- reach. REVOKE first, then grant to exactly one role.
REVOKE ALL ON FUNCTION app_reliability_cohort(timestamptz, timestamptz, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_reliability_cohort(timestamptz, timestamptz, integer) TO ledgerline_app;
