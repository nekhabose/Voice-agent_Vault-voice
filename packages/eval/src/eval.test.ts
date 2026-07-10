import type { ExtractionOutcome, SlotExtractor } from "@ledgerline/contracts";
import {
  CALLER_NAME_FILLED,
  FakeExtractor,
  RecordingTransport,
  testClient,
  unavailable,
} from "@ledgerline/extraction";
import { describe, expect, it } from "vitest";
import { anthropicExtractor, scriptFromScenario } from "./extractors.js";
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
    // Critical-slot accuracy is the metric the wedge is scored on. In the PR arm
    // the extractor is `FakeExtractor` scripted from the scenario, so this proves
    // the port, the validators, and the machine carry values through intact — not
    // that `claude-sonnet-5` heard them right. That is the nightly arm (5.1/5.5).
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
/* The real extraction path (Step 5.1)                                         */
/* -------------------------------------------------------------------------- */

describe("the SlotExtractor port, not a baked-in value", () => {
  it("hands each fill's utterance to the extractor, and it is what got booked", async () => {
    const scenario = find("english/straightforward");
    const fake = new FakeExtractor(scriptFromScenario(scenario));
    const result = await simulate(scenario, { ...deps, makeExtractor: () => fake });

    expect(result.outcome).toBe("BOOKED");
    // The collaborator's view: the address slot was extracted from exactly the
    // utterance that stated it, not read out of the scenario. Swap the fake for
    // AnthropicExtractor and this same call goes to the model.
    expect(fake.callsFor("service_address").map((c) => c.utterance)).toEqual([
      "It's 1247 Calle Ocho, Miami, 33135.",
    ]);
    expect(fake.callsFor("caller_name")[0]?.utterance).toBe("Hi, this is Daniel Okafor.");
    // The turn index rides the ExtractionContext, exactly as on a real call, so a
    // per-call value has somewhere to go other than the cached prompt prefix.
    expect(fake.callsFor("appointment_window")[0]?.ctx.turnIndex).toBe(4);
  });

  it("re-extracts a corrected slot from the correction utterance", async () => {
    const scenario = find("english/address-not-real");
    const fake = new FakeExtractor(scriptFromScenario(scenario));
    const result = await simulate(scenario, { ...deps, makeExtractor: () => fake });

    expect(result.outcome).toBe("BOOKED");
    // Two address utterances, two extractor calls — the geocoder-rejected first
    // try and the fix. The port is asked again, not handed a second baked value.
    expect(fake.callsFor("service_address").map((c) => c.utterance)).toEqual([
      "It's 9999 Nowhere Lane.",
      "Sorry — 1247 Calle Ocho.",
    ]);
  });

  it("retries an extraction outage once, then escalates as AGENT_ERROR", async () => {
    // The model is down on the first ask and the retry: a human's problem, never
    // a caller re-asked their name (principle #3). Mirrors CallRuntime exactly.
    const down: SlotExtractor = { extract: async () => unavailable("503 from Anthropic") };
    const result = await simulate(find("english/straightforward"), {
      ...deps,
      makeExtractor: () => down,
    });

    expect(result.outcome).toBe("AGENT_ERROR");
    expect(result.contained).toBe(false);
  });

  it("recovers when the retry succeeds behind the filler", async () => {
    const scenario = find("english/straightforward");
    const script = scriptFromScenario(scenario);
    // Down on the first ask for the name, up on the retry; everything else as
    // scripted. One transient outage must not lose the call.
    const fake = new FakeExtractor({
      ...script,
      caller_name: [unavailable("transient"), ...(script.caller_name as ExtractionOutcome[])],
    });
    const result = await simulate(scenario, { ...deps, makeExtractor: () => fake });

    expect(result.outcome).toBe("BOOKED");
    expect(result.slots.caller_name).toBe("Daniel Okafor");
  });
});

describe("the nightly arm binds the real AnthropicExtractor", () => {
  // Not a live model call: the SDK's `fetch` is injected and answers from a
  // committed wire body, exactly as `packages/extraction`'s own replay suite
  // does. What this proves that the fake cannot is that the eval harness drives
  // the *real* extractor end to end — the cached request it builds, the tool_use
  // block it interprets — and the value flows through the validators and the
  // machine. The live-model version (re-recording fixtures, asserting the cache
  // hits) is task 5.5, and it belongs in the nightly arm, never in `npm test`.
  it("drives a real cached request and books on the value the model returned", async () => {
    const transport = new RecordingTransport((body) => {
      const name = (body.tool_choice as { name?: string }).name;
      if (name === "record_caller_name") return { json: CALLER_NAME_FILLED };
      throw new Error(`unscripted tool ${name}`);
    });

    const scenario: Scenario = {
      name: "nightly/name-then-human",
      turns: [
        { text: "Hi, it's Dana Whitfield.", fills: [{ key: "caller_name", raw: "unused" }] },
        { text: "Actually, can I talk to a person?", requestsHuman: true },
      ],
      expect: { outcome: "ESCALATED_OTHER" },
    };

    const result = await simulate(scenario, {
      ...deps,
      makeExtractor: anthropicExtractor(testClient(transport)),
    });

    // The stored name is what the model's tool_use returned, not the fill's raw.
    expect(result.slots.caller_name).toBe("Dana Whitfield");
    expect(result.outcome).toBe("ESCALATED_OTHER");
    // And the request the real extractor built is cache-safe: thinking pinned off.
    expect(transport.only.thinking).toEqual({ type: "disabled" });
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
    const result = await simulate(find("hazard/spanish-utterance-on-an-english-line"), deps);

    expect(result.hazard).toBe("GAS_LEAK");
    expect(result.outcome).toBe("ESCALATED_EMERGENCY");
    expect(result.contained).toBe(false);
    // It fired on the caller's second utterance, not after the call ended.
    expect(result.turnsTaken).toBe(2);
  });

  it("uses the weather the caller never mentioned", async () => {
    const freezing = await simulate(find("hazard/spanish-no-heat-in-a-freeze"), deps);
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

describe("fragmentary answers", () => {
  it("books a caller who never finishes a sentence", async () => {
    const result = await simulate(find("english/answers-in-fragments"), deps);
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
