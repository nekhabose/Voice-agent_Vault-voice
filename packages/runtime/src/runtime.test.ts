import { describe, expect, it } from "vitest";
import {
  fixedClock,
  type CallRecord,
  type SpeechOutcome,
} from "@ledgerline/contracts";
import { ALLOW_ALL_SERVICE_AREAS, type GuardFn } from "@ledgerline/conversation";
import { FakeExtractor, absent, filled, unavailable, type Script } from "@ledgerline/extraction";
import {
  FakeFaqAnswerer,
  answered,
  faqUnavailable,
  unknownAnswer,
} from "@ledgerline/faq";
import { checkBudgets, computeMetrics } from "@ledgerline/telemetry";
import { AI_DISCLOSURE, CATALOG, CachedUtterer } from "@ledgerline/utterance";
import { FakeGeocoder, weekdayHours, type AddressInput } from "@ledgerline/validators";
import { initialContext } from "@ledgerline/conversation";
import { CallRuntime, isAffirmative, isQuestion, type CallRuntimeDeps } from "./runtime.js";
import { buildPendingBooking } from "./booking.js";
import { FakeBookingSink, FakeVoiceSession, SILENT_SPEECH_OUTCOME } from "./fakes.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const CALL_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const JOB_TYPE_ID = "33333333-3333-4333-8333-333333333333";

const ADDRESS_A: AddressInput = {
  line1: "1247 Calle Ocho",
  city: "Miami",
  state: "FL",
  postalCode: "33135",
};
const ADDRESS_B: AddressInput = {
  line1: "88 Brickell Avenue",
  city: "Miami",
  state: "FL",
  postalCode: "33131",
};

// Thursday 2026-07-09, 14:00–16:00 local (EDT) — inside the weekday hours below.
const WINDOW = {
  startsAt: "2026-07-09T18:00:00.000Z",
  endsAt: "2026-07-09T20:00:00.000Z",
};

/** A caller who says exactly the right thing every turn, once. */
const HAPPY_SCRIPT: Script = {
  caller_name: filled("Rosa Peña"),
  callback_phone: filled("305 555 1234"),
  problem_description: filled("my water heater stopped working"),
  urgency: filled("SAME_DAY"),
  service_address: filled(ADDRESS_A),
  appointment_window: filled(WINDOW),
};

interface Harness {
  readonly runtime: CallRuntime;
  readonly voice: FakeVoiceSession;
  readonly sink: FakeBookingSink;
  readonly extractor: FakeExtractor;
}

function harness(overrides: Partial<CallRuntimeDeps> & { script?: Script; speech?: SpeechOutcome } = {}): Harness {
  const { script, speech, ...depOverrides } = overrides;

  const extractor = new FakeExtractor(script ?? HAPPY_SCRIPT);
  const voice = new FakeVoiceSession(speech ? { default: speech } : {});
  const sink = new FakeBookingSink();
  const geocoder = new FakeGeocoder()
    .register(ADDRESS_A, 25.765, -80.22)
    .register(ADDRESS_B, 25.761, -80.19);

  const deps: CallRuntimeDeps = {
    extractor,
    utterer: new CachedUtterer(),
    voice,
    bookingSink: sink,
    geocoder,
    windowPolicy: {
      clock: fixedClock("2026-07-08T12:00:00.000Z"),
      timeZone: "America/New_York",
      hours: weekdayHours("08:00", "18:00"),
    },
    serviceArea: ALLOW_ALL_SERVICE_AREAS,
    clock: fixedClock("2026-07-08T12:00:00.000Z"),
    tenant: { tenantId: TENANT_ID, businessName: "Ace Plumbing", timeZone: "America/New_York" },
    callId: CALL_ID,
    jobTypeId: JOB_TYPE_ID,
    ...depOverrides,
  };

  return { runtime: new CallRuntime(deps), voice, sink, extractor };
}

/** Drive a clean booking to completion and return the harness. */
async function bookHappyPath(h: Harness = harness()): Promise<Harness> {
  const { runtime } = h;
  await runtime.start();
  await runtime.hear("It's Rosa Peña");
  await runtime.hear("three oh five, five five five, one two three four");
  await runtime.hear("my water heater stopped working");
  await runtime.hear("I need it done today");
  await runtime.hear("twelve forty seven Calle Ocho, Miami Florida three three one three five");
  await runtime.hear("Thursday afternoon works");
  // Three always-confirm read-backs: phone, address, window.
  await runtime.hear("yes");
  await runtime.hear("yes");
  await runtime.hear("that's right");
  return h;
}

/* -------------------------------------------------------------------------- */
/* The opening: greeting and disclosure                                        */
/* -------------------------------------------------------------------------- */

describe("start", () => {
  it("greets before anything else, disclosure verbatim, and then asks the first slot", async () => {
    const h = harness();
    await h.runtime.start();

    // The very first thing the caller hears carries the AI disclosure.
    expect(h.voice.spoken[0]).toContain(AI_DISCLOSURE);
    // GREET rides through AGENT_GREETED into the first ASK_FOR, in one call.
    expect(h.runtime.context.state).toBe("IDENTIFY");
    expect(h.voice.spoken).toHaveLength(2);
  });

  it("without start(), the greeting guard would never let the call move", async () => {
    const h = harness();
    // No start(): the machine is still in GREETING and greeting_delivered blocks.
    await h.runtime.hear("It's Rosa");
    expect(h.runtime.context.state).toBe("GREETING");
    expect(h.sink.submitted).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The happy path                                                              */
/* -------------------------------------------------------------------------- */

describe("a clean booking", () => {
  it("reaches CLOSE, contained, and posts one PendingBooking", async () => {
    const { runtime, sink } = await bookHappyPath();

    expect(runtime.context.state).toBe("CLOSE");
    expect(runtime.context.outcome).toBe("BOOKED");
    expect(runtime.contained).toBe(true);
    expect(runtime.isOver).toBe(true);
    expect(sink.submitted).toHaveLength(1);
  });

  it("submits a fully validated payload — E.164 phone, geocoded address", async () => {
    const { sink } = await bookHappyPath();
    const booking = sink.submitted[0]!;

    expect(booking.callId).toBe(CALL_ID);
    expect(booking.tenantId).toBe(TENANT_ID);
    expect(booking.jobTypeId).toBe(JOB_TYPE_ID);
    expect(booking.customer.name).toBe("Rosa Peña");
    // Spoken digits became E.164, which is validatePhone's job, not the model's.
    expect(booking.customer.phone).toBe("+13055551234");
    expect(booking.customer.locale).toBe("en");
    // The stored address is the geocoder's, carrying coordinates the model never saw.
    expect(booking.address.formatted).toContain("1247 Calle Ocho");
    expect(booking.address.lat).toBeCloseTo(25.765);
    expect(booking.urgency).toBe("SAME_DAY");
    expect(booking.window).toEqual(WINDOW);
  });

  it("reads back exactly the three always-confirm slots, in order", async () => {
    const { runtime } = await bookHappyPath();
    const readBacks = runtime.callTurns
      .filter((t) => t.role === "agent" && t.state === "CONFIRM")
      .map((t) => t.text);
    // Phone, address, window each read back once; name/problem/urgency were
    // high-confidence and never read back.
    expect(readBacks).toHaveLength(3);
  });

  it("arms the extractor for exactly one slot per turn", async () => {
    const { extractor } = await bookHappyPath();
    // One extraction per slot: the model is never handed a menu (principle #1).
    for (const key of ["caller_name", "callback_phone", "service_address"] as const) {
      expect(extractor.callsFor(key)).toHaveLength(1);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Verification and correction                                                 */
/* -------------------------------------------------------------------------- */

describe("read-back and correction", () => {
  it("a corrected value revokes the confirmation and is read back again", async () => {
    const h = harness({
      script: {
        ...HAPPY_SCRIPT,
        // First heard as A (in QUALIFY), corrected to B at the read-back.
        service_address: [filled(ADDRESS_A), filled(ADDRESS_B)],
      },
    });
    const { runtime, sink, voice } = h;

    await runtime.start();
    await runtime.hear("It's Rosa Peña");
    await runtime.hear("three oh five five five five one two three four");
    await runtime.hear("water heater is out");
    await runtime.hear("today please");
    await runtime.hear("twelve forty seven Calle Ocho");
    await runtime.hear("Thursday afternoon");
    // Read-back order: phone, then address.
    await runtime.hear("yes"); // confirm phone
    await runtime.hear("no, it's eighty eight Brickell Avenue"); // reject + correct address
    await runtime.hear("yes"); // confirm the corrected address
    await runtime.hear("yes"); // confirm window

    expect(runtime.context.outcome).toBe("BOOKED");
    expect(sink.submitted[0]!.address.formatted).toContain("88 Brickell Avenue");
    // The corrected address was read back a second time — the caller heard B.
    const addressReadBacks = voice.spoken.filter((s) => s.includes("Brickell"));
    expect(addressReadBacks.length).toBeGreaterThanOrEqual(1);
  });

  it("isAffirmative accepts a clear yes and rejects anything with a negation", () => {
    expect(isAffirmative("yes")).toBe(true);
    expect(isAffirmative("yeah that's right")).toBe(true);
    expect(isAffirmative("that's correct")).toBe(true);
    expect(isAffirmative("no")).toBe(false);
    expect(isAffirmative("no, that's wrong")).toBe(false);
    // "right" appears, but so does a negation: never confirm on ambiguity.
    expect(isAffirmative("no that's not right")).toBe(false);
    expect(isAffirmative("uhh")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* The emergency escape hatch                                                  */
/* -------------------------------------------------------------------------- */

describe("hazard on an ASR partial", () => {
  it("short-circuits the turn, reads guidance, transfers, and never asks the extractor", async () => {
    const h = harness();
    await h.runtime.start();

    const detection = await h.runtime.hearPartial("I think I smell gas");

    expect(detection?.category).toBe("GAS_LEAK");
    expect(h.runtime.context.state).toBe("HANDOFF");
    expect(h.runtime.context.outcome).toBe("ESCALATED_EMERGENCY");
    expect(h.runtime.isOver).toBe(true);
    expect(h.voice.transfers).toEqual(["EMERGENCY_HAZARD"]);
    // The classifier decided; the extractor was never consulted for this turn.
    expect(h.extractor.calls).toHaveLength(0);
  });

  it("a hazard stated only on the final still transfers", async () => {
    const h = harness();
    await h.runtime.start();
    await h.runtime.hear("actually the kitchen is on fire");

    expect(h.runtime.context.outcome).toBe("ESCALATED_EMERGENCY");
    expect(h.voice.transfers).toEqual(["EMERGENCY_HAZARD"]);
  });

  it("does nothing before the call has started (no interruptible state yet is fine)", async () => {
    const h = harness();
    // hearPartial before start: GREETING is interruptible, so it still escalates.
    const detection = await h.runtime.hearPartial("there's a gas leak");
    expect(detection?.category).toBe("GAS_LEAK");
    expect(h.runtime.isOver).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Failure modes that are not the caller's fault                               */
/* -------------------------------------------------------------------------- */

describe("extraction outages", () => {
  it("retries an unavailable extractor once, then succeeds", async () => {
    const h = harness({
      script: { ...HAPPY_SCRIPT, caller_name: [unavailable("503"), filled("Rosa")] },
    });
    await h.runtime.start();
    await h.runtime.hear("It's Rosa");

    // The bounded retry recovered; the name was stored, not escalated.
    expect(h.extractor.callsFor("caller_name")).toHaveLength(2);
    expect(h.runtime.context.slots.get("caller_name")?.value).toBe("Rosa");
    expect(h.runtime.context.outcome).toBeNull();
  });

  it("a persistent outage escalates as AGENT_ERROR, not as a caller who said nothing", async () => {
    const h = harness({ script: { ...HAPPY_SCRIPT, caller_name: unavailable("Anthropic down") } });
    await h.runtime.start();
    await h.runtime.hear("It's Rosa");

    expect(h.extractor.callsFor("caller_name")).toHaveLength(2); // one try, one retry
    expect(h.runtime.context.outcome).toBe("AGENT_ERROR");
    expect(h.voice.transfers).toEqual(["AGENT_ERROR"]);
    expect(h.runtime.isOver).toBe(true);
  });

  it("repeated absent extractions escalate to a human", async () => {
    const h = harness({
      script: { ...HAPPY_SCRIPT, caller_name: absent },
      maxExtractionFailures: 2,
    });
    await h.runtime.start();
    await h.runtime.hear("um");
    await h.runtime.hear("uh");

    expect(h.runtime.context.outcome).toBe("ESCALATED_OTHER");
    expect(h.voice.transfers).toEqual(["REPEATED_EXTRACTION_FAILURE"]);
  });

  it("a filled value the validator rejects is an extraction failure, not a stored fact", async () => {
    // The tool schema guarantees shape, never meaning: a phone with no digits
    // clears `strict` and is rejected by validatePhone (plan, §10.1).
    const h = harness({
      script: { ...HAPPY_SCRIPT, callback_phone: [filled("no digits here"), filled("305 555 1234")] },
    });
    await h.runtime.start();
    await h.runtime.hear("It's Rosa Peña");
    await h.runtime.hear("um, my number"); // filled-but-invalid → EXTRACTION_FAILED
    expect(h.runtime.context.slots.get("callback_phone")).toBeUndefined();
    expect(h.runtime.context.state).toBe("IDENTIFY");

    await h.runtime.hear("three oh five five five five one two three four");
    expect(h.runtime.context.slots.get("callback_phone")?.value).toBe("+13055551234");
  });

  it("re-asks with the reprompt form after one failure", async () => {
    const h = harness({
      script: { ...HAPPY_SCRIPT, caller_name: [absent, filled("Rosa")] },
    });
    await h.runtime.start();
    const askCountBefore = h.voice.spoken.length;
    await h.runtime.hear("um");
    // A second ASK_FOR caller_name was spoken (the reprompt), not an advance.
    expect(h.voice.spoken.length).toBeGreaterThan(askCountBefore);
    expect(h.runtime.context.state).toBe("IDENTIFY");
  });
});

/* -------------------------------------------------------------------------- */
/* The other ways a call ends                                                  */
/* -------------------------------------------------------------------------- */

describe("non-booking outcomes", () => {
  it("a caller who asks for a human is warm-transferred", async () => {
    const h = harness();
    await h.runtime.start();
    await h.runtime.requestHuman();

    expect(h.runtime.context.outcome).toBe("ESCALATED_OTHER");
    expect(h.voice.transfers).toEqual(["CALLER_REQUESTED_HUMAN"]);
    expect(h.runtime.isOver).toBe(true);
  });

  it("a hangup is terminal and never reopened", async () => {
    const h = harness();
    await h.runtime.start();
    await h.runtime.callerHungUp();
    expect(h.runtime.context.outcome).toBe("CALLER_HUNG_UP");

    // Anything after a hangup is ignored — there is no reopening a closed call.
    await h.runtime.hear("wait, I'm still here");
    expect(h.runtime.context.outcome).toBe("CALLER_HUNG_UP");
  });

  it("an out-of-area address declines and hangs up rather than transferring", async () => {
    const outOfArea: GuardFn = () => ({ kind: "escalate", reason: "OUT_OF_SERVICE_AREA" });
    const h = harness({ serviceArea: outOfArea });

    await h.runtime.start();
    await h.runtime.hear("It's Rosa");
    await h.runtime.hear("three oh five five five five one two three four");
    await h.runtime.hear("water heater is out");
    await h.runtime.hear("today");
    await h.runtime.hear("twelve forty seven Calle Ocho");

    expect(h.runtime.context.outcome).toBe("OUT_OF_SERVICE_AREA");
    // DECLINE is a courteous close, not a human hand-off.
    expect(h.voice.hungUp).toBe(true);
    expect(h.voice.transfers).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Defensive invariants                                                        */
/* -------------------------------------------------------------------------- */

describe("buildPendingBooking", () => {
  it("throws rather than shipping a booking with a hole in it", () => {
    // Reachable only through a machine bug; a loud crash beats an undefined on
    // the contractor's calendar.
    expect(() =>
      buildPendingBooking(initialContext(), {
        callId: CALL_ID,
        tenantId: TENANT_ID,
        jobTypeId: null,
      }),
    ).toThrow(/caller_name/);
  });
});

describe("FakeVoiceSession", () => {
  it("returns scripted outcomes in order, then falls through to the default", async () => {
    const voice = new FakeVoiceSession({
      outcomes: [SILENT_SPEECH_OUTCOME],
      default: { spoke: true, bargeIn: true, firstWordLatencyMs: 10, turnLatencyMs: 20 },
    });
    expect((await voice.say("one")).spoke).toBe(false); // scripted
    expect((await voice.say("two")).bargeIn).toBe(true); // default
    expect(voice.spoken).toEqual(["one", "two"]);
  });
});

/* -------------------------------------------------------------------------- */
/* Telemetry: every turn traced (task 4.9)                                     */
/* -------------------------------------------------------------------------- */

describe("turn tracing", () => {
  const record = (outcome: CallRecord["outcome"]): CallRecord => ({
    id: CALL_ID,
    tenantId: TENANT_ID,
    fromE164: "+13055551234",
    startedAt: "2026-07-08T12:00:00.000Z",
    endedAt: "2026-07-08T12:02:00.000Z",
    localesDetected: ["en"],
    outcome,
    containment: outcome === "BOOKED",
    recordingUrl: null,
    transcriptUrl: null,
  });

  it("traces both roles, every turn carries the callId, and budgets pass", async () => {
    const { runtime } = await bookHappyPath();
    const turns = runtime.callTurns;

    expect(turns.every((t) => t.callId === CALL_ID)).toBe(true);
    expect(turns.some((t) => t.role === "agent")).toBe(true);
    expect(turns.some((t) => t.role === "caller")).toBe(true);

    const metrics = computeMetrics({
      calls: [record("BOOKED")],
      turns,
      outcomes: [],
      committedBookings: 1,
    });
    expect(checkBudgets(metrics)).toEqual([]);
    expect(metrics.turnTakeRate).toBe(1);
  });

  it("silence is a budget breach, not free speed", async () => {
    const { runtime } = await bookHappyPath(harness({ speech: SILENT_SPEECH_OUTCOME }));

    const metrics = computeMetrics({
      calls: [record("BOOKED")],
      turns: runtime.callTurns,
      outcomes: [],
      committedBookings: 1,
    });
    const breaches = checkBudgets(metrics);
    expect(breaches.map((b) => b.metric)).toContain("turnTakeRate");
  });
});

/* -------------------------------------------------------------------------- */
/* The FAQ detour (plan, §6 call site #3 — Step 6.4)                           */
/* -------------------------------------------------------------------------- */

const ESTIMATE_ANSWER =
  "Estimates are free for replacements, and there's a seventy-nine dollar diagnostic fee for repairs.";

/** A caller who asks a question where their name was expected. */
function askingHarness(
  faq: FakeFaqAnswerer,
  over: Partial<CallRuntimeDeps> = {},
): Harness & { faq: FakeFaqAnswerer } {
  const h = harness({
    script: { ...HAPPY_SCRIPT, caller_name: [absent, filled("Rosa Peña")] },
    faq,
    ...over,
  });
  return { ...h, faq };
}

describe("the FAQ detour", () => {
  it("buys time out loud, answers, and then puts the same question back", async () => {
    const h = askingHarness(new FakeFaqAnswerer([answered(ESTIMATE_ANSWER)]));
    await h.runtime.start();
    const before = h.voice.spoken.length;

    await h.runtime.hear("do you charge for an estimate?");

    // Filler first — the caller hears something *while* retrieval runs. That
    // ordering is the whole of "never blocks the audio path".
    expect(h.voice.spoken.slice(before)).toEqual([
      CATALOG.faq.filler,
      ESTIMATE_ANSWER,
      CATALOG.ask.caller_name.initial,
    ]);
    expect(h.faq.calls[0]?.question).toBe("do you charge for an estimate?");
  });

  /**
   * A question is not an extraction failure. Counting it as one re-asks a caller
   * who is waiting on an answer, and escalates them for it after three tries.
   */
  it("does not count a question against the caller", async () => {
    const h = askingHarness(new FakeFaqAnswerer([answered(ESTIMATE_ANSWER)]));
    await h.runtime.start();
    await h.runtime.hear("how much is a service call?");

    expect(h.runtime.context.extractionFailures.caller_name ?? 0).toBe(0);
    expect(h.runtime.context.state).toBe("IDENTIFY");

    // And the call carries on exactly where it was.
    await h.runtime.hear("It's Rosa Peña");
    expect(h.runtime.context.slots.get("caller_name")?.value).toBe("Rosa Peña");
  });

  /**
   * The detour is gated on extraction having already come back empty, so an
   * utterance that fills the slot can never be spent on the FAQ — however it is
   * phrased.
   */
  it("never detours on a turn that filled the slot", async () => {
    const faq = new FakeFaqAnswerer([answered(ESTIMATE_ANSWER)]);
    const h = harness({ faq }); // HAPPY_SCRIPT fills caller_name on the first try
    await h.runtime.start();
    await h.runtime.hear("what? oh, Rosa Peña");

    expect(faq.calls).toEqual([]);
    expect(h.runtime.context.slots.get("caller_name")?.value).toBe("Rosa Peña");
  });

  it("admits it does not know, rather than improvising", async () => {
    const h = askingHarness(new FakeFaqAnswerer([unknownAnswer]));
    await h.runtime.start();
    await h.runtime.hear("do you service swimming pools?");

    expect(h.voice.spoken).toContain(CATALOG.faq.unknown);
  });

  /** An outage sounds the same to the caller. It is a different fact to us. */
  it("promises the same callback when the FAQ itself is down", async () => {
    const h = askingHarness(new FakeFaqAnswerer([faqUnavailable("pgvector: down")]));
    await h.runtime.start();
    await h.runtime.hear("what are your hours?");

    expect(h.voice.spoken).toContain(CATALOG.faq.unknown);
    expect(h.runtime.context.outcome).toBeNull();
  });

  /**
   * A caller who only ever asks questions is a caller who needs a person. After
   * the bound, questions fall back to the ordinary extraction-failure path — which
   * is itself bounded, and ends in a human.
   */
  it("stops detouring after the bound, and then escalates like any stuck call", async () => {
    const faq = new FakeFaqAnswerer([answered(ESTIMATE_ANSWER)]);
    const h = harness({
      script: { ...HAPPY_SCRIPT, caller_name: absent },
      faq,
      maxFaqAnswers: 1,
      maxExtractionFailures: 2,
    });
    await h.runtime.start();

    await h.runtime.hear("do you charge for an estimate?"); // answered
    await h.runtime.hear("what about weekends?"); // over the bound → extraction failure
    await h.runtime.hear("and holidays?"); // second failure → escalate

    expect(faq.calls).toHaveLength(1);
    expect(h.runtime.context.outcome).toBe("ESCALATED_OTHER");
    expect(h.voice.transfers).toEqual(["REPEATED_EXTRACTION_FAILURE"]);
  });

  it("without an FAQ bound, a question is just an utterance we could not use", async () => {
    const h = harness({ script: { ...HAPPY_SCRIPT, caller_name: [absent, filled("Rosa")] } });
    await h.runtime.start();
    await h.runtime.hear("do you charge for an estimate?");

    expect(h.runtime.context.extractionFailures.caller_name).toBe(1);
  });

  /** A question asked at a read-back is answered, and the read-back is repeated. */
  it("answers a question mid-confirmation and reads the value back again", async () => {
    const faq = new FakeFaqAnswerer([answered(ESTIMATE_ANSWER)]);
    const h = harness({
      script: {
        ...HAPPY_SCRIPT,
        callback_phone: [filled("305 555 1234"), absent, filled("305 555 1234")],
      },
      faq,
    });
    await h.runtime.start();
    await h.runtime.hear("It's Rosa Peña");
    await h.runtime.hear("three oh five, five five five, one two three four");
    await h.runtime.hear("my water heater stopped working");
    await h.runtime.hear("I need it done today");
    await h.runtime.hear("twelve forty seven Calle Ocho, Miami Florida three three one three five");
    await h.runtime.hear("Thursday afternoon works");

    // All six slots are in, and the first always-confirm read-back is outstanding.
    const readBack = h.voice.spoken.at(-1)!;
    expect(readBack).toContain("305 555 1234");

    await h.runtime.hear("wait, do you charge for an estimate?");

    expect(h.voice.spoken.slice(-3)).toEqual([
      CATALOG.faq.filler,
      ESTIMATE_ANSWER,
      readBack,
    ]);
    // Still owed a yes: the FAQ changed no slot, no state, and no guard.
    expect(h.runtime.context.slots.get("callback_phone")?.confirmedByCaller).toBe(false);
  });

  /** A hazard never waits on retrieval. The classifier runs before any model. */
  it("is never reached when the caller is standing in gas", async () => {
    const faq = new FakeFaqAnswerer([answered(ESTIMATE_ANSWER)]);
    const h = harness({ script: { ...HAPPY_SCRIPT, caller_name: absent }, faq });
    await h.runtime.start();
    await h.runtime.hear("why does it smell like gas in here?");

    expect(faq.calls).toEqual([]);
    expect(h.voice.transfers).toEqual(["EMERGENCY_HAZARD"]);
  });

  it("traces the filler and the answer, so the budgets score them", async () => {
    const h = askingHarness(new FakeFaqAnswerer([answered(ESTIMATE_ANSWER)]));
    await h.runtime.start();
    await h.runtime.hear("do you charge for an estimate?");

    const spoken = h.runtime.callTurns.filter((t) => t.role === "agent").map((t) => t.text);
    expect(spoken).toContain(CATALOG.faq.filler);
    expect(spoken).toContain(ESTIMATE_ANSWER);
  });
});

describe("isQuestion", () => {
  it.each([
    "do you charge for an estimate?",
    "How much is a service call",
    "what are your hours",
    "can someone come out tomorrow",
    "Is the estimate free",
  ])("hears a question in %s", (text) => {
    expect(isQuestion(text)).toBe(true);
  });

  it.each(["Rosa Peña", "twelve forty seven Calle Ocho", "yes that's right", ""])(
    "does not hear one in %s",
    (text) => {
      expect(isQuestion(text)).toBe(false);
    },
  );
});
