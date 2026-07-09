import { z } from "zod";

/**
 * Hazards that bypass the state machine entirely and warm-transfer to a human
 * within one turn (plan, principle #4).
 *
 * Detection is deterministic keyword + fuzzy matching. It does not consult an
 * LLM, because it must work when the LLM is down, rate-limited, or wrong.
 */
export const HAZARD_CATEGORIES = [
  "GAS_LEAK",
  "CARBON_MONOXIDE",
  "FIRE",
  "ELECTRICAL_ARC",
  "FLOODING",
  "SEWAGE_BACKUP",
  "NO_HEAT_FREEZING",
  /** A hazard co-occurring with a child, infant, or elderly person. */
  "VULNERABLE_PERSON_AT_RISK",
] as const;

export const HazardCategorySchema = z.enum(HAZARD_CATEGORIES);
export type HazardCategory = (typeof HAZARD_CATEGORIES)[number];

/**
 * What the agent must do when a hazard fires. `DIAL_911_GUIDANCE` means the
 * agent reads life-safety guidance before transferring — it never simply hangs
 * up on a gas leak.
 */
export const HazardActionSchema = z.enum([
  "WARM_TRANSFER",
  "DIAL_911_GUIDANCE",
]);
export type HazardAction = z.infer<typeof HazardActionSchema>;

export const HAZARD_ACTIONS: { readonly [H in HazardCategory]: HazardAction } =
  {
    GAS_LEAK: "DIAL_911_GUIDANCE",
    CARBON_MONOXIDE: "DIAL_911_GUIDANCE",
    FIRE: "DIAL_911_GUIDANCE",
    ELECTRICAL_ARC: "DIAL_911_GUIDANCE",
    FLOODING: "WARM_TRANSFER",
    SEWAGE_BACKUP: "WARM_TRANSFER",
    NO_HEAT_FREEZING: "WARM_TRANSFER",
    VULNERABLE_PERSON_AT_RISK: "WARM_TRANSFER",
  };

export const HazardDetectionSchema = z.object({
  category: HazardCategorySchema,
  action: HazardActionSchema,
  /** The substring of the utterance that fired the rule — for audit. */
  matchedText: z.string(),
  /** Which lexicon rule fired. Lets us tune precision per-rule. */
  ruleId: z.string(),
});
export type HazardDetection = z.infer<typeof HazardDetectionSchema>;
