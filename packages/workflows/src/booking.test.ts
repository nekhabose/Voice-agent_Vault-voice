import { describe, expect, it } from "vitest";
import { fixedClock, recordingSleep, type PendingBookingPayload } from "@ledgerline/contracts";
import {
  CrmError,
  FakeTransport,
  HousecallProAdapter,
  JobberAdapter,
  type CrmAdapter,
  type CrmCustomerRef,
  type CrmJobRef,
  type CrmLocationRef,
  type CustomerInput,
  type JobInput,
} from "@ledgerline/crm";
import { BOOKING_STEPS, commitBooking, type BookingDeps } from "./booking.js";
import { InMemoryJournal, RollbackFailure, Saga, isTransient } from "./saga.js";
import { FakeSms, confirmationBody, formatWindow } from "./sms.js";

const CALL_ID = "3f8c1e6a-1b2c-4d5e-8f90-1a2b3c4d5e6f";
const PENDING_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

const PAYLOAD: PendingBookingPayload = {
  callId: CALL_ID,
  tenantId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  customer: { name: "Rosa Delgado", phone: "+13055551234", locale: "es" },
  address: {
    line1: "1247 Calle Ocho",
    city: "Miami",
    state: "FL",
    postalCode: "33135",
    formatted: "1247 Calle Ocho, Miami, FL 33135",
  },
  problemDescription: "Water heater leaking into the garage",
  urgency: "SAME_DAY",
  window: { startsAt: "2026-07-09T18:00:00.000Z", endsAt: "2026-07-09T22:00:00.000Z" },
  jobTypeId: null,
};

/* -------------------------------------------------------------------------- */
/* A scriptable CRM                                                            */
/* -------------------------------------------------------------------------- */

type FailureMap = Partial<Record<keyof SpyCrm & string, () => never>>;

/**
 * Records every call and fails wherever the test tells it to. Preferred over a
 * mocking framework: the assertions are about *what the CRM saw*, and this lets
 * us say that in one line.
 */
class SpyCrm implements CrmAdapter {
  readonly provider = "housecall_pro" as const;
  readonly calls: string[] = [];
  customerExists = false;

  constructor(private readonly failures: FailureMap = {}) {}

  private enter(name: keyof FailureMap): void {
    this.calls.push(name);
    this.failures[name]?.();
  }

  async upsertCustomer(_input: CustomerInput): Promise<CrmCustomerRef> {
    this.enter("upsertCustomer");
    return { id: "cust_1", created: !this.customerExists };
  }

  async ensureServiceLocation(): Promise<CrmLocationRef> {
    this.enter("ensureServiceLocation");
    return { id: "addr_1", created: true };
  }

  async createJob(_input: JobInput): Promise<CrmJobRef> {
    this.enter("createJob");
    return { id: "job_1" };
  }

  async revokeJob(): Promise<void> {
    this.enter("revokeJob");
  }

  async revokeCustomer(ref: CrmCustomerRef): Promise<void> {
    this.calls.push("revokeCustomer");
    this.failures.revokeCustomer?.();
    if (!ref.created) this.calls.push("revokeCustomer:skipped");
  }
}

const permanent = () => {
  throw new CrmError("bad request", "housecall_pro", 400, false);
};
const transient = () => {
  throw new CrmError("throttled", "housecall_pro", 429, true);
};

function deps(crm: CrmAdapter, sms = new FakeSms()): BookingDeps & { journal: InMemoryJournal } {
  const journal = new InMemoryJournal();
  return {
    crm,
    sms,
    journal,
    clock: fixedClock("2026-07-08T12:00:00.000Z"),
    timeZone: "America/New_York",
    retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 20 },
    sleep: recordingSleep(),
  };
}

/* -------------------------------------------------------------------------- */
/* Happy path                                                                  */
/* -------------------------------------------------------------------------- */

describe("commitBooking — success", () => {
  it("creates customer, location, and job in order, then texts the caller", async () => {
    const crm = new SpyCrm();
    const sms = new FakeSms();
    const result = await commitBooking(PENDING_ID, PAYLOAD, deps(crm, sms));

    expect(result.status).toBe("COMMITTED");
    expect(crm.calls).toEqual(["upsertCustomer", "ensureServiceLocation", "createJob"]);
    expect(sms.sent).toHaveLength(1);
    expect(sms.sent[0]!.to).toBe("+13055551234");
  });

  it("returns the CRM ids and a committed timestamp", async () => {
    const result = await commitBooking(PENDING_ID, PAYLOAD, deps(new SpyCrm()));
    expect(result).toMatchObject({
      status: "COMMITTED",
      booking: {
        pendingBookingId: PENDING_ID,
        crmCustomerId: "cust_1",
        crmJobId: "job_1",
        committedAt: "2026-07-08T12:00:00.000Z",
      },
      smsDelivered: true,
    });
  });

  // PAYLOAD's customer has `locale: "es"`. The confirmation is still English —
  // the product is English-only, and the locale exists to tell the *contractor*
  // what language to call back in, not to trigger a translation we cannot review.
  it("writes the confirmation in English, whatever locale the caller was tagged with", async () => {
    const sms = new FakeSms();
    await commitBooking(PENDING_ID, PAYLOAD, deps(new SpyCrm(), sms));
    expect(sms.sent[0]!.body).toContain("Confirmed");
    expect(sms.sent[0]!.body).toContain("1247 Calle Ocho");
  });
});

/* -------------------------------------------------------------------------- */
/* Rollback — the test the plan names                                          */
/* -------------------------------------------------------------------------- */

describe("commitBooking — compensating rollback", () => {
  it("undoes the customer when create_job fails, leaving no orphan", async () => {
    // The plan's integration test, verbatim: force a failure at `create_job`
    // after `create_customer` succeeds; assert the compensating step runs and
    // the customer is not orphaned.
    const crm = new SpyCrm({ createJob: permanent });
    const result = await commitBooking(PENDING_ID, PAYLOAD, deps(crm));

    expect(result.status).toBe("ROLLED_BACK");
    expect(crm.calls).toEqual([
      "upsertCustomer",
      "ensureServiceLocation",
      "createJob",
      "revokeCustomer",
    ]);
  });

  it("compensates in reverse order when the job was created but a later step failed", async () => {
    // Prove ordering directly through the Saga, where we can add a failing tail
    // step after `create_job`.
    const crm = new SpyCrm();
    const saga = new Saga({ journal: new InMemoryJournal(), sleep: recordingSleep() });
    const boom = new Error("downstream exploded");

    const customer = await saga.step(
      "create_customer",
      () => crm.upsertCustomer({ name: "R", phone: "+13055551234", locale: "es" }),
      (ref) => crm.revokeCustomer(ref),
    );
    await saga.step("create_job", () => crm.createJob({} as JobInput), () => crm.revokeJob());
    expect(customer.created).toBe(true);

    await saga.rollback(boom);
    expect(crm.calls).toEqual([
      "upsertCustomer",
      "createJob",
      "revokeJob",
      "revokeCustomer",
    ]);
  });

  it("never deletes a customer who already existed before the call", async () => {
    const crm = new SpyCrm({ createJob: permanent });
    crm.customerExists = true;

    const result = await commitBooking(PENDING_ID, PAYLOAD, deps(crm));
    expect(result.status).toBe("ROLLED_BACK");
    // The compensation ran, and correctly did nothing.
    expect(crm.calls).toContain("revokeCustomer:skipped");
  });

  it("does not compensate a step that never ran", async () => {
    const crm = new SpyCrm({ upsertCustomer: permanent });
    const result = await commitBooking(PENDING_ID, PAYLOAD, deps(crm));

    expect(result.status).toBe("ROLLED_BACK");
    expect(crm.calls).toEqual(["upsertCustomer"]);
  });

  it("escalates to a human when the compensation itself fails", async () => {
    const crm = new SpyCrm({ createJob: permanent, revokeCustomer: permanent });
    const result = await commitBooking(PENDING_ID, PAYLOAD, deps(crm));

    expect(result).toMatchObject({ status: "FAILED", needsHumanReview: true });
    expect(result.status === "FAILED" && result.reason).toContain("rollback failed");
  });
});

/* -------------------------------------------------------------------------- */
/* Retries                                                                     */
/* -------------------------------------------------------------------------- */

describe("commitBooking — retries", () => {
  it("retries a throttled call and succeeds on a later attempt", async () => {
    let tries = 0;
    const flaky = new (class extends SpyCrm {
      override async createJob(input: JobInput): Promise<CrmJobRef> {
        tries += 1;
        if (tries < 3) transient();
        return super.createJob(input);
      }
    })();

    const result = await commitBooking(PENDING_ID, PAYLOAD, deps(flaky));

    expect(result.status).toBe("COMMITTED");
    expect(tries).toBe(3);
    // The booking survived, so nothing was compensated.
    expect(flaky.calls).not.toContain("revokeCustomer");
  });

  it("backs off exponentially between attempts", async () => {
    const sleep = recordingSleep();
    const crm = new SpyCrm({ createJob: transient });
    await commitBooking(PENDING_ID, PAYLOAD, {
      ...deps(crm),
      retry: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 250 },
      sleep,
    });
    // 100, 200, then capped at 250.
    expect(sleep.delays).toEqual([100, 200, 250]);
  });

  it("does not retry a permanent failure", async () => {
    const sleep = recordingSleep();
    const crm = new SpyCrm({ createJob: permanent });
    await commitBooking(PENDING_ID, PAYLOAD, { ...deps(crm), sleep });

    expect(sleep.delays).toEqual([]);
    expect(crm.calls.filter((c) => c === "createJob")).toHaveLength(1);
  });

  it("gives up after maxAttempts and rolls back", async () => {
    const crm = new SpyCrm({ createJob: transient });
    const result = await commitBooking(PENDING_ID, PAYLOAD, deps(crm));

    expect(result.status).toBe("ROLLED_BACK");
    expect(crm.calls.filter((c) => c === "createJob")).toHaveLength(3);
    expect(crm.calls).toContain("revokeCustomer");
  });
});

/* -------------------------------------------------------------------------- */
/* Crash safety                                                                */
/* -------------------------------------------------------------------------- */

describe("commitBooking — resume after a crash", () => {
  it("does not double-create when a completed workflow is re-run", async () => {
    const crm = new SpyCrm();
    const shared = deps(crm);

    const first = await commitBooking(PENDING_ID, PAYLOAD, shared);
    expect(first.status).toBe("COMMITTED");

    // The worker died after committing, before marking the row done.
    const second = await commitBooking(PENDING_ID, PAYLOAD, shared);
    expect(second.status).toBe("COMMITTED");

    expect(crm.calls.filter((c) => c === "upsertCustomer")).toHaveLength(1);
    expect(crm.calls.filter((c) => c === "createJob")).toHaveLength(1);
  });

  it("replays only the steps that had not completed", async () => {
    const journal = new InMemoryJournal();
    const crashing = new SpyCrm({ createJob: permanent });
    await commitBooking(PENDING_ID, PAYLOAD, { ...deps(crashing), journal });
    expect(journal.steps).toEqual([BOOKING_STEPS.customer, BOOKING_STEPS.location]);
  });

  it("does not re-send the SMS on resume", async () => {
    const sms = new FakeSms();
    const shared = { ...deps(new SpyCrm()), sms };

    await commitBooking(PENDING_ID, PAYLOAD, shared);
    await commitBooking(PENDING_ID, PAYLOAD, shared);
    expect(sms.sent).toHaveLength(1);
  });

  it("rolls back only once across a resumed rollback", async () => {
    const crm = new SpyCrm({ createJob: permanent });
    const shared = deps(crm);

    await commitBooking(PENDING_ID, PAYLOAD, shared);
    await commitBooking(PENDING_ID, PAYLOAD, shared);

    expect(crm.calls.filter((c) => c === "revokeCustomer")).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* SMS is outside the transaction                                              */
/* -------------------------------------------------------------------------- */

describe("commitBooking — SMS failure", () => {
  it("keeps the booking when the text cannot be delivered", async () => {
    const crm = new SpyCrm();
    const sms = new FakeSms(new Error("carrier rejected"));
    const result = await commitBooking(PENDING_ID, PAYLOAD, deps(crm, sms));

    // Cancelling a correctly-booked job because a carrier hiccuped would turn a
    // notification problem into a lost customer.
    expect(result).toMatchObject({ status: "COMMITTED", smsDelivered: false });
    expect(crm.calls).not.toContain("revokeJob");
    expect(crm.calls).not.toContain("revokeCustomer");
  });
});

/* -------------------------------------------------------------------------- */
/* Payload validation                                                          */
/* -------------------------------------------------------------------------- */

describe("commitBooking — payload validation", () => {
  it("refuses a malformed payload without touching the CRM", async () => {
    const crm = new SpyCrm();
    const result = await commitBooking(
      PENDING_ID,
      { ...PAYLOAD, customer: { ...PAYLOAD.customer, phone: "305-555-1234" } },
      deps(crm),
    );

    expect(result).toMatchObject({ status: "FAILED", needsHumanReview: true });
    expect(crm.calls).toEqual([]);
  });

  it("refuses an inverted appointment window", async () => {
    const result = await commitBooking(
      PENDING_ID,
      { ...PAYLOAD, window: { startsAt: PAYLOAD.window.endsAt, endsAt: PAYLOAD.window.startsAt } },
      deps(new SpyCrm()),
    );
    expect(result.status).toBe("FAILED");
  });
});

/* -------------------------------------------------------------------------- */
/* Against the real adapters                                                   */
/* -------------------------------------------------------------------------- */

describe("commitBooking — against each CRM adapter", () => {
  it("books through Housecall Pro", async () => {
    const transport = new FakeTransport((req) => {
      if (req.method === "GET") return { status: 200, body: { customers: [] } };
      if (req.path === "/customers") return { status: 200, body: { id: "c1" } };
      if (req.path.endsWith("/addresses")) return { status: 200, body: { id: "a1" } };
      if (req.path === "/jobs") return { status: 200, body: { id: "j1" } };
      return { status: 204, body: null };
    });

    const result = await commitBooking(
      PENDING_ID,
      PAYLOAD,
      deps(new HousecallProAdapter(transport)),
    );
    expect(result).toMatchObject({ status: "COMMITTED", booking: { crmJobId: "j1" } });
  });

  it("rolls back through Jobber, cancelling nothing and archiving the new client", async () => {
    const seen: string[] = [];
    const transport = new FakeTransport((req) => {
      const op = /(?:query|mutation)\s+(\w+)/.exec(
        (req.body as { query: string }).query,
      )![1]!;
      seen.push(op);

      switch (op) {
        case "ClientsByPhone":
          return { status: 200, body: { data: { clients: { nodes: [] } } } };
        case "ClientCreate":
          return {
            status: 200,
            body: { data: { clientCreate: { client: { id: "cl_1" }, userErrors: [] } } },
          };
        case "PropertyCreate":
          return {
            status: 200,
            body: { data: { propertyCreate: { property: { id: "p_1" }, userErrors: [] } } },
          };
        case "JobCreate":
          return { status: 400, body: null };
        case "ClientArchive":
          return {
            status: 200,
            body: { data: { clientArchive: { client: { id: "cl_1" }, userErrors: [] } } },
          };
        default:
          throw new Error(`unexpected ${op}`);
      }
    });

    const result = await commitBooking(PENDING_ID, PAYLOAD, deps(new JobberAdapter(transport)));

    expect(result.status).toBe("ROLLED_BACK");
    // The job never existed, so nothing is cancelled; the client we created is.
    expect(seen).not.toContain("JobCancel");
    expect(seen).toContain("ClientArchive");
  });
});

/* -------------------------------------------------------------------------- */
/* Saga primitives                                                             */
/* -------------------------------------------------------------------------- */

describe("isTransient", () => {
  it("is true only for retryable CRM errors", () => {
    expect(isTransient(new CrmError("x", "jobber", 429, true))).toBe(true);
    expect(isTransient(new CrmError("x", "jobber", 400, false))).toBe(false);
    // An unknown error could be anything; assume it will not fix itself.
    expect(isTransient(new Error("boom"))).toBe(false);
    expect(isTransient("boom")).toBe(false);
  });
});

describe("Saga", () => {
  it("skips a journaled step but still registers its compensation", async () => {
    const journal = new InMemoryJournal();
    await journal.record({ step: "a", output: { id: "from_journal" } });

    let ran = false;
    const compensated: string[] = [];
    const saga = new Saga({ journal, sleep: recordingSleep() });

    const out = await saga.step(
      "a",
      async () => {
        ran = true;
        return { id: "fresh" };
      },
      async (o) => {
        compensated.push(o.id);
      },
    );

    expect(ran).toBe(false);
    expect(out).toEqual({ id: "from_journal" });

    await saga.rollback(new Error("later failure"));
    // A resumed step must still be undoable, or rollback silently skips it.
    expect(compensated).toEqual(["from_journal"]);
  });

  it("wraps a failed compensation in RollbackFailure with the original cause", async () => {
    const saga = new Saga({ journal: new InMemoryJournal(), sleep: recordingSleep() });
    const original = new Error("job creation failed");

    await saga.step("a", async () => 1, async () => {
      throw new Error("undo exploded");
    });

    await expect(saga.rollback(original)).rejects.toBeInstanceOf(RollbackFailure);
    await saga.rollback(original).catch((e: RollbackFailure) => {
      expect(e.step).toBe("a");
      expect(e.original).toBe(original);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Message formatting                                                          */
/* -------------------------------------------------------------------------- */

describe("confirmation message", () => {
  const window = PAYLOAD.window;

  it("renders the window in the tenant's timezone, not the server's", () => {
    // 18:00–22:00 UTC is 2–6 PM in Miami.
    const text = formatWindow(window, "America/New_York");
    expect(text).toContain("2:00 PM");
    expect(text).toContain("6:00 PM");
    expect(text).toContain("Thursday");
  });

  it("tells the caller how to cancel", () => {
    expect(confirmationBody("x", window, "America/New_York")).toContain("CANCEL");
  });

  // The product is English-only, but `customer.locale` survives on the payload and
  // reaches the CRM so a human can call back appropriately. Asserting the message
  // ignores it is what stops someone reintroducing a machine-translated SMS that
  // no contractor can proofread.
  it("does not vary with the caller's recorded locale", () => {
    const body = confirmationBody("1247 Ocean Drive", window, "America/New_York");
    expect(body).toContain("Confirmed");
    expect(body).not.toMatch(/Confirmado|CANCELAR/);
  });
});
