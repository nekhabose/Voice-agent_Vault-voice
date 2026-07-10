import { describe, expect, it } from "vitest";
import type { Address, HazardDetection, SlotKey } from "@ledgerline/contracts";
import {
  ALLOW_ALL_SERVICE_AREAS,
  BLOCK,
  PASS,
  initialContext,
  isContained,
  isTerminal,
  makeGuards,
  nextPrompt,
  run,
  transition,
  type Effect,
  type MachineContext,
  type MachineEvent,
  type MachineOptions,
} from "./machine.js";
import { VALID, invalid } from "./slot-book.js";

const ADDRESS: Address = {
  line1: "1247 Calle Ocho",
  city: "Miami",
  state: "FL",
  postalCode: "33135",
  formatted: "1247 Calle Ocho, Miami, FL 33135",
  lat: 25.7651,
  lng: -80.2197,
};

const WINDOW = {
  startsAt: "2026-07-09T18:00:00.000Z",
  endsAt: "2026-07-09T22:00:00.000Z",
};

const OPTS: MachineOptions = { guards: makeGuards(ALLOW_ALL_SERVICE_AREAS) };

const GAS_LEAK: HazardDetection = {
  category: "GAS_LEAK",
  action: "DIAL_911_GUIDANCE",
  matchedText: "huele a gas",
  ruleId: "es.gas.smell",
};

const FLOOD: HazardDetection = {
  category: "FLOODING",
  action: "WARM_TRANSFER",
  matchedText: "basement is flooding",
  ruleId: "en.water.flooding",
};

/** A high-confidence, validator-approved fill of `key`. */
function fillEvent(
  key: SlotKey,
  value: unknown,
  confidence = 0.99,
): MachineEvent {
  return { type: "SLOT_FILLED", key, value, input: { confidence, validatorResult: VALID } };
}

const confirm = (key: Parameters<typeof fillEvent>[0]): MachineEvent => ({
  type: "SLOT_CONFIRMED",
  key,
});

/** Every event needed to reach CONFIRM with everything read back. */
function fullHappyPath(): MachineEvent[] {
  return [
    { type: "AGENT_GREETED" },
    fillEvent("caller_name", "Rosa Delgado"),
    fillEvent("callback_phone", "+13055551234"),
    fillEvent("problem_description", "Water heater leaking into the garage"),
    fillEvent("urgency", "SAME_DAY"),
    fillEvent("service_address", ADDRESS),
    fillEvent("appointment_window", WINDOW),
    confirm("callback_phone"),
    confirm("service_address"),
    confirm("appointment_window"),
  ];
}

const effectTypes = (effects: readonly Effect[]) => effects.map((e) => e.type);

describe("initial context", () => {
  it("starts in GREETING with nothing established", () => {
    const ctx = initialContext();
    expect(ctx.state).toBe("GREETING");
    expect(ctx.outcome).toBeNull();
    expect(ctx.escalation).toBeNull();
    expect(ctx.slots.filled()).toEqual([]);
    expect(isTerminal(ctx)).toBe(false);
    expect(isContained(ctx)).toBe(false);
  });
});

describe("GREETING", () => {
  it("holds until the greeting has actually been spoken", () => {
    const r = transition(initialContext(), fillEvent("caller_name", "Rosa"), OPTS);
    // The name is recorded, but the call has not left GREETING.
    expect(r.context.state).toBe("GREETING");
    expect(r.context.slots.get("caller_name")?.value).toBe("Rosa");
  });

  /**
   * A call opens with no event at all, so the worker asks the machine what to
   * say. If this returns nothing, nobody ever speaks the AI disclosure, and the
   * `greeting_delivered` guard deadlocks the call rather than skipping it.
   */
  it("tells the runtime to greet before anything has happened", () => {
    expect(nextPrompt(initialContext())).toEqual([{ type: "GREET" }]);
  });

  it("keeps asking for the greeting while it has not landed", () => {
    const r = transition(initialContext(), fillEvent("caller_name", "Rosa"), OPTS);
    expect(r.effects).toEqual([{ type: "GREET" }]);
  });

  it("says nothing more once the call is over", () => {
    const ctx = transition(initialContext(), { type: "CALLER_HUNG_UP" }, OPTS).context;
    expect(nextPrompt(ctx)).toEqual([]);
  });

  it("advances to IDENTIFY once greeted, and asks for the name", () => {
    const r = transition(initialContext(), { type: "AGENT_GREETED" }, OPTS);
    expect(r.transitions).toEqual(["IDENTIFY"]);
    expect(r.effects).toEqual([{ type: "ASK_FOR", key: "caller_name" }]);
  });
});

describe("the happy path", () => {
  it("walks GREETING → CLOSE and emits exactly one pending booking", () => {
    let ctx = initialContext();
    const seen: string[] = [];
    let bookings = 0;

    for (const event of fullHappyPath()) {
      const r = transition(ctx, event, OPTS);
      expect(r.rejection).toBeNull();
      seen.push(...r.transitions);
      bookings += r.effects.filter((e) => e.type === "CREATE_PENDING_BOOKING").length;
      ctx = r.context;
    }

    expect(seen).toEqual([
      "IDENTIFY",
      "TRIAGE",
      "QUALIFY",
      "SCHEDULE",
      "CONFIRM",
      "CLOSE",
    ]);
    expect(bookings).toBe(1);
    expect(ctx.outcome).toBe("BOOKED");
    expect(isTerminal(ctx)).toBe(true);
    expect(isContained(ctx)).toBe(true);
  });

  it("asks for one thing at a time, never a menu", () => {
    let ctx = transition(initialContext(), { type: "AGENT_GREETED" }, OPTS).context;
    for (const event of fullHappyPath().slice(1)) {
      const r = transition(ctx, event, OPTS);
      const prompts = r.effects.filter(
        (e) => e.type === "ASK_FOR" || e.type === "READ_BACK",
      );
      expect(prompts.length).toBeLessThanOrEqual(1);
      ctx = r.context;
    }
  });
});

describe("out-of-order slot fills", () => {
  it("crosses four states on a single volunteered utterance", () => {
    // "Hi, it's Rosa at 1247 Calle Ocho, my heater's dead, can someone come
    // Thursday morning?" — the caller front-loads everything.
    let ctx = transition(initialContext(), { type: "AGENT_GREETED" }, OPTS).context;
    expect(ctx.state).toBe("IDENTIFY");

    ctx = run(
      ctx,
      [
        fillEvent("service_address", ADDRESS),
        fillEvent("problem_description", "Heater is dead"),
        fillEvent("urgency", "SAME_DAY"),
        fillEvent("appointment_window", WINDOW),
        fillEvent("caller_name", "Rosa Delgado"),
      ],
      OPTS,
    );

    // Still IDENTIFY: the phone number is the one thing nobody said.
    expect(ctx.state).toBe("IDENTIFY");

    const r = transition(ctx, fillEvent("callback_phone", "+13055551234"), OPTS);
    // Now four states fall at once.
    expect(r.transitions).toEqual(["TRIAGE", "QUALIFY", "SCHEDULE", "CONFIRM"]);
    expect(r.context.state).toBe("CONFIRM");
  });

  it("does not ask for a slot the caller already volunteered", () => {
    let ctx = transition(initialContext(), { type: "AGENT_GREETED" }, OPTS).context;
    const r = transition(ctx, fillEvent("caller_name", "Rosa"), OPTS);
    // Name is in; the only thing left in IDENTIFY is the phone.
    expect(r.effects).toEqual([{ type: "ASK_FOR", key: "callback_phone" }]);
  });

  it("falls back off the focus slot when focus is already satisfied", () => {
    // TRIAGE focuses problem_description; supply it first and urgency is next.
    let ctx = run(
      initialContext(),
      [
        { type: "AGENT_GREETED" },
        fillEvent("caller_name", "Rosa"),
        fillEvent("problem_description", "No hot water"),
      ],
      OPTS,
    );
    const r = transition(ctx, fillEvent("callback_phone", "+13055551234"), OPTS);
    expect(r.context.state).toBe("TRIAGE");
    expect(r.effects).toEqual([{ type: "ASK_FOR", key: "urgency" }]);
  });
});

describe("CONFIRM gate", () => {
  it("blocks CLOSE until every always-confirm slot is read back", () => {
    const events = fullHappyPath();
    // Drop the final confirmation.
    const ctx = run(initialContext(), events.slice(0, -1), OPTS);
    expect(ctx.state).toBe("CONFIRM");
    expect(ctx.slots.pendingConfirmations()).toEqual(["appointment_window"]);

    const r = transition(ctx, confirm("appointment_window"), OPTS);
    expect(r.transitions).toEqual(["CLOSE"]);
    expect(effectTypes(r.effects)).toContain("CREATE_PENDING_BOOKING");
  });

  it("reads back pending slots one at a time, in canonical order", () => {
    const ctx = run(initialContext(), fullHappyPath().slice(0, 7), OPTS);
    expect(ctx.state).toBe("CONFIRM");
    const r = transition(ctx, confirm("callback_phone"), OPTS);
    expect(r.effects).toEqual([{ type: "READ_BACK", key: "service_address" }]);
  });

  it("also demands read-back of a low-confidence name", () => {
    let ctx = run(
      initialContext(),
      [
        { type: "AGENT_GREETED" },
        fillEvent("caller_name", "Rosa", 0.4), // heard poorly
        fillEvent("callback_phone", "+13055551234"),
        fillEvent("problem_description", "No hot water"),
        fillEvent("urgency", "SAME_DAY"),
        fillEvent("service_address", ADDRESS),
        fillEvent("appointment_window", WINDOW),
      ],
      OPTS,
    );
    expect(ctx.slots.pendingConfirmations()).toEqual([
      "caller_name",
      "callback_phone",
      "service_address",
      "appointment_window",
    ]);
  });

  it("rejects confirming a slot that was never filled", () => {
    const ctx = transition(initialContext(), { type: "AGENT_GREETED" }, OPTS).context;
    const r = transition(ctx, confirm("service_address"), OPTS);
    expect(r.rejection).toContain("no value to confirm");
    expect(r.context.state).toBe("IDENTIFY");
  });
});

describe("backtracking", () => {
  it("pulls the call back from the brink of CLOSE when the caller changes the time", () => {
    // Everything read back except the very last confirmation is in place.
    let ctx = run(initialContext(), fullHappyPath().slice(0, -1), OPTS);
    expect(ctx.state).toBe("CONFIRM");

    const later = {
      startsAt: "2026-07-10T18:00:00.000Z",
      endsAt: "2026-07-10T22:00:00.000Z",
    };
    const r = transition(ctx, fillEvent("appointment_window", later), OPTS);

    expect(r.context.state).toBe("CONFIRM");
    expect(r.context.outcome).toBeNull();
    expect(effectTypes(r.effects)).not.toContain("CREATE_PENDING_BOOKING");
    // And it re-reads the new window back to them.
    expect(r.effects).toEqual([{ type: "READ_BACK", key: "appointment_window" }]);
  });

  it("refuses to reopen a call that already closed", () => {
    const ctx = run(initialContext(), fullHappyPath(), OPTS);
    expect(ctx.state).toBe("CLOSE");
    // A terminal call ignores further events rather than corrupting itself.
    const r = transition(ctx, fillEvent("caller_name", "Someone Else"), OPTS);
    expect(r.rejection).toBe("call is over");
    expect(r.context).toBe(ctx);
  });

  it("revokes the confirmation of a corrected slot and reads it back again", () => {
    // Confirm the phone and the address, leaving only the window outstanding.
    let ctx = run(initialContext(), fullHappyPath().slice(0, -1), OPTS);
    expect(ctx.slots.get("service_address")?.confirmedByCaller).toBe(true);

    // Now the caller remembers the apartment number.
    const corrected = { ...ADDRESS, line2: "Apt 4" };
    const r = transition(ctx, fillEvent("service_address", corrected), OPTS);

    expect(r.context.slots.get("service_address")?.confirmedByCaller).toBe(false);
    expect(r.context.state).toBe("CONFIRM");
    // The caller must hear the corrected value, or the truck goes to the wrong
    // door with a confirmation on file that was never given.
    expect(r.effects).toEqual([{ type: "READ_BACK", key: "service_address" }]);
    expect(effectTypes(r.effects)).not.toContain("CREATE_PENDING_BOOKING");
  });

  it("un-confirms on retraction and holds the call in CONFIRM", () => {
    let ctx = run(initialContext(), fullHappyPath().slice(0, -1), OPTS);
    ctx = transition(ctx, { type: "SLOT_RETRACTED", key: "service_address" }, OPTS).context;
    expect(ctx.state).toBe("CONFIRM");
    expect(ctx.slots.pendingConfirmations()).toContain("service_address");
  });
});

describe("emergency interrupt", () => {
  it("bypasses the graph from any live state within one turn", () => {
    for (const prefix of [
      [] as MachineEvent[],
      [{ type: "AGENT_GREETED" } as MachineEvent],
      fullHappyPath().slice(0, 5),
      fullHappyPath().slice(0, -1),
    ]) {
      const ctx = run(initialContext(), prefix, OPTS);
      const r = transition(ctx, { type: "HAZARD_DETECTED", detection: GAS_LEAK }, OPTS);
      expect(r.context.state).toBe("EMERGENCY");
      expect(r.context.escalation).toEqual({
        reason: "EMERGENCY_HAZARD",
        hazard: GAS_LEAK,
      });
      expect(r.effects[0]).toEqual({
        type: "ESCALATE",
        reason: "EMERGENCY_HAZARD",
        action: "DIAL_911_GUIDANCE",
        hazard: GAS_LEAK,
      });
    }
  });

  it("reads life-safety guidance before it hands off", () => {
    let ctx = transition(initialContext(), { type: "AGENT_GREETED" }, OPTS).context;
    ctx = transition(ctx, { type: "HAZARD_DETECTED", detection: GAS_LEAK }, OPTS).context;
    expect(ctx.state).toBe("EMERGENCY");

    const r = transition(ctx, { type: "HAZARD_GUIDANCE_DELIVERED" }, OPTS);
    expect(r.transitions).toEqual(["HANDOFF"]);
    expect(r.context.outcome).toBe("ESCALATED_EMERGENCY");
    expect(isTerminal(r.context)).toBe(true);
    expect(isContained(r.context)).toBe(false);
  });

  it("warm-transfers non-life-safety hazards instead of reading 911 guidance", () => {
    const ctx = transition(initialContext(), { type: "AGENT_GREETED" }, OPTS).context;
    const r = transition(ctx, { type: "HAZARD_DETECTED", detection: FLOOD }, OPTS);
    expect(r.effects[0]).toMatchObject({ action: "WARM_TRANSFER" });
  });

  it("never books a job on a call that hit a hazard", () => {
    let ctx = run(initialContext(), fullHappyPath().slice(0, -1), OPTS);
    ctx = transition(ctx, { type: "HAZARD_DETECTED", detection: GAS_LEAK }, OPTS).context;
    ctx = transition(ctx, { type: "HAZARD_GUIDANCE_DELIVERED" }, OPTS).context;
    expect(ctx.outcome).toBe("ESCALATED_EMERGENCY");
    expect(isContained(ctx)).toBe(false);
  });

  it("ignores a hazard raised after the call is already over", () => {
    const ctx = run(initialContext(), fullHappyPath(), OPTS);
    const r = transition(ctx, { type: "HAZARD_DETECTED", detection: GAS_LEAK }, OPTS);
    expect(r.rejection).toBe("call is over");
    expect(r.context.outcome).toBe("BOOKED");
  });
});

describe("service-area guard", () => {
  const OUT_OF_AREA: MachineOptions = {
    guards: makeGuards(() => ({ kind: "escalate", reason: "OUT_OF_SERVICE_AREA" })),
  };

  it("escalates rather than stalling the caller in QUALIFY", () => {
    const ctx = run(
      initialContext(),
      [
        { type: "AGENT_GREETED" },
        fillEvent("caller_name", "Rosa"),
        fillEvent("callback_phone", "+13055551234"),
        fillEvent("problem_description", "No hot water"),
        fillEvent("urgency", "SAME_DAY"),
      ],
      OUT_OF_AREA,
    );
    expect(ctx.state).toBe("QUALIFY");

    const r = transition(ctx, fillEvent("service_address", ADDRESS), OUT_OF_AREA);
    expect(r.context.state).toBe("HANDOFF");
    expect(r.context.outcome).toBe("OUT_OF_SERVICE_AREA");
    expect(r.effects).toContainEqual({
      type: "ESCALATE",
      reason: "OUT_OF_SERVICE_AREA",
      action: "DECLINE",
      hazard: null,
    });
  });

  it("holds in QUALIFY when the guard merely blocks", () => {
    const PENDING: MachineOptions = { guards: makeGuards(() => BLOCK) };
    const ctx = run(
      initialContext(),
      [
        { type: "AGENT_GREETED" },
        fillEvent("caller_name", "Rosa"),
        fillEvent("callback_phone", "+13055551234"),
        fillEvent("problem_description", "No hot water"),
        fillEvent("urgency", "SAME_DAY"),
        fillEvent("service_address", ADDRESS),
      ],
      PENDING,
    );
    expect(ctx.state).toBe("QUALIFY");
    expect(ctx.outcome).toBeNull();
  });

  it("passes through when the address is inside the polygon", () => {
    const IN: MachineOptions = { guards: makeGuards(() => PASS) };
    const ctx = run(initialContext(), fullHappyPath(), IN);
    expect(ctx.state).toBe("CLOSE");
  });
});

describe("invalid slot values", () => {
  it("does not advance past a slot whose validator rejected the value", () => {
    let ctx = run(
      initialContext(),
      [
        { type: "AGENT_GREETED" },
        fillEvent("caller_name", "Rosa"),
        fillEvent("callback_phone", "+13055551234"),
        fillEvent("problem_description", "No hot water"),
        fillEvent("urgency", "SAME_DAY"),
      ],
      OPTS,
    );
    const r = transition(
      ctx,
      {
        type: "SLOT_FILLED",
        key: "service_address",
        value: ADDRESS,
        input: { confidence: 0.9, validatorResult: invalid("no such street number") },
      },
      OPTS,
    );
    expect(r.context.state).toBe("QUALIFY");
    expect(r.effects).toEqual([{ type: "ASK_FOR", key: "service_address" }]);
  });

  it("treats a hallucinated shape as an extraction failure, not a fact", () => {
    const ctx = transition(initialContext(), { type: "AGENT_GREETED" }, OPTS).context;
    const r = transition(ctx, fillEvent("callback_phone", "305-555-1234"), OPTS);
    expect(r.rejection).toContain("E.164");
    expect(r.context.slots.has("callback_phone")).toBe(false);
    expect(r.context.extractionFailures.callback_phone).toBe(1);
  });
});

describe("giving up gracefully", () => {
  const GIVE_UP_AT_2: MachineOptions = { ...OPTS, maxExtractionFailures: 2 };

  it("escalates to a human after repeated failures on one slot", () => {
    let ctx = transition(initialContext(), { type: "AGENT_GREETED" }, GIVE_UP_AT_2).context;
    ctx = transition(ctx, { type: "EXTRACTION_FAILED", key: "caller_name" }, GIVE_UP_AT_2).context;
    expect(ctx.state).toBe("IDENTIFY");

    const r = transition(ctx, { type: "EXTRACTION_FAILED", key: "caller_name" }, GIVE_UP_AT_2);
    expect(r.context.state).toBe("HANDOFF");
    expect(r.context.outcome).toBe("ESCALATED_OTHER");
    expect(r.context.escalation?.reason).toBe("REPEATED_EXTRACTION_FAILURE");
    expect(r.effects).toContainEqual({
      type: "ESCALATE",
      reason: "REPEATED_EXTRACTION_FAILURE",
      action: "WARM_TRANSFER",
      hazard: null,
    });
  });

  it("resets the failure count once the slot finally lands", () => {
    let ctx = transition(initialContext(), { type: "AGENT_GREETED" }, GIVE_UP_AT_2).context;
    ctx = transition(ctx, { type: "EXTRACTION_FAILED", key: "caller_name" }, GIVE_UP_AT_2).context;
    ctx = transition(ctx, fillEvent("caller_name", "Rosa"), GIVE_UP_AT_2).context;
    expect(ctx.extractionFailures.caller_name).toBe(0);

    // A later stumble on the same slot therefore does not immediately escalate.
    const r = transition(ctx, { type: "EXTRACTION_FAILED", key: "caller_name" }, GIVE_UP_AT_2);
    expect(r.context.state).toBe("IDENTIFY");
  });

  it("counts failures per slot, not across the call", () => {
    let ctx = transition(initialContext(), { type: "AGENT_GREETED" }, GIVE_UP_AT_2).context;
    ctx = transition(ctx, { type: "EXTRACTION_FAILED", key: "caller_name" }, GIVE_UP_AT_2).context;
    const r = transition(ctx, { type: "EXTRACTION_FAILED", key: "callback_phone" }, GIVE_UP_AT_2);
    expect(r.context.state).toBe("IDENTIFY");
  });
});

describe("caller-driven exits", () => {
  it("hands off on request", () => {
    const ctx = transition(initialContext(), { type: "AGENT_GREETED" }, OPTS).context;
    const r = transition(ctx, { type: "CALLER_REQUESTED_HUMAN" }, OPTS);
    expect(r.context.state).toBe("HANDOFF");
    expect(r.context.outcome).toBe("ESCALATED_OTHER");
    expect(isContained(r.context)).toBe(false);
  });

  it("closes the call on hangup without booking anything", () => {
    const ctx = run(initialContext(), fullHappyPath().slice(0, -1), OPTS);
    const r = transition(ctx, { type: "CALLER_HUNG_UP" }, OPTS);
    expect(r.context.state).toBe("CLOSE");
    expect(r.context.outcome).toBe("CALLER_HUNG_UP");
    expect(effectTypes(r.effects)).not.toContain("CREATE_PENDING_BOOKING");
    expect(isContained(r.context)).toBe(false);
  });
});

describe("purity", () => {
  it("never mutates the context it was given", () => {
    const ctx = initialContext();
    const snapshot: MachineContext = { ...ctx };
    transition(ctx, { type: "AGENT_GREETED" }, OPTS);
    transition(ctx, fillEvent("caller_name", "Rosa"), OPTS);
    expect(ctx).toEqual(snapshot);
    expect(ctx.slots.filled()).toEqual([]);
  });

  it("is deterministic: identical inputs give identical outputs", () => {
    const a = run(initialContext(), fullHappyPath(), OPTS);
    const b = run(initialContext(), fullHappyPath(), OPTS);
    expect(a.state).toBe(b.state);
    expect(a.outcome).toBe(b.outcome);
    expect(a.slots.toRecords()).toEqual(b.slots.toRecords());
  });
});
