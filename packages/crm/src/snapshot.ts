import type { TimeWindow } from "@ledgerline/contracts";
import type { CrmJobSnapshot } from "./types.js";

/**
 * Reading a vendor's job body back.
 *
 * Every helper here answers "not observed" rather than throwing. That is the
 * whole design: the poller feeds `outcomes.correctedFields`, and a field we
 * failed to parse must never be reported as a field the contractor corrected.
 * A vendor renaming `work_status` should cost us one blind column, not a crashed
 * poller and a metric that stops moving.
 */

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A non-empty string, or nothing. `""` is absence, not a value. */
export function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Both ends or neither. A half-parsed window is worse than no window: it would
 * diff against the window we booked and report a correction the contractor
 * never made.
 */
export function timeWindow(startsAt: unknown, endsAt: unknown): TimeWindow | null {
  const start = str(startsAt);
  const end = str(endsAt);
  if (start === null || end === null) return null;
  if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) return null;
  return { startsAt: start, endsAt: end };
}

/** Rejoin what `firstName`/`lastName` split apart on the way in. */
export function joinName(first: unknown, last: unknown): string | null {
  const joined = [str(first), str(last)].filter((p) => p !== null).join(" ").trim();
  return joined === "" ? null : joined;
}

/**
 * The job is gone. Housecall Pro says `404`; Jobber says `data.job === null`.
 *
 * Nulls everywhere is the honest answer: we know the booking did not survive,
 * and we know nothing about what its fields looked like when it died. Reporting
 * those as corrections would double-count a cancellation.
 */
export function deletedSnapshot(jobId: string, raw: unknown): CrmJobSnapshot {
  return {
    jobId,
    status: "DELETED",
    window: null,
    description: null,
    address: null,
    customer: { name: null, phone: null },
    raw,
  };
}
