import { describe, expect, it } from "vitest";
import {
  FakeTransport,
  FetchTransport,
  type Address,
  type FakeHandler,
  type HttpResponse,
  type TimeWindow,
} from "@ledgerline/contracts";
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

/** What Housecall Pro answers for `GET /jobs/job_1`, as we booked it. */
const HOUSECALL_JOB = {
  id: "job_1",
  work_status: "scheduled",
  description: "Water heater leaking into the garage",
  schedule: { scheduled_start: WINDOW.startsAt, scheduled_end: WINDOW.endsAt },
  address: {
    street: ADDRESS.line1,
    street_line_2: null,
    city: ADDRESS.city,
    state: ADDRESS.state,
    zip: ADDRESS.postalCode,
  },
  customer: { first_name: "Rosa", last_name: "Delgado", mobile_number: "(305) 555-1234" },
};

/** The same job, as Jobber answers it. */
const JOBBER_JOB = {
  id: "job_1",
  jobStatus: "upcoming",
  startAt: WINDOW.startsAt,
  endAt: WINDOW.endsAt,
  instructions: "Water heater leaking into the garage",
  client: {
    firstName: "Rosa",
    lastName: "Delgado",
    phones: [{ number: "(305) 555-1234" }],
  },
  property: {
    address: {
      street1: ADDRESS.line1,
      street2: null,
      city: ADDRESS.city,
      province: ADDRESS.state,
      postalCode: ADDRESS.postalCode,
    },
  },
};

function housecallHandler(existingCustomer: boolean): FakeHandler {
  return (req) => {
    if (req.method === "GET" && req.path.startsWith("/customers?")) {
      return ok({ customers: existingCustomer ? [{ id: "cust_existing" }] : [] });
    }
    if (req.method === "GET" && req.path.startsWith("/jobs/")) return ok(HOUSECALL_JOB);
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
      case "JobById":
        return ok({ data: { job: JOBBER_JOB } });
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

interface HarnessSpec {
  readonly make: HarnessFactory;
  readonly handler: (existing: boolean) => FakeHandler;
  /**
   * How this vendor spells "the contractor cancelled the job", and how it
   * spells "the contractor deleted it". Two vocabularies, one outcome — that
   * translation is precisely what the adapter is for, so the shared suite
   * supplies the vendor words and asserts on our own.
   */
  readonly cancelledJob: FakeHandler;
  readonly deletedJob: FakeHandler;
  /** A job body carrying nothing but an id — the vendor renamed every field. */
  readonly unparseableJob: FakeHandler;
}

const HARNESSES: Record<string, HarnessSpec> = {
  "Housecall Pro": {
    make: (h) => {
      const transport = new FakeTransport(h);
      return { adapter: new HousecallProAdapter(transport), transport };
    },
    handler: housecallHandler,
    cancelledJob: () => ok({ ...HOUSECALL_JOB, work_status: "pro canceled" }),
    deletedJob: () => ({ status: 404, body: { error: "not found" } }),
    unparseableJob: () => ok({ id: "job_1" }),
  },
  Jobber: {
    make: (h) => {
      const transport = new FakeTransport(h);
      return { adapter: new JobberAdapter(transport), transport };
    },
    handler: jobberHandler,
    // Jobber has no job deletion, so `revokeJob` archives — and an archived job
    // is what a cancelled booking reads back as.
    cancelledJob: () => ok({ data: { job: { ...JOBBER_JOB, jobStatus: "archived" } } }),
    deletedJob: () => ok({ data: { job: null } }),
    unparseableJob: () => ok({ data: { job: { id: "job_1" } } }),
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

  it("reads a job back in our vocabulary, not the vendor's", async () => {
    const { adapter } = happy(false);
    const snapshot = await adapter.readJob({ id: "job_1" }, CTX);

    expect(snapshot).toMatchObject({
      jobId: "job_1",
      status: "SCHEDULED",
      description: "Water heater leaking into the garage",
      window: { startsAt: WINDOW.startsAt, endsAt: WINDOW.endsAt },
      address: {
        line1: ADDRESS.line1,
        city: ADDRESS.city,
        state: ADDRESS.state,
        postalCode: ADDRESS.postalCode,
      },
      customer: { name: "Rosa Delgado", phone: "(305) 555-1234" },
    });
  });

  it("never reports the geocoder's own output as if the CRM had returned it", async () => {
    const { adapter } = happy(false);
    const snapshot = await adapter.readJob({ id: "job_1" }, CTX);

    // `formatted`, `lat`, `lng` are principle #3's output, not any vendor's.
    // A snapshot that carried them would diff against the booking we sent and
    // report a corrected address on every single job.
    expect(snapshot.address).not.toHaveProperty("formatted");
    expect(snapshot.address).not.toHaveProperty("lat");
    expect(snapshot.address).not.toHaveProperty("lng");
  });

  it("keeps the vendor payload verbatim, so anyone can recount", async () => {
    const { adapter } = happy(false);
    const snapshot = await adapter.readJob({ id: "job_1" }, CTX);
    expect(snapshot.raw).toBeTruthy();
  });

  it("reports a cancelled job as CANCELLED whatever the vendor calls it", async () => {
    const { adapter } = spec.make(spec.cancelledJob);
    const snapshot = await adapter.readJob({ id: "job_1" }, CTX);
    expect(snapshot.status).toBe("CANCELLED");
  });

  it("reports a deleted job as DELETED, not as an error", async () => {
    // Housecall Pro answers 404; Jobber answers `data.job: null`. Both mean the
    // booking did not survive contact with the contractor, which is ground
    // truth rather than a fault.
    const { adapter } = spec.make(spec.deletedJob);
    const snapshot = await adapter.readJob({ id: "job_1" }, CTX);

    expect(snapshot.status).toBe("DELETED");
    expect(snapshot.address).toBeNull();
    expect(snapshot.window).toBeNull();
    expect(snapshot.description).toBeNull();
  });

  it("throws on an outage rather than reporting a clean job", async () => {
    // The single most dangerous bug in this package would be swallowing a 503
    // here: the poller would record "no corrections" and the published
    // reliability number would be a perfect score computed from an outage.
    const { adapter } = spec.make(() => ({ status: 503, body: null }));
    await expect(adapter.readJob({ id: "job_1" }, CTX)).rejects.toMatchObject({
      name: "CrmError",
      retryable: true,
    });
  });

  it("throws when the transport dies mid-poll", async () => {
    const { adapter } = spec.make(() => {
      throw new Error("ECONNRESET");
    });
    await expect(adapter.readJob({ id: "job_1" }, CTX)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it("degrades a renamed vendor field to null, never to a correction", async () => {
    // A field we cannot parse was not observed. Reporting it as changed would
    // let a vendor's schema change read as an agent that suddenly got
    // everything wrong.
    const { adapter } = spec.make(spec.unparseableJob);
    const snapshot = await adapter.readJob({ id: "job_1" }, CTX);

    expect(snapshot.status).toBe("SCHEDULED");
    expect(snapshot.window).toBeNull();
    expect(snapshot.description).toBeNull();
    expect(snapshot.address).toBeNull();
    expect(snapshot.customer).toEqual({ name: null, phone: null });
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

  it.each([
    ["canceled", "CANCELLED"],
    // Matched on a substring, so a cancellation flavour we have not seen lands
    // as CANCELLED rather than silently as SCHEDULED. Under-reporting a
    // cancellation is the error that flatters us.
    ["pro canceled", "CANCELLED"],
    ["completed", "COMPLETED"],
    ["in progress", "SCHEDULED"],
    ["needs scheduling", "SCHEDULED"],
  ])("maps work_status %s to %s", async (workStatus, expected) => {
    const { adapter } = make(() => ok({ ...HOUSECALL_JOB, work_status: workStatus }));
    expect((await adapter.readJob({ id: "job_1" }, CTX)).status).toBe(expected);
  });

  it("carries line2 through only when the vendor sent one", async () => {
    const { adapter } = make(() =>
      ok({ ...HOUSECALL_JOB, address: { ...HOUSECALL_JOB.address, street_line_2: "Apt 2" } }),
    );
    expect((await adapter.readJob({ id: "job_1" }, CTX)).address).toMatchObject({
      line2: "Apt 2",
    });
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

  it.each([
    ["archived", "CANCELLED"],
    ["requires_invoicing", "COMPLETED"],
    ["completed", "COMPLETED"],
    ["upcoming", "SCHEDULED"],
    ["late", "SCHEDULED"],
  ])("maps jobStatus %s to %s", async (jobStatus, expected) => {
    const { adapter } = make(() => ok({ data: { job: { ...JOBBER_JOB, jobStatus } } }));
    expect((await adapter.readJob({ id: "job_1" }, CTX)).status).toBe(expected);
  });

  it("reads the description from instructions, never from the truncated title", async () => {
    // `createJob` writes `title: description.slice(0, 100)`. Diffing on the
    // title would report a corrected problem description on every booking whose
    // description ran long.
    const long = "x".repeat(150);
    const { adapter } = make(() =>
      ok({ data: { job: { ...JOBBER_JOB, title: long.slice(0, 100), instructions: long } } }),
    );
    expect((await adapter.readJob({ id: "job_1" }, CTX)).description).toBe(long);
  });

  it("reads the client's first phone number", async () => {
    const { adapter } = make(jobberHandler(false));
    expect((await adapter.readJob({ id: "job_1" }, CTX)).customer.phone).toBe("(305) 555-1234");
  });

  it("survives a client with no phones array at all", async () => {
    const { adapter } = make(() =>
      ok({ data: { job: { ...JOBBER_JOB, client: { firstName: "Rosa" } } } }),
    );
    expect((await adapter.readJob({ id: "job_1" }, CTX)).customer).toEqual({
      name: "Rosa",
      phone: null,
    });
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
