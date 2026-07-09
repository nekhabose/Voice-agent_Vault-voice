import { z } from "zod";
import { SLOT_KEYS, type SlotKey } from "./slots.js";

/**
 * The conversation graph.
 *
 *   GREETING → IDENTIFY → TRIAGE → QUALIFY → SCHEDULE → CONFIRM → CLOSE
 *                            ↓
 *                        EMERGENCY → HANDOFF
 *
 * The model never decides to move between these. Our code advances the state
 * when a validated *required set* is satisfied (plan, principle #1). In any
 * given state the model is handed exactly one tool, which records one fact.
 */
export const CALL_STATES = [
  "GREETING",
  "IDENTIFY",
  "TRIAGE",
  "QUALIFY",
  "SCHEDULE",
  "CONFIRM",
  "CLOSE",
  "EMERGENCY",
  "HANDOFF",
] as const;

export const CallStateSchema = z.enum(CALL_STATES);
export type CallState = (typeof CALL_STATES)[number];

/** Why a call left the happy path. Mirrors `escalations.reason`. */
export const EscalationReasonSchema = z.enum([
  "EMERGENCY_HAZARD",
  "OUT_OF_SERVICE_AREA",
  "CALLER_REQUESTED_HUMAN",
  "REPEATED_EXTRACTION_FAILURE",
  "AGENT_ERROR",
]);
export type EscalationReason = z.infer<typeof EscalationReasonSchema>;

/**
 * Guards are named here rather than inlined so the graph stays declarative and
 * testable in isolation. The engine resolves them against call context.
 */
export const GUARDS = [
  /** The greeting and the AI disclosure have actually been spoken. */
  "greeting_delivered",
  /** Geocoded address falls inside the tenant's service-area polygon. */
  "address_in_service_area",
  /** Every slot whose policy demands read-back has been confirmed. */
  "all_confirmations_satisfied",
  /** Life-safety guidance was read before we drop the caller onto a human. */
  "hazard_guidance_delivered",
] as const;
export type Guard = (typeof GUARDS)[number];

export interface StateSpec {
  readonly state: CallState;
  /**
   * Slots that must be present and pass validation before the call may leave
   * this state. Confirmation is *not* required here — read-back happens in
   * CONFIRM, so demanding it earlier would deadlock the graph.
   */
  readonly requiredSlots: readonly SlotKey[];
  /** Guards that must hold, in addition to the required slots. */
  readonly guards: readonly Guard[];
  /** Where a satisfied state advances to. `null` for terminal states. */
  readonly next: CallState | null;
  readonly terminal: boolean;
  /**
   * The slot the agent proactively asks for while in this state. Callers may
   * still volunteer any other slot at any time — see `SlotBook` out-of-order
   * fills — but this is what an unprompted turn drives toward.
   */
  readonly focus: SlotKey | null;
}

export const STATE_SPECS: { readonly [S in CallState]: StateSpec } = {
  GREETING: {
    state: "GREETING",
    requiredSlots: [],
    // Without this the graph would advance before the caller heard a word.
    guards: ["greeting_delivered"],
    next: "IDENTIFY",
    terminal: false,
    focus: null,
  },
  IDENTIFY: {
    state: "IDENTIFY",
    requiredSlots: ["caller_name", "callback_phone"],
    guards: [],
    next: "TRIAGE",
    terminal: false,
    focus: "caller_name",
  },
  TRIAGE: {
    state: "TRIAGE",
    requiredSlots: ["problem_description", "urgency"],
    guards: [],
    next: "QUALIFY",
    terminal: false,
    focus: "problem_description",
  },
  QUALIFY: {
    state: "QUALIFY",
    requiredSlots: ["service_address"],
    guards: ["address_in_service_area"],
    next: "SCHEDULE",
    terminal: false,
    focus: "service_address",
  },
  SCHEDULE: {
    state: "SCHEDULE",
    requiredSlots: ["appointment_window"],
    guards: [],
    next: "CONFIRM",
    terminal: false,
    focus: "appointment_window",
  },
  CONFIRM: {
    state: "CONFIRM",
    requiredSlots: [...SLOT_KEYS],
    guards: ["all_confirmations_satisfied"],
    next: "CLOSE",
    terminal: false,
    focus: null,
  },
  CLOSE: {
    state: "CLOSE",
    requiredSlots: [],
    guards: [],
    next: null,
    terminal: true,
    focus: null,
  },
  EMERGENCY: {
    state: "EMERGENCY",
    requiredSlots: [],
    // We never simply hang up on a gas leak; the guidance is read first.
    guards: ["hazard_guidance_delivered"],
    next: "HANDOFF",
    terminal: false,
    focus: null,
  },
  HANDOFF: {
    state: "HANDOFF",
    requiredSlots: [],
    guards: [],
    next: null,
    terminal: true,
    focus: null,
  },
};

/** States from which the emergency classifier may hard-interrupt the graph. */
export const EMERGENCY_INTERRUPTIBLE_STATES: readonly CallState[] =
  CALL_STATES.filter((s) => !STATE_SPECS[s].terminal && s !== "EMERGENCY");

/** How a call ended. Mirrors `calls.outcome`. */
export const CallOutcomeSchema = z.enum([
  /** Booked without a human ever touching it — the containment numerator. */
  "BOOKED",
  "ESCALATED_EMERGENCY",
  "ESCALATED_OTHER",
  "CALLER_HUNG_UP",
  "OUT_OF_SERVICE_AREA",
  "AGENT_ERROR",
]);
export type CallOutcome = z.infer<typeof CallOutcomeSchema>;

/** Outcomes that count as containment: agent finished the job unaided. */
export const CONTAINED_OUTCOMES: readonly CallOutcome[] = ["BOOKED"];
