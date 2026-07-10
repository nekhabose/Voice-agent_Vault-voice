import { z } from "zod";
import { E164Schema, IsoTimestampSchema, LocaleSchema } from "./primitives.js";
import { CallOutcomeSchema, CallStateSchema } from "./states.js";

/**
 * Per-turn trace. Emitted for every turn of every call, in production, from day
 * one (plan, principle #5) — idea.md §7's biggest open question is that these
 * numbers do not exist in the field.
 *
 * Field names deliberately mirror Full-Duplex-Bench-v3's measurement
 * definitions so our numbers are comparable to the literature rather than
 * merely internally consistent.
 */
export const CallTurnSchema = z.object({
  callId: z.string().uuid(),
  idx: z.number().int().nonnegative(),
  role: z.enum(["caller", "agent"]),
  state: CallStateSchema,
  text: z.string(),
  /**
   * Time from end-of-caller-speech to agent first word. The metric the plan
   * budgets at p95 < 1.2s.
   */
  firstWordLatencyMs: z.number().int().nonnegative().nullable(),
  /** End-of-caller-speech to end-of-agent-turn. Budgeted at p95 < 2.0s. */
  turnLatencyMs: z.number().int().nonnegative().nullable(),
  /** The agent spoke over the caller. Lower is better (GPT-Realtime ≈ 13.5%). */
  bargeIn: z.boolean(),
  /**
   * The agent responded at all. Gemini Live's failure mode was silence in 22%
   * of scenarios — speed that produces silence is not speed.
   */
  turnTakeOk: z.boolean(),
  createdAt: IsoTimestampSchema,
});
export type CallTurn = z.infer<typeof CallTurnSchema>;

export const CallRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  fromE164: E164Schema,
  startedAt: IsoTimestampSchema,
  endedAt: IsoTimestampSchema.nullable(),
  /**
   * Locales observed on the call. The product is English-only, so in practice
   * this is `["en"]`. The array shape and `LocaleSchema` stay because keeping the
   * core wedge-agnostic is what made the English-only pivot cost nothing.
   */
  localesDetected: z.array(LocaleSchema),
  outcome: CallOutcomeSchema.nullable(),
  /** Booked with no human involvement. Derived, never hand-set. */
  containment: z.boolean(),
  recordingUrl: z.string().url().nullable(),
  transcriptUrl: z.string().url().nullable(),
});
export type CallRecord = z.infer<typeof CallRecordSchema>;

/**
 * Rolled-up reliability figures. Shown to the contractor as the value proof,
 * and published by us as the field numbers nobody else has.
 */
export const ReliabilityMetricsSchema = z.object({
  calls: z.number().int().nonnegative(),
  containmentRate: z.number().min(0).max(1),
  /** Fraction of committed bookings the contractor later edited or cancelled. */
  correctionRate: z.number().min(0).max(1),
  bargeInRate: z.number().min(0).max(1),
  turnTakeRate: z.number().min(0).max(1),
  firstWordLatencyP50Ms: z.number().nonnegative(),
  firstWordLatencyP95Ms: z.number().nonnegative(),
  turnLatencyP95Ms: z.number().nonnegative(),
});
export type ReliabilityMetrics = z.infer<typeof ReliabilityMetricsSchema>;
