import {
  EscalationReasonSchema,
  HAZARD_CATEGORIES,
  SLOT_KEYS,
  UrgencySchema,
  type Address,
  type Effect,
  type HazardDetection,
  type UtteranceContext,
} from "@ledgerline/contracts";
import { describe, expect, it } from "vitest";
import { CachedUtterer } from "./cached.js";
import { AI_DISCLOSURE, CATALOG, PLACEHOLDERS } from "./catalog.js";
import { FakePhraser, TemplateUtterer } from "./fake.js";
import { LlmUtterer } from "./llm.js";
import {
  MissingUtteranceValueError,
  UnknownPlaceholderError,
  fill,
  speakPhone,
  speakSlot,
  speakWindow,
} from "./render.js";

const ADDRESS: Address = {
  line1: "1247 Calle Ocho",
  city: "Miami",
  state: "FL",
  postalCode: "33135",
  formatted: "1247 SW 8th St, Miami, FL 33135",
};

const CTX: UtteranceContext = {
  businessName: "Ortega Plumbing",
  timeZone: "America/New_York",
  values: {
    caller_name: "Rosa",
    callback_phone: "+13055551234",
    service_address: ADDRESS,
    problem_description: "the water heater is leaking",
    urgency: "SAME_DAY",
    appointment_window: {
      startsAt: "2026-07-09T18:00:00Z",
      endsAt: "2026-07-09T22:00:00Z",
    },
  },
  attempt: 0,
};

const utterer = new CachedUtterer();

const hazard = (category: HazardDetection["category"]): HazardDetection => ({
  category,
  action: "DIAL_911_GUIDANCE",
  matchedText: "smells like gas",
  ruleId: "test",
});

/* -------------------------------------------------------------------------- */
/* The catalog                                                                 */
/* -------------------------------------------------------------------------- */

describe("the catalog", () => {
  it("has an ask and a read-back for every slot the model can fill", () => {
    for (const key of SLOT_KEYS) {
      expect(CATALOG.ask[key].initial).not.toBe("");
      expect(CATALOG.ask[key].reprompt).not.toBe("");
      expect(CATALOG.readBack[key]).toContain("{value}");
    }
  });

  it("never repeats a failed question verbatim", () => {
    for (const key of SLOT_KEYS) {
      expect(CATALOG.ask[key].reprompt).not.toBe(CATALOG.ask[key].initial);
    }
  });

  it("has guidance for every hazard, a line for every escalation, every urgency", () => {
    for (const category of HAZARD_CATEGORIES) {
      expect(CATALOG.hazardGuidance[category].length).toBeGreaterThan(10);
    }
    for (const reason of EscalationReasonSchema.options) {
      expect(CATALOG.escalation[reason]).not.toBe("");
    }
    for (const urgency of UrgencySchema.options) {
      expect(CATALOG.urgency[urgency]).not.toBe("");
      // Nobody hears the word "SAME_DAY".
      expect(CATALOG.urgency[urgency]).not.toContain("_");
    }
  });

  /**
   * The review surface (Step 3.3) is only reviewable if it is data. A template
   * function in here is a sentence a human cannot read off the page.
   */
  it("is data: every leaf is a string, and every placeholder is one we resolve", () => {
    const leaves: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === "string") return void leaves.push(node);
      expect(typeof node).toBe("object");
      Object.values(node as object).forEach(walk);
    };
    walk(CATALOG);

    expect(leaves.length).toBeGreaterThan(25);
    for (const line of leaves) {
      for (const [, name] of line.matchAll(/\{(\w+)\}/g)) {
        expect(PLACEHOLDERS).toContain(name);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The AI disclosure — the Step 3 exit criterion                               */
/* -------------------------------------------------------------------------- */

describe("the AI disclosure", () => {
  /**
   * Pinned character for character. This test failing is not a test problem: it
   * means somebody changed legal text, and the diff needs a human who is paid
   * to read it.
   */
  it("is a verbatim, committed string", () => {
    expect(AI_DISCLOSURE).toBe(
      "Just so you know, you're speaking with an automated assistant, not a person, and this call may be recorded. You can ask for a human at any time.",
    );
    expect(CATALOG.greeting.disclosure).toBe(AI_DISCLOSURE);
  });

  it("is spoken, verbatim, in the greeting", () => {
    expect(utterer.line({ type: "GREET" }, CTX)).toContain(AI_DISCLOSURE);
  });

  it("names the business and does not leak a placeholder", () => {
    const greeting = utterer.line({ type: "GREET" }, CTX);
    expect(greeting).toContain("Ortega Plumbing");
    expect(greeting).not.toContain("{");
  });
});

/* -------------------------------------------------------------------------- */
/* CachedUtterer                                                               */
/* -------------------------------------------------------------------------- */

describe("CachedUtterer", () => {
  it("says every effect without a placeholder surviving", async () => {
    const effects: Effect[] = [
      { type: "GREET" },
      ...SLOT_KEYS.map((key) => ({ type: "ASK_FOR" as const, key })),
      ...SLOT_KEYS.map((key) => ({ type: "READ_BACK" as const, key })),
      {
        type: "ESCALATE",
        reason: "EMERGENCY_HAZARD",
        action: "DIAL_911_GUIDANCE",
        hazard: hazard("GAS_LEAK"),
      },
      { type: "CREATE_PENDING_BOOKING" },
      { type: "SAY_FILLER" },
      { type: "ANSWER_FAQ", answer: "Estimates are free for replacements." },
      { type: "ANSWER_FAQ", answer: null },
    ];

    for (const effect of effects) {
      const line = await utterer.say(effect, CTX);
      expect(line).not.toContain("{");
      expect(line.trim()).toBe(line);
    }
  });

  it("is pure: the same effect twice is the same sentence twice", () => {
    const effect: Effect = { type: "ASK_FOR", key: "service_address" };
    expect(utterer.line(effect, CTX)).toBe(utterer.line(effect, CTX));
  });

  it("re-asks differently after a failed extraction", () => {
    const effect: Effect = { type: "ASK_FOR", key: "callback_phone" };
    const first = utterer.line(effect, CTX);
    const second = utterer.line(effect, { ...CTX, attempt: 1 });

    expect(first).toBe(CATALOG.ask.callback_phone.initial);
    expect(second).toBe(CATALOG.ask.callback_phone.reprompt);
  });

  /**
   * The FAQ answer is the contractor's sentence, and it reaches the caller
   * unedited. Wrapping it in words of ours would be us rewriting an answer about
   * price or policy that they approved and will be held to.
   */
  it("speaks the contractor's FAQ answer verbatim, adding nothing", () => {
    const answer =
      "Estimates are free for replacements, and there's a seventy-nine dollar diagnostic fee for repairs.";
    expect(utterer.line({ type: "ANSWER_FAQ", answer }, CTX)).toBe(answer);
  });

  it("promises a callback when no committed answer covers the question", () => {
    expect(utterer.line({ type: "ANSWER_FAQ", answer: null }, CTX)).toBe(
      CATALOG.faq.unknown,
    );
  });

  /** The filler is spoken before we know whether we can answer, so it may not promise one. */
  it("says a filler that commits to nothing", () => {
    const line = utterer.line({ type: "SAY_FILLER" }, CTX);
    expect(line).toBe(CATALOG.faq.filler);
    expect(line).not.toMatch(/free|cost|price|\$/i);
  });

  describe("read-back", () => {
    it("reads the geocoder's address, never the caller's raw line", () => {
      const line = utterer.line({ type: "READ_BACK", key: "service_address" }, CTX);
      expect(line).toContain("1247 SW 8th St, Miami, FL 33135");
    });

    it("groups the phone number so a human can check it", () => {
      const line = utterer.line({ type: "READ_BACK", key: "callback_phone" }, CTX);
      expect(line).toContain("305 555 1234");
      expect(line).not.toContain("+1");
    });

    it("speaks the urgency enum as English", () => {
      const line = utterer.line({ type: "READ_BACK", key: "urgency" }, CTX);
      expect(line).toContain("needs someone today");
      expect(line).not.toContain("SAME_DAY");
    });

    it("speaks the window in the tenant's timezone", () => {
      const line = utterer.line({ type: "READ_BACK", key: "appointment_window" }, CTX);
      expect(line).toContain("Thursday, July 9, between 2 PM and 6 PM");
    });

    it("passes name and problem through untouched", () => {
      expect(utterer.line({ type: "READ_BACK", key: "caller_name" }, CTX)).toContain("Rosa");
      expect(
        utterer.line({ type: "READ_BACK", key: "problem_description" }, CTX),
      ).toContain("the water heater is leaking");
    });

    /** A read-back for an unfilled slot is a machine bug. Never improvise. */
    it("throws rather than invent a value it was never given", () => {
      const empty = { ...CTX, values: {} };
      expect(() => utterer.line({ type: "READ_BACK", key: "caller_name" }, empty)).toThrow(
        MissingUtteranceValueError,
      );
    });
  });

  describe("escalation", () => {
    it("reads life-safety guidance before the transfer, not after", () => {
      const line = utterer.line(
        {
          type: "ESCALATE",
          reason: "EMERGENCY_HAZARD",
          action: "DIAL_911_GUIDANCE",
          hazard: hazard("GAS_LEAK"),
        },
        CTX,
      );

      expect(line.indexOf("leave the building")).toBeGreaterThanOrEqual(0);
      expect(line.indexOf("leave the building")).toBeLessThan(line.indexOf("911"));
    });

    it("gives each hazard its own guidance", () => {
      const co = utterer.line(
        {
          type: "ESCALATE",
          reason: "EMERGENCY_HAZARD",
          action: "WARM_TRANSFER",
          hazard: hazard("CARBON_MONOXIDE"),
        },
        CTX,
      );
      expect(co).toContain("fresh air");
      expect(co).toContain(CATALOG.transfer.WARM_TRANSFER);
    });

    /** The type allows it; the machine never produces it. Speak anyway. */
    it("still promises help when a hazard escalation arrives without its detection", () => {
      const line = utterer.line(
        {
          type: "ESCALATE",
          reason: "EMERGENCY_HAZARD",
          action: "WARM_TRANSFER",
          hazard: null,
        },
        CTX,
      );
      expect(line).toContain(CATALOG.escalation.EMERGENCY_HAZARD);
      expect(line).toContain(CATALOG.transfer.WARM_TRANSFER);
    });

    it("declines an out-of-area address by name, and does not promise a visit", () => {
      const line = utterer.line(
        {
          type: "ESCALATE",
          reason: "OUT_OF_SERVICE_AREA",
          action: "DECLINE",
          hazard: null,
        },
        CTX,
      );
      expect(line).toContain("Ortega Plumbing");
      expect(line).not.toContain("getting you to someone");
    });

    it("transfers a caller who asked for a human", () => {
      const line = utterer.line(
        {
          type: "ESCALATE",
          reason: "CALLER_REQUESTED_HUMAN",
          action: "WARM_TRANSFER",
          hazard: null,
        },
        CTX,
      );
      expect(line).toContain("Of course.");
      expect(line).toContain("right now");
    });
  });

  describe("closing", () => {
    it("promises the SMS to the number we will actually text", () => {
      const line = utterer.line({ type: "CREATE_PENDING_BOOKING" }, CTX);
      expect(line).toContain("305 555 1234");
      expect(line).toContain("Ortega Plumbing");
    });

    it("throws rather than promise a text to nobody", () => {
      expect(() =>
        utterer.line({ type: "CREATE_PENDING_BOOKING" }, { ...CTX, values: {} }),
      ).toThrow(MissingUtteranceValueError);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

describe("render", () => {
  it("groups NANP numbers and spells out anything else", () => {
    expect(speakPhone("+13055551234")).toBe("305 555 1234");
    expect(speakPhone("+442079460958")).toBe("4 4 2 0 7 9 4 6 0 9 5 8");
  });

  /**
   * The same wall-clock hour across the DST boundary. If this renders 1 PM in
   * January, the truck arrives an hour early in July.
   */
  it("renders a window in the tenant's zone on both sides of DST", () => {
    const winter = speakWindow(
      { startsAt: "2026-01-15T19:00:00Z", endsAt: "2026-01-15T23:00:00Z" },
      "America/New_York",
    );
    const summer = speakWindow(
      { startsAt: "2026-07-09T18:00:00Z", endsAt: "2026-07-09T22:00:00Z" },
      "America/New_York",
    );

    expect(winter).toBe("Thursday, January 15, between 2 PM and 6 PM");
    expect(summer).toBe("Thursday, July 9, between 2 PM and 6 PM");
  });

  it("renders the same instant differently for a tenant in another zone", () => {
    const window = { startsAt: "2026-07-09T18:00:00Z", endsAt: "2026-07-09T22:00:00Z" };
    expect(speakWindow(window, "America/Los_Angeles")).toBe(
      "Thursday, July 9, between 11 AM and 3 PM",
    );
  });

  it("keeps the minutes when they are not zero", () => {
    expect(
      speakWindow(
        { startsAt: "2026-07-09T18:30:00Z", endsAt: "2026-07-09T22:00:00Z" },
        "America/New_York",
      ),
    ).toBe("Thursday, July 9, between 2:30 PM and 6 PM");
  });

  it("speaks every slot key", () => {
    for (const key of SLOT_KEYS) {
      const value = CTX.values[key];
      expect(value).toBeDefined();
      expect(speakSlot(key, value!, CTX.timeZone).length).toBeGreaterThan(0);
    }
  });

  it("refuses a placeholder it was never given a value for", () => {
    expect(() => fill("hello {nobody}", { value: "x" })).toThrow(UnknownPlaceholderError);
  });
});

/* -------------------------------------------------------------------------- */
/* LlmUtterer — the drafting tool                                              */
/* -------------------------------------------------------------------------- */

describe("LlmUtterer", () => {
  it("paraphrases a question, and tells the model what it is asking for", async () => {
    const phraser = new FakePhraser(["What name should I put this under?"]);
    const line = await new LlmUtterer({ phraser }).say(
      { type: "ASK_FOR", key: "caller_name" },
      CTX,
    );

    expect(line).toBe("What name should I put this under?");
    expect(phraser.prompts[0]).toContain("name");
    expect(phraser.prompts[0]).toContain(CATALOG.ask.caller_name.initial);
  });

  it("tells the model the earlier attempts failed", async () => {
    const phraser = new FakePhraser(["Once more — your number?"]);
    await new LlmUtterer({ phraser }).say({ type: "ASK_FOR", key: "callback_phone" }, {
      ...CTX,
      attempt: 2,
    });
    expect(phraser.prompts[0]).toContain("2 time(s)");
  });

  /**
   * The invariant. Mutation-tested: widen the `ASK_FOR` check in `llm.ts` and
   * this suite reports a paraphrased AI disclosure, a paraphrased address
   * read-back, and paraphrased gas-leak guidance.
   */
  it.each<Effect>([
    { type: "GREET" },
    { type: "READ_BACK", key: "service_address" },
    {
      type: "ESCALATE",
      reason: "EMERGENCY_HAZARD",
      action: "DIAL_911_GUIDANCE",
      hazard: hazard("GAS_LEAK"),
    },
    { type: "CREATE_PENDING_BOOKING" },
    { type: "SAY_FILLER" },
    // The one that would undo Step 6.4. The FAQ answer is committed text about
    // price and policy; a model that "naturally" rephrases it has quoted a number
    // the contractor never approved, on a recorded line.
    { type: "ANSWER_FAQ", answer: "Estimates are free for replacements." },
  ])("never asks a model to reword $type", async (effect) => {
    const phraser = new FakePhraser(["something a model made up"]);
    const line = await new LlmUtterer({ phraser }).say(effect, CTX);

    expect(phraser.prompts).toEqual([]);
    expect(line).toBe(new CachedUtterer().line(effect, CTX));
  });

  it.each([
    ["an empty line", ""],
    ["a monologue", "x".repeat(201)],
    ["a line break", "What's your name?\nAnd your number?"],
    ["an unresolved placeholder", "Hi {business}, your name?"],
  ])("falls back to the committed line on %s", async (_label, drafted) => {
    const phraser = new FakePhraser([drafted]);
    const line = await new LlmUtterer({ phraser }).say(
      { type: "ASK_FOR", key: "caller_name" },
      CTX,
    );
    expect(line).toBe(CATALOG.ask.caller_name.initial);
  });

  it("falls back when the model is down", async () => {
    const phraser = new FakePhraser([], new Error("503"));
    const line = await new LlmUtterer({ phraser }).say(
      { type: "ASK_FOR", key: "urgency" },
      CTX,
    );
    expect(line).toBe(CATALOG.ask.urgency.initial);
  });

  it("trims what the model returned", async () => {
    const phraser = new FakePhraser(["  Your name?  "]);
    expect(
      await new LlmUtterer({ phraser }).say({ type: "ASK_FOR", key: "caller_name" }, CTX),
    ).toBe("Your name?");
  });
});

/* -------------------------------------------------------------------------- */
/* TemplateUtterer                                                             */
/* -------------------------------------------------------------------------- */

describe("TemplateUtterer", () => {
  it("records what it was told to say, in order", async () => {
    const fake = new TemplateUtterer();
    await fake.say({ type: "GREET" }, CTX);
    await fake.say({ type: "ASK_FOR", key: "caller_name" }, CTX);
    await fake.say({ type: "READ_BACK", key: "callback_phone" }, CTX);
    await fake.say(
      { type: "ESCALATE", reason: "CALLER_REQUESTED_HUMAN", action: "WARM_TRANSFER", hazard: null },
      CTX,
    );
    await fake.say({ type: "CREATE_PENDING_BOOKING" }, CTX);

    expect(fake.lines).toEqual([
      "[GREET]",
      "[ASK_FOR caller_name]",
      "[READ_BACK callback_phone]",
      "[ESCALATE CALLER_REQUESTED_HUMAN WARM_TRANSFER]",
      "[CREATE_PENDING_BOOKING]",
    ]);
    expect(fake.spoken[0]!.ctx).toBe(CTX);
  });
});
