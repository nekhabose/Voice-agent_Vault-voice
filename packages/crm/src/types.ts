import type {
  Address,
  AddressInput,
  Locale,
  TimeWindow,
  Urgency,
} from "@ledgerline/contracts";

export const CRM_PROVIDERS = ["housecall_pro", "jobber"] as const;
export type CrmProvider = (typeof CRM_PROVIDERS)[number];

/**
 * A handle on a record that lives in someone else's system.
 *
 * `created` is load-bearing: rollback may only delete records *we* created. A
 * compensating step that deletes a customer who existed before the call took a
 * failed booking and turned it into data loss.
 */
export interface CrmCustomerRef {
  readonly id: string;
  readonly created: boolean;
}

/**
 * Where the truck goes.
 *
 * Housecall Pro hangs addresses off a customer; Jobber models them as
 * first-class `Property` nodes that a Job must reference. Naming the concept
 * here — rather than assuming either shape — is the difference between an
 * adapter interface and a rename of one vendor's endpoints.
 */
export interface CrmLocationRef {
  readonly id: string;
  readonly created: boolean;
}

export interface CrmJobRef {
  readonly id: string;
}

export interface CustomerInput {
  readonly name: string;
  /** E.164. Also the natural key we de-duplicate on. */
  readonly phone: string;
  readonly locale: Locale;
}

export interface JobInput {
  readonly customer: CrmCustomerRef;
  readonly location: CrmLocationRef;
  readonly window: TimeWindow;
  readonly description: string;
  readonly urgency: Urgency;
  /** Tenant-defined job type in the CRM's own vocabulary, if resolved. */
  readonly jobTypeId: string | null;
}

/**
 * Passed to every call so retries are safe.
 *
 * The booking saga retries on transient failures, and a retry that creates a
 * second job is worse than the failure it was recovering from.
 */
export interface OpContext {
  readonly idempotencyKey: string;
}

/**
 * What became of a job we created.
 *
 * `DELETED` is not an error. Housecall Pro answers `404` and Jobber answers
 * `data.job === null`; both mean the booking did not survive contact with the
 * contractor, which is ground truth rather than a fault.
 *
 * `COMPLETED` is deliberately not `CANCELLED`. A job that ran is the outcome we
 * wanted, and folding the two together would let a busy week look like a
 * failure.
 */
export const CRM_JOB_STATUSES = [
  "SCHEDULED",
  "COMPLETED",
  "CANCELLED",
  "DELETED",
] as const;
export type CrmJobStatus = (typeof CRM_JOB_STATUSES)[number];

/**
 * The contractor's copy of a job, some time after we wrote it.
 *
 * This is the read side of the wedge: every field here is one the contractor may
 * have silently corrected, and the diff against the `PendingBooking` we sent is
 * the only reliability number that matters (plan, principle #5).
 *
 * Designed against **both** CRMs before either was implemented, and three of the
 * decisions are the interesting part:
 *
 *   1. **`urgency` is absent, on purpose.** Housecall Pro carries it as a job
 *      tag; Jobber has no field for it at all. Including it would make urgency
 *      corrections countable on one provider and structurally invisible on the
 *      other — a per-provider bias baked into the one number we intend to
 *      publish. The same argument retires `jobTypeId`.
 *   2. **`address` is an {@link AddressInput}, not an `Address`.** A CRM echoes
 *      street/city/state/zip. `formatted`, `lat`, and `lng` are our geocoder's
 *      output (principle #3), and no vendor will ever return them — diffing on
 *      `formatted` would report a corrected address on *every single booking*.
 *   3. **Every field is nullable.** A vendor omitting a field is not evidence
 *      the contractor edited it. Absence must never become a correction.
 *
 * `raw` is the vendor's payload, verbatim. It is persisted forever
 * (`job_snapshots`), because classification is a derived column and anyone must
 * be able to recount.
 */
export interface CrmJobSnapshot {
  readonly jobId: string;
  readonly status: CrmJobStatus;
  readonly window: TimeWindow | null;
  readonly description: string | null;
  readonly address: AddressInput | null;
  readonly customer: {
    readonly name: string | null;
    /** As the CRM stores it. Formatting varies; compare on digits. */
    readonly phone: string | null;
  };
  readonly raw: unknown;
}

/**
 * The contract every CRM integration satisfies.
 *
 * Deliberately expressed in our domain, not theirs. Adapters decide how many
 * HTTP calls each of these takes — Housecall Pro needs one round trip to attach
 * an address, Jobber needs a `propertyCreate` mutation, and neither leaks here.
 */
export interface CrmAdapter {
  readonly provider: CrmProvider;

  /** Find a customer by phone, or create one. */
  upsertCustomer(input: CustomerInput, ctx: OpContext): Promise<CrmCustomerRef>;

  /** Attach (or find) the service address for this customer. */
  ensureServiceLocation(
    customer: CrmCustomerRef,
    address: Address,
    ctx: OpContext,
  ): Promise<CrmLocationRef>;

  createJob(input: JobInput, ctx: OpContext): Promise<CrmJobRef>;

  /**
   * Read a job back, long after the call ended. The outcome poller diffs this
   * against the `PendingBooking` we sent.
   *
   * **Throws on an outage rather than reporting a clean job.** This mirrors the
   * geocoder decision in principle #3: unverified is not the same as correct. A
   * poll that swallows a `503` and records "no correction" is the single most
   * dangerous bug in this package, because its symptom is a perfect score.
   */
  readJob(ref: CrmJobRef, ctx: OpContext): Promise<CrmJobSnapshot>;

  /**
   * Undo `createJob`. "Undo" rather than "delete": Jobber has no job deletion,
   * so its adapter cancels. The saga does not care which.
   */
  revokeJob(ref: CrmJobRef, ctx: OpContext): Promise<void>;

  /** Undo `upsertCustomer`. Must be a no-op when `created` is false. */
  revokeCustomer(ref: CrmCustomerRef, ctx: OpContext): Promise<void>;
}

/**
 * `retryable` drives the saga's backoff. Getting this wrong in either direction
 * is expensive: retrying a 400 burns the caller's patience, and giving up on a
 * 429 loses a booked job.
 */
export class CrmError extends Error {
  constructor(
    message: string,
    readonly provider: CrmProvider,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CrmError";
  }
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status) || status >= 500;
}
