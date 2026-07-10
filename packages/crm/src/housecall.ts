import type { Address, AddressInput, TimeWindow } from "@ledgerline/contracts";
import type { HttpRequest, HttpResponse, HttpTransport } from "./http.js";
import {
  asRecord,
  deletedSnapshot,
  joinName,
  str,
  timeWindow,
} from "./snapshot.js";
import {
  CrmError,
  isRetryableStatus,
  type CrmAdapter,
  type CrmCustomerRef,
  type CrmJobRef,
  type CrmJobSnapshot,
  type CrmJobStatus,
  type CrmLocationRef,
  type CustomerInput,
  type JobInput,
  type OpContext,
} from "./types.js";

const PROVIDER = "housecall_pro" as const;

/**
 * Housecall Pro: REST, customers own their addresses, jobs are deletable.
 */
export class HousecallProAdapter implements CrmAdapter {
  readonly provider = PROVIDER;

  constructor(private readonly http: HttpTransport) {}

  async upsertCustomer(
    input: CustomerInput,
    ctx: OpContext,
  ): Promise<CrmCustomerRef> {
    const found = await this.request({
      method: "GET",
      path: `/customers?q=${encodeURIComponent(input.phone)}`,
    });

    const existing = firstCustomerId(found.body);
    if (existing) return { id: existing, created: false };

    const created = await this.request({
      method: "POST",
      path: "/customers",
      headers: idempotency(ctx),
      body: {
        first_name: firstName(input.name),
        last_name: lastName(input.name),
        mobile_number: input.phone,
        // The contractor reads this; the caller hears their own language.
        notes: `Preferred language: ${input.locale}`,
      },
    });

    return { id: requireId(created.body, "customer"), created: true };
  }

  async ensureServiceLocation(
    customer: CrmCustomerRef,
    address: Address,
    ctx: OpContext,
  ): Promise<CrmLocationRef> {
    const response = await this.request({
      method: "POST",
      path: `/customers/${customer.id}/addresses`,
      headers: idempotency(ctx),
      body: {
        street: address.line1,
        street_line_2: address.line2 ?? null,
        city: address.city,
        state: address.state,
        zip: address.postalCode,
      },
    });

    return { id: requireId(response.body, "address"), created: true };
  }

  async createJob(input: JobInput, ctx: OpContext): Promise<CrmJobRef> {
    const response = await this.request({
      method: "POST",
      path: "/jobs",
      headers: idempotency(ctx),
      body: {
        customer_id: input.customer.id,
        address_id: input.location.id,
        schedule: {
          scheduled_start: input.window.startsAt,
          scheduled_end: input.window.endsAt,
          arrival_window_minutes: 0,
        },
        description: input.description,
        job_fields: { job_type_id: input.jobTypeId },
        tags: [input.urgency],
      },
    });

    return { id: requireId(response.body, "job") };
  }

  async readJob(ref: CrmJobRef, _ctx: OpContext): Promise<CrmJobSnapshot> {
    // A 404 means the contractor deleted the job. We only ever poll ids we
    // created, so there is no other reading, and it is an outcome rather than
    // an error. Every other status still throws — an outage must not be
    // reported as a clean job.
    const response = await this.request(
      { method: "GET", path: `/jobs/${ref.id}` },
      { tolerate: [404] },
    );

    if (response.status === 404) {
      return deletedSnapshot(ref.id, response.body);
    }

    const body = asRecord(response.body);
    return {
      jobId: ref.id,
      status: jobStatus(str(body["work_status"])),
      window: window(asRecord(body["schedule"])),
      description: str(body["description"]),
      address: address(asRecord(body["address"])),
      customer: customer(asRecord(body["customer"])),
      raw: response.body,
    };
  }

  async revokeJob(ref: CrmJobRef, ctx: OpContext): Promise<void> {
    await this.request({
      method: "DELETE",
      path: `/jobs/${ref.id}`,
      headers: idempotency(ctx),
    });
  }

  async revokeCustomer(ref: CrmCustomerRef, ctx: OpContext): Promise<void> {
    // Never delete a customer who predates this call.
    if (!ref.created) return;
    await this.request({
      method: "DELETE",
      path: `/customers/${ref.id}`,
      headers: idempotency(ctx),
    });
  }

  private async request(
    request: HttpRequest,
    options: { tolerate?: readonly number[] } = {},
  ): Promise<HttpResponse> {
    let response: HttpResponse;
    try {
      response = await this.http.send(request);
    } catch (error) {
      // A socket error tells us nothing about whether the write landed, so it
      // is retryable and the idempotency key is what keeps that safe.
      const message = error instanceof Error ? error.message : String(error);
      throw new CrmError(`housecall pro transport: ${message}`, PROVIDER, null, true);
    }

    if (options.tolerate?.includes(response.status)) return response;

    if (response.status >= 400) {
      throw new CrmError(
        `housecall pro ${request.method} ${request.path} -> ${response.status}`,
        PROVIDER,
        response.status,
        isRetryableStatus(response.status),
      );
    }
    return response;
  }
}

const idempotency = (ctx: OpContext) => ({ "Idempotency-Key": ctx.idempotencyKey });

/* -------------------------------------------------------------------------- */
/* Reading a job back                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Housecall Pro's `work_status` is an open-ish vocabulary — `scheduled`,
 * `in progress`, `completed`, `canceled`, `pro canceled`, `needs scheduling`.
 * We match on substrings so a new cancellation flavour lands as `CANCELLED`
 * rather than silently as `SCHEDULED`; under-reporting a cancellation is the
 * error that flatters us.
 *
 * Unverified against a live sandbox — see plan.md Step 4.10.
 */
function jobStatus(workStatus: string | null): CrmJobStatus {
  if (workStatus === null) return "SCHEDULED";
  const status = workStatus.toLowerCase();
  if (status.includes("cancel")) return "CANCELLED";
  if (status.includes("complete")) return "COMPLETED";
  return "SCHEDULED";
}

function window(schedule: Record<string, unknown>): TimeWindow | null {
  return timeWindow(schedule["scheduled_start"], schedule["scheduled_end"]);
}

function address(raw: Record<string, unknown>): AddressInput | null {
  const line1 = str(raw["street"]);
  const city = str(raw["city"]);
  const state = str(raw["state"]);
  const postalCode = str(raw["zip"]);
  if (line1 === null || city === null || state === null || postalCode === null) {
    return null;
  }

  const line2 = str(raw["street_line_2"]);
  return { line1, city, state, postalCode, ...(line2 === null ? {} : { line2 }) };
}

function customer(raw: Record<string, unknown>): CrmJobSnapshot["customer"] {
  return {
    name: joinName(raw["first_name"], raw["last_name"]),
    phone: str(raw["mobile_number"]),
  };
}

function firstCustomerId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const customers = (body as { customers?: unknown }).customers;
  if (!Array.isArray(customers) || customers.length === 0) return null;
  const id = (customers[0] as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function requireId(body: unknown, what: string): string {
  const id =
    typeof body === "object" && body !== null
      ? (body as { id?: unknown }).id
      : undefined;
  if (typeof id !== "string" || id === "") {
    throw new CrmError(`housecall pro returned no ${what} id`, PROVIDER, null, false);
  }
  return id;
}

/**
 * Housecall Pro insists on split names. Callers say "Rosa Delgado" or "Rosa" or
 * "Rosa María Delgado Fuentes"; everything after the first token is the family
 * name, which is right for Spanish compound surnames and harmless otherwise.
 */
export function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? full;
}

export function lastName(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(" ") : "";
}
