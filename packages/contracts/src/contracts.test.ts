import { describe, expect, it } from "vitest";
import {
  CALL_STATES,
  CRITICAL_ASR_SLOTS,
  EMERGENCY_INTERRUPTIBLE_STATES,
  E164Schema,
  HAZARD_ACTIONS,
  HAZARD_CATEGORIES,
  LOW_CONFIDENCE_THRESHOLD,
  PendingBookingPayloadSchema,
  SLOT_KEYS,
  SLOT_SPECS,
  STATE_SPECS,
  TimeWindowSchema,
  type CallState,
} from "./index.js";

describe("slot registry", () => {
  it("has a spec for every key and no extras", () => {
    expect(Object.keys(SLOT_SPECS).sort()).toEqual([...SLOT_KEYS].sort());
  });

  it("keys its specs consistently", () => {
    for (const key of SLOT_KEYS) {
      expect(SLOT_SPECS[key].key).toBe(key);
    }
  });

  it("excludes callback_phone from the ASR metric because it is not spoken", () => {
    expect(CRITICAL_ASR_SLOTS).not.toContain("callback_phone");
    // The plan's "five critical slots" — name, address, problem, urgency, window.
    expect(CRITICAL_ASR_SLOTS).toHaveLength(5);
  });

  it("always confirms the slots whose errors cost a truck roll or a lost SMS", () => {
    for (const key of [
      "service_address",
      "callback_phone",
      "appointment_window",
    ] as const) {
      expect(SLOT_SPECS[key].confirmation).toBe("always");
    }
  });

  it("gives every slot an extraction schema", () => {
    // `packages/extraction` derives the model's tool schema from this. A slot
    // without one has no defined output space for the model.
    for (const key of SLOT_KEYS) {
      expect(SLOT_SPECS[key].extraction).toBeDefined();
    }
  });

  it("never lets the model produce a geocoder-owned or validator-owned value", () => {
    // The extraction schema is deliberately narrower than the storage schema.
    // These two assertions are the boundary; widening either hands the model a
    // job that `packages/validators` is supposed to do (principle #3).
    expect(SLOT_SPECS.service_address.extraction.safeParse({
      line1: "1 Main St",
      city: "Austin",
      state: "TX",
      postalCode: "78704",
      formatted: "hallucinated",
      lat: 30.2,
      lng: -97.7,
    }).success).toBe(true);
    expect(
      SLOT_SPECS.service_address.extraction.parse({
        line1: "1 Main St",
        city: "Austin",
        state: "TX",
        postalCode: "78704",
        formatted: "hallucinated",
      }),
    ).not.toHaveProperty("formatted");

    // Spoken digits, not E.164 — `validatePhone` owns the normalisation.
    expect(SLOT_SPECS.callback_phone.extraction.safeParse("305 555 0142").success).toBe(true);
    expect(SLOT_SPECS.callback_phone.schema.safeParse("305 555 0142").success).toBe(false);
  });
});

describe("state graph", () => {
  it("has a spec for every state", () => {
    expect(Object.keys(STATE_SPECS).sort()).toEqual([...CALL_STATES].sort());
  });

  it("terminates exactly at CLOSE and HANDOFF", () => {
    const terminal = CALL_STATES.filter((s) => STATE_SPECS[s].terminal);
    expect(terminal.sort()).toEqual(["CLOSE", "HANDOFF"]);
  });

  it("gives terminal states no successor and non-terminal states one", () => {
    for (const s of CALL_STATES) {
      const spec = STATE_SPECS[s];
      expect(spec.next === null).toBe(spec.terminal);
    }
  });

  it("reaches every state from GREETING", () => {
    const seen = new Set<CallState>();
    const walk = (s: CallState): void => {
      if (seen.has(s)) return;
      seen.add(s);
      const next = STATE_SPECS[s].next;
      if (next) walk(next);
    };
    walk("GREETING");
    // EMERGENCY is entered by interrupt, not by a `next` edge.
    walk("EMERGENCY");
    expect([...seen].sort()).toEqual([...CALL_STATES].sort());
  });

  it("reaches CLOSE from GREETING without passing through HANDOFF", () => {
    const path: CallState[] = [];
    let cur: CallState | null = "GREETING";
    while (cur) {
      path.push(cur);
      cur = STATE_SPECS[cur].next;
    }
    expect(path).toEqual([
      "GREETING",
      "IDENTIFY",
      "TRIAGE",
      "QUALIFY",
      "SCHEDULE",
      "CONFIRM",
      "CLOSE",
    ]);
  });

  it("collects every slot across the happy path before CONFIRM", () => {
    const collected = new Set<string>();
    for (const s of ["IDENTIFY", "TRIAGE", "QUALIFY", "SCHEDULE"] as const) {
      for (const k of STATE_SPECS[s].requiredSlots) collected.add(k);
    }
    expect([...collected].sort()).toEqual([...SLOT_KEYS].sort());
  });

  it("guards CONFIRM on read-back rather than leaving it implicit", () => {
    expect(STATE_SPECS.CONFIRM.guards).toContain("all_confirmations_satisfied");
  });

  it("lets the emergency classifier interrupt every live state", () => {
    // Interrupting a terminal state, or EMERGENCY itself, is meaningless.
    expect([...EMERGENCY_INTERRUPTIBLE_STATES].sort()).toEqual(
      ["CONFIRM", "GREETING", "IDENTIFY", "QUALIFY", "SCHEDULE", "TRIAGE"].sort(),
    );
  });

  it("focuses only on slots it requires", () => {
    for (const s of CALL_STATES) {
      const { focus, requiredSlots } = STATE_SPECS[s];
      if (focus) expect(requiredSlots).toContain(focus);
    }
  });
});

describe("hazards", () => {
  it("assigns an action to every category", () => {
    expect(Object.keys(HAZARD_ACTIONS).sort()).toEqual(
      [...HAZARD_CATEGORIES].sort(),
    );
  });

  it("reads 911 guidance for the life-safety hazards", () => {
    for (const h of ["GAS_LEAK", "CARBON_MONOXIDE", "FIRE"] as const) {
      expect(HAZARD_ACTIONS[h]).toBe("DIAL_911_GUIDANCE");
    }
  });
});

describe("primitives", () => {
  it.each(["+14155552671", "+523312345678", "+919876543210"])(
    "accepts E.164 %s",
    (n) => {
      expect(E164Schema.safeParse(n).success).toBe(true);
    },
  );

  it.each([
    ["missing plus", "14155552671"],
    ["leading zero country code", "+04155552671"],
    ["letters", "+1415555CALL"],
    ["too long", "+1234567890123456"],
    ["empty", ""],
  ])("rejects E.164 %s", (_label, n) => {
    expect(E164Schema.safeParse(n).success).toBe(false);
  });

  it("rejects a time window that ends before it starts", () => {
    const r = TimeWindowSchema.safeParse({
      startsAt: "2026-07-09T18:00:00.000Z",
      endsAt: "2026-07-09T16:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a zero-length time window", () => {
    const r = TimeWindowSchema.safeParse({
      startsAt: "2026-07-09T16:00:00.000Z",
      endsAt: "2026-07-09T16:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });

  it("sets the low-confidence threshold where read-back kicks in", () => {
    expect(LOW_CONFIDENCE_THRESHOLD).toBeGreaterThan(0.5);
    expect(LOW_CONFIDENCE_THRESHOLD).toBeLessThan(1);
  });
});

describe("PendingBookingPayload", () => {
  const valid = {
    callId: "3f8c1e6a-1b2c-4d5e-8f90-1a2b3c4d5e6f",
    tenantId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    customer: {
      name: "Rosa Delgado",
      phone: "+13055551234",
      locale: "es" as const,
    },
    address: {
      line1: "1247 Calle Ocho",
      city: "Miami",
      state: "FL",
      postalCode: "33135",
      formatted: "1247 Calle Ocho, Miami, FL 33135",
    },
    problemDescription: "Water heater leaking into the garage",
    urgency: "SAME_DAY" as const,
    window: {
      startsAt: "2026-07-09T18:00:00.000Z",
      endsAt: "2026-07-09T22:00:00.000Z",
    },
    jobTypeId: null,
  };

  it("accepts a fully-specified booking", () => {
    expect(PendingBookingPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a non-E.164 customer phone", () => {
    const r = PendingBookingPayloadSchema.safeParse({
      ...valid,
      customer: { ...valid.customer, phone: "305-555-1234" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects an inverted appointment window", () => {
    const r = PendingBookingPayloadSchema.safeParse({
      ...valid,
      window: { startsAt: valid.window.endsAt, endsAt: valid.window.startsAt },
    });
    expect(r.success).toBe(false);
  });

  it("strips nothing it should keep: geocoded coordinates survive parsing", () => {
    const parsed = PendingBookingPayloadSchema.parse({
      ...valid,
      address: { ...valid.address, lat: 25.7651, lng: -80.2197 },
    });
    expect(parsed.address.lat).toBeCloseTo(25.7651);
  });
});
