import { describe, expect, it } from "vitest";
import {
  BookingStatusSchema,
  CallStateSchema,
  OutcomeClassificationSchema,
  OutcomeSourceSchema,
  PublicationBasisSchema,
  SLOT_KEYS,
  UrgencySchema,
} from "@ledgerline/contracts";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

/**
 * The schema has no database to run against, so these tests do the one thing a
 * schema test can do honestly: prove it has not drifted from `contracts`, and
 * prove the columns the reliability claim rests on exist.
 *
 * They do **not** prove the migration applies. That needs Neon — Step 7.
 */

const columnsOf = (table: PgTable): string[] =>
  getTableConfig(table).columns.map((c) => c.name);

// `Object.values` of the module gives a union of exact table and enum types.
// Widening to `unknown` first is what lets drizzle's own `is()` narrow it.
const TABLE_NAMES = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableConfig(table).name);

describe("plan.md §7 — the tables exist", () => {
  it.each([
    "tenants",
    "phone_numbers",
    "service_areas",
    "business_hours",
    "job_types",
    "calls",
    "call_turns",
    "slots",
    "pending_bookings",
    "bookings",
    "job_snapshots",
    "outcomes",
    "escalations",
  ])("defines %s", (name) => {
    expect(TABLE_NAMES).toContain(name);
  });
});

describe("the four columns that make principles #3 and #5 real", () => {
  it("records that the read-back actually happened", () => {
    // Principle #3 is a claim about the world. This column is its only evidence.
    expect(columnsOf(schema.slots)).toContain("confirmed_by_caller");
  });

  it("records the raw diff, the classification, and the human audit separately", () => {
    const columns = columnsOf(schema.outcomes);
    expect(columns).toContain("corrected_fields");
    expect(columns).toContain("classification");
    expect(columns).toContain("human_label");
  });

  it("leaves classification and human_label nullable", () => {
    // Both are *derived*. The raw diff is written by the poller and never
    // rewritten; Step 6 fills these in later, and a NOT NULL here would force
    // the poller to guess.
    const config = getTableConfig(schema.outcomes);
    const nullable = config.columns.filter((c) => !c.notNull).map((c) => c.name);
    expect(nullable).toEqual(expect.arrayContaining(["classification", "human_label"]));
  });

  it("keeps corrected_fields NOT NULL — an unpolled booking has no outcome row", () => {
    const correctedFields = getTableConfig(schema.outcomes).columns.find(
      (c) => c.name === "corrected_fields",
    );
    expect(correctedFields?.notNull).toBe(true);
  });
});

describe("job_snapshots", () => {
  it("exists because change detection is polled, not webhooked", () => {
    // A missed webhook silently reports a 0% correction rate. Snapshots are how
    // we find a correction nobody told us about.
    expect(columnsOf(schema.jobSnapshots)).toEqual(
      expect.arrayContaining(["booking_id", "polled_at", "payload"]),
    );
  });

  it("gives bookings a poll cursor, so a missed cron still owes its poll", () => {
    expect(columnsOf(schema.bookings)).toContain("completed_polls");
  });
});

describe("reliability_reports — the published figure (Step 9)", () => {
  it("exists", () => {
    expect(TABLE_NAMES).toContain("reliability_reports");
  });

  /**
   * **The absent column, asserted.**
   *
   * Every other table holding anything is tenant-scoped, so a reader who notices this one
   * is not will reach for the obvious fix — and adding a `tenant_id` here would break the
   * public page (which has no tenant, and must not have one) while leaking nothing. That is
   * the worst kind of change: it looks like a security improvement and is a bug. A
   * published figure is an aggregate over *every* tenant, so it belongs to none of them.
   *
   * What keeps a contractor's identity out of it is `MIN_COHORT_TENANTS`, not RLS.
   */
  it("carries no tenant_id, and is not in TENANT_SCOPED_TABLES", () => {
    expect(columnsOf(schema.reliabilityReports)).not.toContain("tenant_id");
    expect([...schema.TENANT_SCOPED_TABLES]).not.toContain("reliability_reports");
  });

  it("records the methodology version, so no trend line crosses a definition change", () => {
    // A correction rate is meaningless without the definition of what counts as a
    // correction. Two figures computed under different versions measure different things.
    expect(columnsOf(schema.reliabilityReports)).toContain("methodology_version");
  });

  it("records the interval and the worst tenant beside the headline rate", () => {
    const columns = columnsOf(schema.reliabilityReports);

    // A point estimate with no interval invites a precision the sample cannot support, and
    // a pooled average with no worst case hides one contractor's disaster behind nine
    // good ones. Both are stored because both are published.
    expect(columns).toEqual(
      expect.arrayContaining([
        "correction_rate",
        "correction_rate_low",
        "correction_rate_high",
        "worst_tenant_correction_rate",
        "worst_tenant_bookings",
        "observed_coverage",
      ]),
    );
  });

  it("names no tenant, not even the worst one", () => {
    expect(columnsOf(schema.reliabilityReports)).not.toContain("worst_tenant_id");
  });
});

describe("enums do not drift from the contracts", () => {
  /**
   * Every `pgEnum` is spread from a Zod schema rather than retyped. These assert
   * the spread actually happened: a hand-written enum that says 'SOON' while
   * `UrgencySchema` has moved on is exactly the silent production bug that
   * defining the domain once is supposed to make impossible.
   */
  it.each([
    ["urgency", schema.urgencyEnum, UrgencySchema.options],
    ["call_state", schema.callStateEnum, CallStateSchema.options],
    ["slot_key", schema.slotKeyEnum, SLOT_KEYS],
    ["booking_status", schema.bookingStatusEnum, BookingStatusSchema.options],
    ["outcome_source", schema.outcomeSourceEnum, OutcomeSourceSchema.options],
    ["outcome_classification", schema.outcomeClassificationEnum, OutcomeClassificationSchema.options],
    ["publication_basis", schema.publicationBasisEnum, PublicationBasisSchema.options],
  ])("%s matches its contract", (_name, pg, contract) => {
    expect(pg.enumValues).toEqual([...contract]);
  });

  it("offers CRM_POLL and no longer offers CRM_WEBHOOK", () => {
    // Webhook delivery is at-most-once. Leaving the variant in the enum is an
    // invitation to wire one up and silently under-report (plan, §7).
    expect(schema.outcomeSourceEnum.enumValues).toContain("CRM_POLL");
    expect(schema.outcomeSourceEnum.enumValues).not.toContain("CRM_WEBHOOK");
  });
});
