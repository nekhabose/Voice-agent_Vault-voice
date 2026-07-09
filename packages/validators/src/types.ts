import type { ValidatorResult } from "@ledgerline/contracts";

/**
 * A validator turns whatever the extractor heard into a canonical value, or
 * explains why it cannot.
 *
 * The normalized value is returned separately from the verdict so an
 * `unavailable` validator can still hand back a usable — if unverified — value.
 * The slot's `always`-confirm policy is what protects us in that case.
 */
export interface Validation<T> {
  readonly result: ValidatorResult;
  /** Canonical value. Absent only when `result.status === "invalid"`. */
  readonly value: T | null;
}

export const accepted = <T>(value: T): Validation<T> => ({
  result: { status: "valid" },
  value,
});

export const rejected = <T>(reason: string): Validation<T> => ({
  result: { status: "invalid", reason },
  value: null,
});

/** Validator could not run; the value stands, unverified. */
export const unverified = <T>(value: T, reason: string): Validation<T> => ({
  result: { status: "unavailable", reason },
  value,
});

/** Re-exported so validator call sites have one import for their vocabulary. */
export { systemClock, fixedClock, type Clock } from "@ledgerline/contracts";
