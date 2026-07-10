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
] as const;
export type EffectType = (typeof EFFECT_TYPES)[number];

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
]);

export type Effect = z.infer<typeof EffectSchema>;
