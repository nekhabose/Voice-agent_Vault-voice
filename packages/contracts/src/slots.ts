import { z } from "zod";
import {
  AddressSchema,
  ConfidenceSchema,
  E164Schema,
  TimeWindowSchema,
  UrgencySchema,
  type Address,
  type TimeWindow,
  type Urgency,
} from "./primitives.js";

/**
 * The entire set of facts a call must establish. The plan's core bet is that
 * this list stays short: "a form with five fields and a decision tree, not an
 * open-ended dialogue".
 *
 * Adding a key here is a product decision, not a refactor — it widens the
 * surface the model has to be correct on.
 */
export const SLOT_KEYS = [
  "caller_name",
  "callback_phone",
  "service_address",
  "problem_description",
  "urgency",
  "appointment_window",
] as const;

export const SlotKeySchema = z.enum(SLOT_KEYS);
export type SlotKey = (typeof SLOT_KEYS)[number];

/** Compile-time map from slot key to the type of its value. */
export interface SlotValueMap {
  caller_name: string;
  callback_phone: string;
  service_address: Address;
  problem_description: string;
  urgency: Urgency;
  appointment_window: TimeWindow;
}

export type SlotValue<K extends SlotKey = SlotKey> = SlotValueMap[K];

/**
 * When a slot value must be read back to the caller before it is allowed to
 * reach the contractor's CRM.
 *
 * `always`            — a wrong value costs a truck roll or a missed SMS.
 * `if_low_confidence` — a wrong value is recoverable; only confirm when the
 *                       extractor is unsure (see LOW_CONFIDENCE_THRESHOLD).
 */
export const ConfirmationPolicySchema = z.enum([
  "always",
  "if_low_confidence",
]);
export type ConfirmationPolicy = z.infer<typeof ConfirmationPolicySchema>;

export interface SlotSpec<K extends SlotKey = SlotKey> {
  readonly key: K;
  readonly schema: z.ZodType<SlotValueMap[K]>;
  readonly confirmation: ConfirmationPolicy;
  /**
   * Counted in the critical-slot accuracy metric (plan, Phase 0) — the fields
   * whose transcription errors cost money. Deliberately excludes
   * `callback_phone`, which is prefilled from the inbound ANI rather than
   * transcribed from speech, so it cannot contribute ASR error.
   */
  readonly criticalForAsrMetric: boolean;
  /** Human-readable label used in read-back prompts and the dashboard. */
  readonly label: string;
}

/**
 * The single source of truth for slot behaviour. The state machine, the
 * validators, the read-back prompts, and the eval scorer all read this — no
 * one re-lists slot names.
 */
export const SLOT_SPECS: { readonly [K in SlotKey]: SlotSpec<K> } = {
  caller_name: {
    key: "caller_name",
    schema: z.string().trim().min(1).max(120),
    confirmation: "if_low_confidence",
    criticalForAsrMetric: true,
    label: "name",
  },
  callback_phone: {
    key: "callback_phone",
    schema: E164Schema,
    confirmation: "always",
    criticalForAsrMetric: false,
    label: "callback number",
  },
  service_address: {
    key: "service_address",
    schema: AddressSchema,
    confirmation: "always",
    criticalForAsrMetric: true,
    label: "service address",
  },
  problem_description: {
    key: "problem_description",
    schema: z.string().trim().min(3).max(2000),
    confirmation: "if_low_confidence",
    criticalForAsrMetric: true,
    label: "problem",
  },
  urgency: {
    key: "urgency",
    schema: UrgencySchema,
    confirmation: "if_low_confidence",
    criticalForAsrMetric: true,
    label: "urgency",
  },
  appointment_window: {
    key: "appointment_window",
    schema: TimeWindowSchema,
    confirmation: "always",
    criticalForAsrMetric: true,
    label: "appointment window",
  },
};

export const CRITICAL_ASR_SLOTS: readonly SlotKey[] = SLOT_KEYS.filter(
  (k) => SLOT_SPECS[k].criticalForAsrMetric,
);

/** Outcome of running a slot's validator (geocoder, E.164 parse, ...). */
export const ValidatorResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("valid") }),
  z.object({ status: z.literal("invalid"), reason: z.string() }),
  /** Validator could not run (geocoder down). Value is unverified, not wrong. */
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);
export type ValidatorResult = z.infer<typeof ValidatorResultSchema>;

export const VALID: ValidatorResult = { status: "valid" };

export const invalid = (reason: string): ValidatorResult => ({
  status: "invalid",
  reason,
});

/**
 * The validator could not run. The value is unverified, not wrong — callers
 * must not treat this as a rejection, or a geocoder outage becomes an outage
 * of the whole product.
 */
export const unavailable = (reason: string): ValidatorResult => ({
  status: "unavailable",
  reason,
});

/**
 * A slot as persisted. `confirmedByCaller` and the eventual
 * `outcomes.correctedFields` are what make the plan's reliability claims
 * measurable rather than asserted.
 */
export const SlotRecordSchema = z.object({
  key: SlotKeySchema,
  value: z.unknown(),
  confidence: ConfidenceSchema,
  confirmedByCaller: z.boolean(),
  validatorResult: ValidatorResultSchema,
  /** Bumped each time the caller corrects this slot; feeds the correction rate. */
  revision: z.number().int().nonnegative(),
});
export type SlotRecord = z.infer<typeof SlotRecordSchema>;
