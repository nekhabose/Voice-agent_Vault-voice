import type { Address, Locale, TimeWindow, Urgency } from "@ledgerline/contracts";

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
