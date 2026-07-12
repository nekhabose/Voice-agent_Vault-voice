import { z } from "zod";
import { HazardDetectionSchema } from "./emergency.js";
import { SlotKeySchema } from "./slots.js";
import { EscalationReasonSchema } from "./states.js";

/**
 * What the voice runtime should do next. The machine decides; the audio layer
 * merely performs (plan, §10.4).
 *
 * This lives in `contracts` rather than in `conversation` for two reasons, and
 * both are about crossing a boundary:
 *
 * - `Utterer.say(effect, ctx)` turns an effect into words, and `contracts`
 *   cannot import `conversation` without a cycle.
 * - The Python worker is the only thing that performs effects, and the Pydantic
 *   it performs them with is generated from the Zod here (task 4.1). A type
 *   that crosses the language boundary belongs in the spine.
 */

export const EscalationActionSchema = z.enum([
  "WARM_TRANSFER",
  "DIAL_911_GUIDANCE",
  /** Out of service area: no human needed, just a courteous close. */
  "DECLINE",
]);
export type EscalationAction = z.infer<typeof EscalationActionSchema>;

export const EFFECT_TYPES = [
  "GREET",
  "ASK_FOR",
  "READ_BACK",
  "ESCALATE",
  "CREATE_PENDING_BOOKING",
  "SAY_FILLER",
  "ANSWER_FAQ",
] as const;
export type EffectType = (typeof EFFECT_TYPES)[number];

/**
 * The two effects `transition()` never emits.
 *
 * A caller who asks "do you charge for the estimate?" has not advanced the state
 * machine and must not be allowed to: the FAQ detour is a side-channel that
 * answers a question and then puts the same slot back in front of them
 * (`CallRuntime.answerQuestion`). It changes no slot, no state, and no guard, so
 * it is not a machine event — but it is still an effect, because the audio layer
 * is the thing that has to speak it, and the Python worker performs exactly this
 * union (task 4.1).
 *
 * Listed rather than merely implied, so that a reader of `machine.ts` who cannot
 * find where these are produced does not conclude they are dead.
 */
export const RUNTIME_ONLY_EFFECT_TYPES = ["SAY_FILLER", "ANSWER_FAQ"] as const;

export const EffectSchema = z.discriminatedUnion("type", [
  /**
   * Speak the greeting and the AI disclosure, then emit `AGENT_GREETED`.
   *
   * The `greeting_delivered` guard holds the call in GREETING until this has
   * happened, which is what makes the disclosure a precondition of the
   * conversation rather than a courtesy at the top of it. The disclosure is a
   * committed, reviewed, verbatim string — never a runtime paraphrase (Step 3
   * exit criterion; it is a compliance requirement, not a preference).
   */
  z.object({ type: z.literal("GREET") }),
  z.object({ type: z.literal("ASK_FOR"), key: SlotKeySchema }),
  z.object({ type: z.literal("READ_BACK"), key: SlotKeySchema }),
  z.object({
    type: z.literal("ESCALATE"),
    reason: EscalationReasonSchema,
    action: EscalationActionSchema,
    hazard: HazardDetectionSchema.nullable(),
  }),
  z.object({ type: z.literal("CREATE_PENDING_BOOKING") }),
  /**
   * Buy the FAQ retrieval its time out loud. Content-free by construction: a
   * filler that said anything load-bearing would be a sentence spoken before we
   * knew whether we could answer (plan, §6 call site #3 — "never blocks the
   * audio path" means the caller hears something *while* we look, not that the
   * lookup is fast).
   */
  z.object({ type: z.literal("SAY_FILLER") }),
  /**
   * Speak the contractor's committed FAQ answer, or admit we do not have one.
   *
   * `answer` is a string the **contractor wrote**, retrieved verbatim — never a
   * sentence a model composed. The model's job at this call site is to *select*
   * which committed answer (if any) responds to the question; selection is a
   * classification, and composition would be a model quoting a price nobody
   * approved. `null` means no committed answer covers it, and the catalog's
   * "someone will call you back" line is what the caller hears (principle #3).
   */
  z.object({ type: z.literal("ANSWER_FAQ"), answer: z.string().nullable() }),
]);

export type Effect = z.infer<typeof EffectSchema>;
