import { describe, expect, it } from "vitest";
import { evalDeps } from "./harness.js";
import { MIAMI_FORMATTED, SCENARIOS } from "./scenarios.js";
import { runAll, simulate, score, type Scenario } from "./simulate.js";

const deps = evalDeps();
const find = (name: string): Scenario => {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) throw new Error(`no scenario named ${name}`);
  return s;
};

/* -------------------------------------------------------------------------- */
/* Every scenario, every release                                               */
/* -------------------------------------------------------------------------- */

describe("simulated callers", () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))(
    "%s reaches the expected outcome",
    async (_name, scenario) => {
      const result = await simulate(scenario, deps);
      expect(result.outcome).toBe(scenario.expect.outcome);
      if (scenario.expect.hazard) expect(result.hazard).toBe(scenario.expect.hazard);
    },
  );

  it("scores the whole suite", async () => {
    const { score: s } = await runAll(SCENARIOS, deps);

    expect(s.failures).toEqual([]);
    expect(s.outcomeAccuracy).toBe(1);
    // Critical-slot accuracy is the metric Phase 0 gates the wedge on. Here the
    // extractor is a stub, so this only proves the validators and the machine
    // carry values through intact — not that ASR heard them right.
    expect(s.criticalSlotAccuracy).toBe(1);
    expect(s.scenarios).toBeGreaterThanOrEqual(10);
  });

  it("contains the calls that should be contained, and no others", async () => {
    const { runs } = await runAll(SCENARIOS, deps);
    const contained = runs.filter((r) => r.result.contained).map((r) => r.scenario.name);
    const booked = SCENARIOS.filter((s) => s.expect.outcome === "BOOKED").map((s) => s.name);

    expect(contained.sort()).toEqual(booked.sort());
  });
});

/* -------------------------------------------------------------------------- */
/* The behaviours the plan says decide whether this is a product               */
/* -------------------------------------------------------------------------- */

describe("out-of-order slot fills", () => {
  it("does not re-interrogate a caller who front-loaded everything", async () => {
    const result = await simulate(find("english/volunteers-everything-up-front"), deps);

    expect(result.outcome).toBe("BOOKED");
    // Three caller turns: the dump, the phone number, the confirmation. A phone
    // tree would have taken six.
    expect(result.turnsTaken).toBe(3);
    expect(result.corrections).toBe(0);
  });
});

describe("backtracking", () => {
  it("takes a new appointment time before anything was read back", async () => {
    const result = await simulate(find("english/changes-time-before-confirming"), deps);

    expect(result.outcome).toBe("BOOKED");
    expect(result.corrections).toBe(1);
    expect(result.slots.appointment_window).toContain("2026-07-10");
  });

  it("reopens the confirmation gate when a confirmed address changes", async () => {
    const result = await simulate(
      find("english/corrects-an-address-she-already-confirmed"),
      deps,
    );

    // The address was confirmed, then corrected, then re-confirmed. Had the
    // gate not reopened, the truck would go to the wrong door.
    expect(result.outcome).toBe("BOOKED");
    expect(result.corrections).toBe(1);
    expect(result.slots.service_address).toBe("1247 Calle Ocho Apt 4, Miami, FL 33135");

    // And — the part that matters — the caller actually *heard* the corrected
    // address. Asserting only on the final value would also pass a system that
    // quietly kept the stale confirmation and never read it back.
    const addressReadBacks = result.readBacks.filter((k) => k === "service_address");
    expect(addressReadBacks).toHaveLength(2);
  });

  it("reads a slot back only once when the caller never corrects it", async () => {
    const result = await simulate(find("english/straightforward"), deps);
    expect(result.readBacks.filter((k) => k === "service_address")).toHaveLength(1);
    // Phone, address, window — the three always-confirm slots, once each.
    expect(result.readBacks).toEqual([
      "callback_phone",
      "service_address",
      "appointment_window",
    ]);
  });
});

describe("the emergency classifier interrupts everything", () => {
  it("abandons a half-finished booking on a gas leak", async () => {
    const result = await simulate(find("spanish/gas-leak-mid-call"), deps);

    expect(result.hazard).toBe("GAS_LEAK");
    expect(result.outcome).toBe("ESCALATED_EMERGENCY");
    expect(result.contained).toBe(false);
    // It fired on the caller's second utterance, not after the call ended.
    expect(result.turnsTaken).toBe(2);
  });

  it("uses the weather the caller never mentioned", async () => {
    const freezing = await simulate(find("spanish/no-heat-in-a-freeze"), deps);
    expect(freezing.hazard).toBe("NO_HEAT_FREEZING");
    expect(freezing.outcome).toBe("ESCALATED_EMERGENCY");
  });

  it("treats the same complaint in July as a routine booking", async () => {
    const july = await simulate(find("english/no-heat-in-july"), deps);
    expect(july.hazard).toBeNull();
    expect(july.outcome).toBe("BOOKED");
  });
});

describe("validators gate the graph", () => {
  it("re-asks for an address the geocoder has never heard of", async () => {
    const result = await simulate(find("english/address-not-real"), deps);

    expect(result.rejections.some((r) => r.startsWith("service_address"))).toBe(false);
    // It recovered: the second address is the one that got booked.
    expect(result.outcome).toBe("BOOKED");
    expect(result.slots.service_address).toBe(MIAMI_FORMATTED);
  });

  it("escalates an address outside the service polygon", async () => {
    const result = await simulate(find("english/outside-service-area"), deps);
    expect(result.outcome).toBe("OUT_OF_SERVICE_AREA");
    expect(result.state).toBe("HANDOFF");
  });

  it("stops asking for a phone number it will never hear", async () => {
    const result = await simulate(find("english/unintelligible-phone-number"), deps);

    expect(result.outcome).toBe("ESCALATED_OTHER");
    expect(result.slots.callback_phone).toBeUndefined();
  });
});

describe("caller-driven exits", () => {
  it("hands a caller who asks for a person straight to one", async () => {
    const result = await simulate(find("english/asks-for-a-person"), deps);
    expect(result.outcome).toBe("ESCALATED_OTHER");
    expect(result.turnsTaken).toBe(1);
  });

  it("books nothing when the caller hangs up", async () => {
    const result = await simulate(find("english/hangs-up"), deps);
    expect(result.outcome).toBe("CALLER_HUNG_UP");
    expect(result.contained).toBe(false);
  });
});

describe("code-switching", () => {
  it("books a caller who switches language mid-sentence", async () => {
    const result = await simulate(find("spanish/code-switched"), deps);
    expect(result.outcome).toBe("BOOKED");
    expect(result.slots.caller_name).toBe("Rosa Delgado");
    expect(result.slots.service_address).toBe(MIAMI_FORMATTED);
  });
});

/* -------------------------------------------------------------------------- */
/* Scoring                                                                     */
/* -------------------------------------------------------------------------- */

describe("score", () => {
  it("is vacuously perfect on an empty suite, and reports zero containment", () => {
    const s = score([]);
    expect(s).toMatchObject({
      scenarios: 0,
      containmentRate: 0,
      criticalSlotAccuracy: 1,
      outcomeAccuracy: 1,
    });
  });

  it("names the scenario and the field when a slot comes out wrong", async () => {
    const wrong: Scenario = {
      ...find("english/straightforward"),
      name: "mutant",
      expect: {
        outcome: "BOOKED",
        slots: { caller_name: "Somebody Else" },
      },
    };
    const result = await simulate(wrong, deps);
    const s = score([{ scenario: wrong, result }]);

    expect(s.criticalSlotAccuracy).toBe(0);
    expect(s.failures).toEqual(['mutant: caller_name was "Daniel Okafor"']);
  });

  it("reports an outcome mismatch rather than silently passing", async () => {
    const wrong: Scenario = {
      ...find("english/hangs-up"),
      name: "mutant",
      expect: { outcome: "BOOKED" },
    };
    const result = await simulate(wrong, deps);
    const s = score([{ scenario: wrong, result }]);

    expect(s.outcomeAccuracy).toBe(0);
    expect(s.failures[0]).toContain("expected BOOKED, got CALLER_HUNG_UP");
  });

  it("ignores non-critical slots in the accuracy metric", async () => {
    // callback_phone is prefilled from caller ID, never transcribed, so it
    // cannot contribute ASR error and must not be scored as if it could.
    const scenario: Scenario = {
      ...find("english/straightforward"),
      name: "phone-only",
      expect: { outcome: "BOOKED", slots: { callback_phone: "totally wrong" } },
    };
    const result = await simulate(scenario, deps);
    const s = score([{ scenario, result }]);

    expect(s.criticalSlotAccuracy).toBe(1);
    expect(s.failures).toEqual([]);
  });
});
