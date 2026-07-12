import type {
  EscalationAction,
  EscalationReason,
  HazardCategory,
  SlotKey,
  Urgency,
} from "@ledgerline/contracts";

/**
 * Every sentence the agent can say to a customer.
 *
 * Generated offline with an `claude-opus-4-8`-class model, read line by line by
 * a human, and **committed** (plan, §10.2 and Step 3.3). Nothing here is
 * produced at call time. That buys three things the obvious design — a model
 * phrasing each turn — cannot:
 *
 * 1. Zero added latency in the audio path.
 * 2. A diffable review surface. `git diff` on this file *is* the change control
 *    for what a stranger hears when they phone a plumber at midnight.
 * 3. Compliance text that is verbatim rather than paraphrased. See
 *    {@link AI_DISCLOSURE}.
 *
 * **This file is data, deliberately.** No functions, no conditionals, no string
 * concatenation. Placeholders are `{business}`, `{value}`, and `{phone}`, and
 * `fill()` in `render.ts` is the only thing that resolves them. A reviewer
 * reading this file sees exactly the sentences a caller hears; a reviewer
 * reading template *functions* has to simulate them.
 */

/** The placeholders `fill()` will resolve. Anything else is a typo, and throws. */
export const PLACEHOLDERS = ["business", "value", "phone"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

/**
 * The AI disclosure, spoken verbatim at the top of every call.
 *
 * California's AB 3030 lineage and the general FTC posture both want *clear*
 * disclosure that the caller is not talking to a person, before the
 * conversation begins. The `greeting_delivered` guard makes it a precondition
 * of leaving GREETING, and `LlmUtterer` refuses to paraphrase it.
 *
 * **Do not reword this string in a "tone" pass.** It is legal text that happens
 * to be spoken. If it must change, it changes here, in a commit a lawyer can
 * read, and Step 8 hears about it.
 */
export const AI_DISCLOSURE =
  "Just so you know, you're speaking with an automated assistant, not a person, and this call may be recorded. You can ask for a human at any time.";

export interface AskForms {
  readonly initial: string;
  /**
   * Spoken when the extractor came back empty. Never a verbatim repeat: asking
   * the identical question twice tells the caller nothing about *why* it
   * failed, and the second answer is usually the same as the first.
   */
  readonly reprompt: string;
}

export interface UtteranceCatalog {
  readonly greeting: {
    readonly opening: string;
    readonly disclosure: string;
    readonly invitation: string;
  };
  readonly ask: { readonly [K in SlotKey]: AskForms };
  readonly readBack: { readonly [K in SlotKey]: string };
  /** How an `Urgency` enum sounds out loud. Nobody hears the word "SAME_DAY". */
  readonly urgency: { readonly [U in Urgency]: string };
  readonly escalation: { readonly [R in EscalationReason]: string };
  /** Life-safety guidance, read *before* the transfer. We never simply hang up on a gas leak. */
  readonly hazardGuidance: { readonly [H in HazardCategory]: string };
  readonly transfer: { readonly [A in EscalationAction]: string };
  /**
   * The FAQ detour (plan, §6 call site #3). Two lines, and neither is an answer:
   * `filler` is what the caller hears *while* retrieval runs, and `unknown` is
   * what they hear when nothing the contractor wrote covers the question.
   *
   * The answer itself is not in this catalog, and cannot be — it is the
   * contractor's own committed text, spoken verbatim from their FAQ. A model
   * selects it; no model writes it.
   */
  readonly faq: {
    readonly filler: string;
    readonly unknown: string;
  };
  readonly closing: string;
}

export const CATALOG: UtteranceCatalog = {
  greeting: {
    opening: "Thanks for calling {business}.",
    disclosure: AI_DISCLOSURE,
    invitation: "What can I help you with today?",
  },

  ask: {
    caller_name: {
      initial: "Can I start with your name?",
      reprompt: "Sorry, I didn't catch your name. Could you say it once more?",
    },
    callback_phone: {
      initial: "What's the best number to reach you on?",
      reprompt:
        "I didn't get that number. Could you give it to me one digit at a time?",
    },
    service_address: {
      initial: "And what's the address where you need the work done?",
      reprompt:
        "I didn't catch the address. Could you start with the street number and the street name?",
    },
    problem_description: {
      initial: "Tell me what's going on.",
      reprompt: "Sorry, could you describe the problem for me once more?",
    },
    urgency: {
      initial: "Does this need someone today, or can it wait?",
      reprompt:
        "Just so I get this right, is this an emergency, does it need someone today, or can it wait a few days?",
    },
    appointment_window: {
      initial: "When would you like someone to come out?",
      reprompt: "What day works for you, and roughly what time?",
    },
  },

  readBack: {
    caller_name: "I have your name as {value}. Did I get that right?",
    callback_phone: "Let me read that number back: {value}. Is that right?",
    service_address: "I have the address as {value}. Is that correct?",
    problem_description: "So, to make sure I have it: {value}. Is that right?",
    urgency: "I've put this down as {value}. Does that sound right?",
    appointment_window: "I can put you down for {value}. Does that work?",
  },

  urgency: {
    ROUTINE: "something we can schedule whenever it suits you",
    SOON: "something to take care of in the next few days",
    SAME_DAY: "something that needs someone today",
    EMERGENCY: "an emergency",
  },

  escalation: {
    // Reached only if a hazard escalation somehow arrives without its detection.
    // The caller still hears that help is coming.
    EMERGENCY_HAZARD: "This isn't something to wait on.",
    OUT_OF_SERVICE_AREA:
      "I'm sorry, that address is outside the area {business} covers. I don't want to book a visit we can't make.",
    CALLER_REQUESTED_HUMAN: "Of course.",
    REPEATED_EXTRACTION_FAILURE:
      "I'm having trouble getting that down correctly, and I don't want to get it wrong.",
    AGENT_ERROR: "Something's gone wrong on my end, and I'm sorry about that.",
  },

  hazardGuidance: {
    GAS_LEAK:
      "Please leave the building right now. Don't switch any lights on or off, and don't use your phone indoors.",
    CARBON_MONOXIDE:
      "Please get everyone outside into fresh air right now, and don't go back in.",
    FIRE: "Please get everyone out of the building right now.",
    ELECTRICAL_ARC:
      "Please don't touch anything that's sparking, and stay away from it. If you can reach your breaker panel safely, shut the power off.",
    FLOODING:
      "If you can reach the main water shutoff safely, turn it off. Stay away from any standing water near outlets or appliances.",
    SEWAGE_BACKUP:
      "Please keep everyone away from the water, and don't run any more water down the drains.",
    NO_HEAT_FREEZING:
      "Please don't use an oven or a grill to heat the house. Keep everyone in one room, and layer up.",
    VULNERABLE_PERSON_AT_RISK:
      "Please get them somewhere safe first, away from the problem.",
  },

  transfer: {
    DIAL_911_GUIDANCE:
      "If anyone is in danger, hang up and call 911. Otherwise, stay on the line and I'll get you to a person right now.",
    WARM_TRANSFER: "Hold on, I'm getting you to someone right now.",
    DECLINE: "Thanks for calling.",
  },

  faq: {
    // Says nothing, on purpose. It is spoken *before* we know whether we have an
    // answer, so anything load-bearing here would be a promise we cannot keep.
    filler: "Let me check that for you.",
    unknown: "Let me have someone call you back on that.",
  },

  closing:
    "You're all set. {business} will text a confirmation to {phone}. Thanks for calling.",
};
