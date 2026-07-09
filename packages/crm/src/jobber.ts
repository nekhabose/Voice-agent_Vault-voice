import type { Address } from "@ledgerline/contracts";
import type { HttpResponse, HttpTransport } from "./http.js";
import {
  CrmError,
  isRetryableStatus,
  type CrmAdapter,
  type CrmCustomerRef,
  type CrmJobRef,
  type CrmLocationRef,
  type CustomerInput,
  type JobInput,
  type OpContext,
} from "./types.js";
import { firstName, lastName } from "./housecall.js";

const PROVIDER = "jobber" as const;
const ENDPOINT = "/graphql";

/**
 * Jobber: GraphQL, addresses are first-class `Property` nodes, and jobs cannot
 * be deleted — only cancelled.
 *
 * This adapter exists to keep the interface honest. Three of Jobber's traits
 * would each have broken an interface written against Housecall Pro alone:
 *
 *   1. A job needs a `Property` id, so "create customer then create job" is not
 *      a sufficient vocabulary — hence `ensureServiceLocation`.
 *   2. GraphQL answers `200 OK` and puts the failure in the body, so HTTP status
 *      alone cannot drive the saga's retry decision.
 *   3. There is no job deletion, so compensation is `revokeJob`, not
 *      `deleteJob`. The saga never learns the difference.
 */
export class JobberAdapter implements CrmAdapter {
  readonly provider = PROVIDER;

  constructor(private readonly http: HttpTransport) {}

  async upsertCustomer(
    input: CustomerInput,
    ctx: OpContext,
  ): Promise<CrmCustomerRef> {
    const found = await this.query<{ clients: { nodes: { id: string }[] } }>(
      CLIENTS_BY_PHONE,
      { phone: input.phone },
      ctx,
    );

    const existing = found.clients.nodes[0]?.id;
    if (existing) return { id: existing, created: false };

    const created = await this.mutate<{ clientCreate: MutationResult<"client"> }>(
      CLIENT_CREATE,
      {
        input: {
          firstName: firstName(input.name),
          lastName: lastName(input.name),
          phones: [{ number: input.phone, primary: true }],
          language: input.locale,
        },
      },
      ctx,
      "clientCreate",
    );

    return { id: nodeId(created.clientCreate, "client"), created: true };
  }

  async ensureServiceLocation(
    customer: CrmCustomerRef,
    address: Address,
    ctx: OpContext,
  ): Promise<CrmLocationRef> {
    const created = await this.mutate<{ propertyCreate: MutationResult<"property"> }>(
      PROPERTY_CREATE,
      {
        clientId: customer.id,
        input: {
          address: {
            street1: address.line1,
            street2: address.line2 ?? null,
            city: address.city,
            province: address.state,
            postalCode: address.postalCode,
          },
        },
      },
      ctx,
      "propertyCreate",
    );

    return { id: nodeId(created.propertyCreate, "property"), created: true };
  }

  async createJob(input: JobInput, ctx: OpContext): Promise<CrmJobRef> {
    const created = await this.mutate<{ jobCreate: MutationResult<"job"> }>(
      JOB_CREATE,
      {
        input: {
          clientId: input.customer.id,
          propertyId: input.location.id,
          title: input.description.slice(0, 100),
          instructions: input.description,
          startAt: input.window.startsAt,
          endAt: input.window.endsAt,
          jobType: input.jobTypeId,
        },
      },
      ctx,
      "jobCreate",
    );

    return { id: nodeId(created.jobCreate, "job") };
  }

  /** Jobber has no job deletion; cancelling is how a job stops existing. */
  async revokeJob(ref: CrmJobRef, ctx: OpContext): Promise<void> {
    await this.mutate<{ jobCancel: MutationResult<"job"> }>(
      JOB_CANCEL,
      { id: ref.id },
      ctx,
      "jobCancel",
    );
  }

  async revokeCustomer(ref: CrmCustomerRef, ctx: OpContext): Promise<void> {
    if (!ref.created) return;
    await this.mutate<{ clientArchive: MutationResult<"client"> }>(
      CLIENT_ARCHIVE,
      { id: ref.id },
      ctx,
      "clientArchive",
    );
  }

  private async query<T>(
    query: string,
    variables: Record<string, unknown>,
    ctx: OpContext,
  ): Promise<T> {
    return this.execute<T>(query, variables, ctx);
  }

  private async mutate<T>(
    query: string,
    variables: Record<string, unknown>,
    ctx: OpContext,
    field: keyof T & string,
  ): Promise<T> {
    const data = await this.execute<T>(query, variables, ctx);
    const result = data[field] as MutationResult<string> | undefined;
    const userErrors = result?.userErrors ?? [];
    if (userErrors.length > 0) {
      // A validation failure the caller cannot fix by waiting.
      throw new CrmError(
        `jobber ${field}: ${userErrors.map((e) => e.message).join("; ")}`,
        PROVIDER,
        200,
        false,
      );
    }
    return data;
  }

  private async execute<T>(
    query: string,
    variables: Record<string, unknown>,
    ctx: OpContext,
  ): Promise<T> {
    let response: HttpResponse;
    try {
      response = await this.http.send({
        method: "POST",
        path: ENDPOINT,
        headers: { "X-Request-Id": ctx.idempotencyKey },
        body: { query, variables },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CrmError(`jobber transport: ${message}`, PROVIDER, null, true);
    }

    if (response.status >= 400) {
      throw new CrmError(
        `jobber http ${response.status}`,
        PROVIDER,
        response.status,
        isRetryableStatus(response.status),
      );
    }

    const body = response.body as GraphQlBody<T> | null;

    // GraphQL reports failure inside a 200. Throttling is the one that must
    // stay retryable, or a busy afternoon silently drops bookings.
    if (body?.errors?.length) {
      const throttled = body.errors.some(
        (e) => e.extensions?.code === "THROTTLED",
      );
      throw new CrmError(
        `jobber: ${body.errors.map((e) => e.message).join("; ")}`,
        PROVIDER,
        200,
        throttled,
      );
    }

    if (!body?.data) {
      throw new CrmError("jobber returned no data", PROVIDER, 200, false);
    }
    return body.data;
  }
}

interface GraphQlBody<T> {
  readonly data?: T;
  readonly errors?: { message: string; extensions?: { code?: string } }[];
}

type MutationResult<K extends string> = {
  readonly userErrors?: { message: string }[];
} & { [P in K]?: { id?: string } | null };

function nodeId<K extends string>(result: MutationResult<K>, field: K): string {
  const node = result[field];
  const id = node?.id;
  if (typeof id !== "string" || id === "") {
    throw new CrmError(`jobber returned no ${field} id`, PROVIDER, 200, false);
  }
  return id;
}

/* -------------------------------------------------------------------------- */
/* Documents                                                                   */
/* -------------------------------------------------------------------------- */

const CLIENTS_BY_PHONE = /* GraphQL */ `
  query ClientsByPhone($phone: String!) {
    clients(filter: { phoneNumber: $phone }, first: 1) {
      nodes {
        id
      }
    }
  }
`;

const CLIENT_CREATE = /* GraphQL */ `
  mutation ClientCreate($input: ClientCreateInput!) {
    clientCreate(input: $input) {
      client {
        id
      }
      userErrors {
        message
      }
    }
  }
`;

const PROPERTY_CREATE = /* GraphQL */ `
  mutation PropertyCreate($clientId: EncodedId!, $input: PropertyCreateInput!) {
    propertyCreate(clientId: $clientId, input: $input) {
      property {
        id
      }
      userErrors {
        message
      }
    }
  }
`;

const JOB_CREATE = /* GraphQL */ `
  mutation JobCreate($input: JobCreateInput!) {
    jobCreate(input: $input) {
      job {
        id
      }
      userErrors {
        message
      }
    }
  }
`;

const JOB_CANCEL = /* GraphQL */ `
  mutation JobCancel($id: EncodedId!) {
    jobCancel(id: $id) {
      job {
        id
      }
      userErrors {
        message
      }
    }
  }
`;

const CLIENT_ARCHIVE = /* GraphQL */ `
  mutation ClientArchive($id: EncodedId!) {
    clientArchive(id: $id) {
      client {
        id
      }
      userErrors {
        message
      }
    }
  }
`;
