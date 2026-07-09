import { describe, expect, it } from "vitest";
import type { Address, TimeWindow } from "@ledgerline/contracts";
import { FakeTransport, FetchTransport, type FakeHandler, type HttpResponse } from "./http.js";
import { HousecallProAdapter, firstName, lastName } from "./housecall.js";
import { JobberAdapter } from "./jobber.js";
import { CrmError, isRetryableStatus, type CrmAdapter, type OpContext } from "./types.js";

const CTX: OpContext = { idempotencyKey: "call_abc123" };

const ADDRESS: Address = {
  line1: "1247 Calle Ocho",
  city: "Miami",
  state: "FL",
  postalCode: "33135",
  formatted: "1247 Calle Ocho, Miami, FL 33135",
};

const WINDOW: TimeWindow = {
  startsAt: "2026-07-09T18:00:00.000Z",
  endsAt: "2026-07-09T22:00:00.000Z",
};

const CUSTOMER = {
  name: "Rosa Delgado",
  phone: "+13055551234",
  locale: "es",
} as const;

const ok = (body: unknown): HttpResponse => ({ status: 200, body });

/* -------------------------------------------------------------------------- */
/* Fake back ends                                                              */
/* -------------------------------------------------------------------------- */

function housecallHandler(existingCustomer: boolean): FakeHandler {
  return (req) => {
    if (req.method === "GET" && req.path.startsWith("/customers?")) {
      return ok({ customers: existingCustomer ? [{ id: "cust_existing" }] : [] });
    }
    if (req.method === "POST" && req.path === "/customers") return ok({ id: "cust_new" });
    if (req.method === "POST" && req.path.endsWith("/addresses")) return ok({ id: "addr_1" });
    if (req.method === "POST" && req.path === "/jobs") return ok({ id: "job_1" });
    if (req.method === "DELETE") return { status: 204, body: null };
    throw new Error(`unexpected request ${req.method} ${req.path}`);
  };
}

/** Which GraphQL operation a request carries. */
function operationOf(body: unknown): string {
  const query = (body as { query?: string }).query ?? "";
  return /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "unknown";
}

function jobberHandler(existingCustomer: boolean): FakeHandler {
  return (req) => {
    switch (operationOf(req.body)) {
      case "ClientsByPhone":
        return ok({
          data: { clients: { nodes: existingCustomer ? [{ id: "cl_existing" }] : [] } },
        });
      case "ClientCreate":
        return ok({ data: { clientCreate: { client: { id: "cl_new" }, userErrors: [] } } });
      case "PropertyCreate":
        return ok({
          data: { propertyCreate: { property: { id: "prop_1" }, userErrors: [] } },
        });
      case "JobCreate":
        return ok({ data: { jobCreate: { job: { id: "job_1" }, userErrors: [] } } });
      case "JobCancel":
        return ok({ data: { jobCancel: { job: { id: "job_1" }, userErrors: [] } } });
      case "ClientArchive":
        return ok({ data: { clientArchive: { client: { id: "cl_new" }, userErrors: [] } } });
      default:
        throw new Error(`unexpected operation: ${operationOf(req.body)}`);
    }
  };
}

interface Harness {
  adapter: CrmAdapter;
  transport: FakeTransport;
}

type HarnessFactory = (handler: FakeHandler) => Harness;

const HARNESSES: Record<string, { make: HarnessFactory; handler: (existing: boolean) => FakeHandler }> = {
  "Housecall Pro": {
    make: (h) => {
      const transport = new FakeTransport(h);
      return { adapter: new HousecallProAdapter(transport), transport };
    },
    handler: housecallHandler,
  },
  Jobber: {
    make: (h) => {
      const transport = new FakeTransport(h);
      return { adapter: new JobberAdapter(transport), transport };
    },
    handler: jobberHandler,
  },
};

/* -------------------------------------------------------------------------- */
/* The contract — every adapter must satisfy this, identically                 */
/* -------------------------------------------------------------------------- */

describe.each(Object.entries(HARNESSES))("CrmAdapter contract: %s", (_name, spec) => {
  const happy = (existing = false) => spec.make(spec.handler(existing));

  it("creates a customer that does not exist yet", async () => {
    const { adapter } = happy(false);
    const ref = await adapter.upsertCustomer(CUSTOMER, CTX);
    expect(ref.id).toBeTruthy();
    expect(ref.created).toBe(true);
  });

  it("reuses a customer who already called before", async () => {
    const { adapter } = happy(true);
    const ref = await adapter.upsertCustomer(CUSTOMER, CTX);
    expect(ref.created).toBe(false);
  });

  it("books a job end to end", async () => {
    const { adapter } = happy(false);
    const customer = await adapter.upsertCustomer(CUSTOMER, CTX);
    const location = await adapter.ensureServiceLocation(customer, ADDRESS, CTX);
    const job = await adapter.createJob(
      {
        customer,
        location,
        window: WINDOW,
        description: "Water heater leaking into the garage",
        urgency: "SAME_DAY",
        jobTypeId: null,
      },
      CTX,
    );
    expect(job.id).toBeTruthy();
  });

  it("revokes a job without caring how the vendor spells it", async () => {
    const { adapter, transport } = happy(false);
    await adapter.revokeJob({ id: "job_1" }, CTX);
    expect(transport.requests.length).toBe(1);
  });

  it("never deletes a customer it did not create", async () => {
    const { adapter, transport } = happy(true);
    await adapter.revokeCustomer({ id: "cust_existing", created: false }, CTX);
    // Deleting a customer who predates the call turns a failed booking into
    // data loss. The compensating step must be a no-op.
    expect(transport.requests).toEqual([]);
  });

  it("deletes a customer it did create", async () => {
    const { adapter, transport } = happy(false);
    await adapter.revokeCustomer({ id: "cust_new", created: true }, CTX);
    expect(transport.requests.length).toBe(1);
  });

  it("marks a transport failure retryable — the write may have landed", async () => {
    const { adapter } = spec.make(() => {
      throw new Error("ECONNRESET");
    });
    await expect(adapter.upsertCustomer(CUSTOMER, CTX)).rejects.toMatchObject({
      name: "CrmError",
      retryable: true,
    });
  });

  it("marks a 503 retryable", async () => {
    const { adapter } = spec.make(() => ({ status: 503, body: null }));
    await expect(adapter.upsertCustomer(CUSTOMER, CTX)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("marks a 400 permanent — retrying will not fix a bad request", async () => {
    const { adapter } = spec.make(() => ({ status: 400, body: { error: "bad" } }));
    await expect(adapter.upsertCustomer(CUSTOMER, CTX)).rejects.toMatchObject({
      retryable: false,
    });
  });

  it("threads the idempotency key into every write", async () => {
    const { adapter, transport } = happy(false);
    await adapter.upsertCustomer(CUSTOMER, CTX);
    const writes = transport.requests.filter((r) => r.method === "POST");
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(JSON.stringify(write.headers)).toContain(CTX.idempotencyKey);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Housecall Pro specifics                                                     */
/* -------------------------------------------------------------------------- */

describe("HousecallProAdapter", () => {
  const make = (h: FakeHandler) => HARNESSES["Housecall Pro"]!.make(h);

  it("looks the customer up by phone before creating one", async () => {
    const { adapter, transport } = make(housecallHandler(false));
    await adapter.upsertCustomer(CUSTOMER, CTX);
    expect(transport.requests[0]!.method).toBe("GET");
    expect(transport.requests[0]!.path).toContain(encodeURIComponent(CUSTOMER.phone));
  });

  it("maps the appointment window onto the schedule fields", async () => {
    const { adapter, transport } = make(housecallHandler(false));
    await adapter.createJob(
      {
        customer: { id: "c1", created: true },
        location: { id: "a1", created: true },
        window: WINDOW,
        description: "No hot water",
        urgency: "EMERGENCY",
        jobTypeId: "jt_1",
      },
      CTX,
    );
    expect(transport.requests[0]!.body).toMatchObject({
      customer_id: "c1",
      address_id: "a1",
      schedule: { scheduled_start: WINDOW.startsAt, scheduled_end: WINDOW.endsAt },
      tags: ["EMERGENCY"],
    });
  });

  it("fails loudly when the vendor returns no id", async () => {
    const { adapter } = make((req) =>
      req.method === "GET" ? ok({ customers: [] }) : ok({ status: "queued" }),
    );
    await expect(adapter.upsertCustomer(CUSTOMER, CTX)).rejects.toThrow(CrmError);
  });

  it("deletes the job on revoke", async () => {
    const { adapter, transport } = make(housecallHandler(false));
    await adapter.revokeJob({ id: "job_1" }, CTX);
    expect(transport.requests[0]).toMatchObject({ method: "DELETE", path: "/jobs/job_1" });
  });
});

describe("name splitting", () => {
  it.each([
    ["Rosa Delgado", "Rosa", "Delgado"],
    ["Rosa", "Rosa", ""],
    // Spanish compound surnames stay together rather than being truncated.
    ["Rosa María Delgado Fuentes", "Rosa", "María Delgado Fuentes"],
    ["  Rosa   Delgado  ", "Rosa", "Delgado"],
  ])("splits %s", (full, first, last) => {
    expect(firstName(full)).toBe(first);
    expect(lastName(full)).toBe(last);
  });
});

/* -------------------------------------------------------------------------- */
/* Jobber specifics — the traits that shaped the interface                     */
/* -------------------------------------------------------------------------- */

describe("JobberAdapter", () => {
  const make = (h: FakeHandler) => HARNESSES["Jobber"]!.make(h);

  it("creates a Property before a Job can reference it", async () => {
    const { adapter, transport } = make(jobberHandler(false));
    const customer = await adapter.upsertCustomer(CUSTOMER, CTX);
    const location = await adapter.ensureServiceLocation(customer, ADDRESS, CTX);
    await adapter.createJob(
      {
        customer,
        location,
        window: WINDOW,
        description: "No hot water",
        urgency: "SAME_DAY",
        jobTypeId: null,
      },
      CTX,
    );

    expect(transport.requests.map((r) => operationOf(r.body))).toEqual([
      "ClientsByPhone",
      "ClientCreate",
      "PropertyCreate",
      "JobCreate",
    ]);
  });

  it("treats a 200 carrying GraphQL errors as a failure", async () => {
    const { adapter } = make(() => ok({ errors: [{ message: "Invalid phone" }] }));
    await expect(adapter.upsertCustomer(CUSTOMER, CTX)).rejects.toMatchObject({
      retryable: false,
      status: 200,
    });
  });

  it("keeps a throttled 200 retryable, or a busy afternoon drops bookings", async () => {
    const { adapter } = make(() =>
      ok({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }),
    );
    await expect(adapter.upsertCustomer(CUSTOMER, CTX)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("surfaces userErrors from an otherwise successful mutation", async () => {
    const { adapter } = make((req) =>
      operationOf(req.body) === "ClientsByPhone"
        ? ok({ data: { clients: { nodes: [] } } })
        : ok({ data: { clientCreate: { client: null, userErrors: [{ message: "phone taken" }] } } }),
    );
    await expect(adapter.upsertCustomer(CUSTOMER, CTX)).rejects.toThrow(/phone taken/);
  });

  it("cancels rather than deletes, since Jobber has no job deletion", async () => {
    const { adapter, transport } = make(jobberHandler(false));
    await adapter.revokeJob({ id: "job_1" }, CTX);
    expect(operationOf(transport.requests[0]!.body)).toBe("JobCancel");
  });

  it("archives rather than deletes a customer", async () => {
    const { adapter, transport } = make(jobberHandler(false));
    await adapter.revokeCustomer({ id: "cl_new", created: true }, CTX);
    expect(operationOf(transport.requests[0]!.body)).toBe("ClientArchive");
  });

  it("rejects a body with neither data nor errors", async () => {
    const { adapter } = make(() => ok({}));
    await expect(adapter.upsertCustomer(CUSTOMER, CTX)).rejects.toThrow(/no data/);
  });
});

/* -------------------------------------------------------------------------- */
/* FetchTransport                                                              */
/* -------------------------------------------------------------------------- */

describe("FetchTransport", () => {
  /** Swap in a fetch that records its call and replies with `reply`. */
  function withFetch(reply: { status: number; text: string }) {
    const seen: { url: string; init: RequestInit }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return { status: reply.status, text: async () => reply.text };
    }) as unknown as typeof fetch;
    return { seen, restore: () => void (globalThis.fetch = original) };
  }

  it("prefixes the base url and serialises the body", async () => {
    const { seen, restore } = withFetch({ status: 200, text: '{"id":"job_1"}' });
    try {
      const transport = new FetchTransport("https://api.example.com", {
        authorization: "Bearer t",
      });
      const response = await transport.send({
        method: "POST",
        path: "/jobs",
        body: { a: 1 },
      });

      expect(response).toEqual({ status: 200, body: { id: "job_1" } });
      expect(seen[0]!.url).toBe("https://api.example.com/jobs");
      expect(seen[0]!.init.body).toBe('{"a":1}');
      expect(seen[0]!.init.headers).toMatchObject({
        "content-type": "application/json",
        authorization: "Bearer t",
      });
    } finally {
      restore();
    }
  });

  it("returns null for an empty body, as a 204 delete does", async () => {
    const { restore } = withFetch({ status: 204, text: "" });
    try {
      const transport = new FetchTransport("https://api.example.com");
      const response = await transport.send({ method: "DELETE", path: "/jobs/1" });
      expect(response).toEqual({ status: 204, body: null });
    } finally {
      restore();
    }
  });

  it("passes non-JSON bodies through rather than throwing", async () => {
    // A gateway timeout page is HTML. Parsing must not turn a 504 into a crash.
    const { restore } = withFetch({ status: 504, text: "<html>gateway timeout</html>" });
    try {
      const transport = new FetchTransport("https://api.example.com");
      const response = await transport.send({ method: "GET", path: "/customers" });
      expect(response).toEqual({ status: 504, body: "<html>gateway timeout</html>" });
    } finally {
      restore();
    }
  });

  it("omits the body entirely on a GET", async () => {
    const { seen, restore } = withFetch({ status: 200, text: "{}" });
    try {
      await new FetchTransport("https://x").send({ method: "GET", path: "/c" });
      expect(seen[0]!.init.body).toBeUndefined();
    } finally {
      restore();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Retry classification                                                        */
/* -------------------------------------------------------------------------- */

describe("isRetryableStatus", () => {
  it.each([408, 425, 429, 500, 502, 503, 504, 599])("retries %i", (s) => {
    expect(isRetryableStatus(s)).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 422])("gives up on %i", (s) => {
    expect(isRetryableStatus(s)).toBe(false);
  });
});
