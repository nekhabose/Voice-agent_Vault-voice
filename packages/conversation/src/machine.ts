import {
  CONTAINED_OUTCOMES,
  EMERGENCY_INTERRUPTIBLE_STATES,
  HAZARD_ACTIONS,
  STATE_SPECS,
  type CallOutcome,
  type CallState,
  type Effect,
  type EscalationAction,
  type EscalationReason,
  type Guard,
  type HazardDetection,
  type SlotKey,
} from "@ledgerline/contracts";
import { SlotBook, type FillInput } from "./slot-book.js";

/**
 * `Effect` and `EscalationAction` are defined in `contracts` — they cross into
 * `Utterer` and, at Step 4, into the Python worker. Re-exported here because
 * this module is where they are produced.
 */
export type { Effect, EscalationAction };

/* -------------------------------------------------------------------------- */
/* Context                                                                     */
/* -------------------------------------------------------------------------- */

export interface Escalation {
  readonly reason: EscalationReason;
  readonly hazard: HazardDetection | null;
}

export interface MachineContext {
  readonly state: CallState;
  readonly slots: SlotBook;
  readonly outcome: CallOutcome | null;
  readonly escalation: Escalation | null;
  /** Milestones the *agent* has performed, as distinct from facts the caller gave. */
  readonly greetingDelivered: boolean;
  readonly hazardGuidanceDelivered: boolean;
  /** Consecutive failed extractions per slot; drives the give-up escalation. */
  readonly extractionFailures: Readonly<Partial<Record<SlotKey, number>>>;
}

export function initialContext(): MachineContext {
  return {
    state: "GREETING",
    slots: SlotBook.empty(),
    outcome: null,
    escalation: null,
    greetingDelivered: false,
    hazardGuidanceDelivered: false,
    extractionFailures: {},
  };
}

/* -------------------------------------------------------------------------- */
/* Guards                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A guard may do more than pass or fail.
 *
 * `block` holds the call in the current state — we are simply not ready yet.
 * `escalate` ends the happy path. Distinguishing them is what lets an address
 * outside the service area route to a human instead of quietly stalling the
 * caller in QUALIFY forever.
 */
export type GuardVerdict =
  | { readonly kind: "pass" }
  | { readonly kind: "block" }
  | { readonly kind: "escalate"; readonly reason: EscalationReason };

export const PASS: GuardVerdict = { kind: "pass" };
export const BLOCK: GuardVerdict = { kind: "block" };

export type GuardFn = (ctx: MachineContext) => GuardVerdict;
export type GuardSet = Readonly<Record<Guard, GuardFn>>;

/**
 * Guards that need nothing but the context. `address_in_service_area` is not
 * here: it depends on the tenant's polygon, so the runtime must supply it.
 */
export const BUILT_IN_GUARDS: Readonly<Omit<GuardSet, "address_in_service_area">> = {
  greeting_delivered: (ctx) => (ctx.greetingDelivered ? PASS : BLOCK),
  hazard_guidance_delivered: (ctx) => (ctx.hazardGuidanceDelivered ? PASS : BLOCK),
  all_confirmations_satisfied: (ctx) =>
    ctx.slots.allConfirmationsSatisfied() ? PASS : BLOCK,
};

/** A service-area guard for tenants that have not drawn a polygon yet. */
export const ALLOW_ALL_SERVICE_AREAS: GuardFn = () => PASS;

export function makeGuards(addressInServiceArea: GuardFn): GuardSet {
  return { ...BUILT_IN_GUARDS, address_in_service_area: addressInServiceArea };
}

/* -------------------------------------------------------------------------- */
/* Events & effects                                                            */
/* -------------------------------------------------------------------------- */

export type MachineEvent =
  | { readonly type: "AGENT_GREETED" }
  | {
      readonly type: "SLOT_FILLED";
      readonly key: SlotKey;
      readonly value: unknown;
      readonly input: FillInput;
    }
  | { readonly type: "SLOT_CONFIRMED"; readonly key: SlotKey }
  | { readonly type: "SLOT_RETRACTED"; readonly key: SlotKey }
  /** The extractor ran and came back with nothing usable for `key`. */
  | { readonly type: "EXTRACTION_FAILED"; readonly key: SlotKey }
  /** From the deterministic classifier, never from the LLM. */
  | { readonly type: "HAZARD_DETECTED"; readonly detection: HazardDetection }
  | { readonly type: "HAZARD_GUIDANCE_DELIVERED" }
  | { readonly type: "CALLER_REQUESTED_HUMAN" }
  | { readonly type: "CALLER_HUNG_UP" }
  /**
   * A dependency we own failed, and the caller is not at fault.
   *
   * `EscalationReason.AGENT_ERROR` and its catalog line ("Something's gone wrong
   * on my end") both existed from day one with no event that could reach them.
   * The extractor's `unavailable` outcome is what reaches them: an Anthropic
   * outage, after one bounded retry, is a human's problem rather than a caller
   * who gets asked their name a fourth time (plan, §10.3).
   */
  | { readonly type: "AGENT_ERROR"; readonly reason: string };

export interface TransitionResult {
  readonly context: MachineContext;
  /** States entered, in order. Empty when the event moved nothing. */
  readonly transitions: readonly CallState[];
  readonly effects: readonly Effect[];
  /** Set when the event was rejected (bad value, confirming an empty slot). */
  readonly rejection: string | null;
}

export interface MachineOptions {
  readonly guards: GuardSet;
  /** Consecutive failures on one slot before we stop wasting the caller's time. */
  readonly maxExtractionFailures?: number;
}

const DEFAULT_MAX_EXTRACTION_FAILURES = 3;

/** Strictly greater than the longest possible walk through the graph. */
const MAX_ADVANCE_STEPS = 16;

/* -------------------------------------------------------------------------- */
/* Transition                                                                  */
/* -------------------------------------------------------------------------- */

const OUTCOME_FOR_ESCALATION: Record<EscalationReason, CallOutcome> = {
  EMERGENCY_HAZARD: "ESCALATED_EMERGENCY",
  OUT_OF_SERVICE_AREA: "OUT_OF_SERVICE_AREA",
  CALLER_REQUESTED_HUMAN: "ESCALATED_OTHER",
  REPEATED_EXTRACTION_FAILURE: "ESCALATED_OTHER",
  AGENT_ERROR: "AGENT_ERROR",
};

const ACTION_FOR_ESCALATION: Record<EscalationReason, EscalationAction> = {
  EMERGENCY_HAZARD: "WARM_TRANSFER", // overridden per-hazard below
  OUT_OF_SERVICE_AREA: "DECLINE",
  CALLER_REQUESTED_HUMAN: "WARM_TRANSFER",
  REPEATED_EXTRACTION_FAILURE: "WARM_TRANSFER",
  AGENT_ERROR: "WARM_TRANSFER",
};

/**
 * Advance the call by one event.
 *
 * Pure: same context and event in, same result out. The model is never asked
 * whether it is time to move on — this function decides, from validated slots
 * (plan, principle #1).
 */
export function transition(
  ctx: MachineContext,
  event: MachineEvent,
  options: MachineOptions,
): TransitionResult {
  if (STATE_SPECS[ctx.state].terminal) {
    return { context: ctx, transitions: [], effects: [], rejection: "call is over" };
  }

  const applied = applyEvent(ctx, event, options);
  if (applied.rejection !== null) {
    return {
      context: applied.context,
      transitions: [],
      effects: applied.effects,
      rejection: applied.rejection,
    };
  }

  const advanced = advance(applied.context, options.guards);

  return {
    context: advanced.context,
    transitions: advanced.transitions,
    effects: [
      ...applied.effects,
      ...advanced.effects,
      ...nextPrompt(advanced.context),
    ],
    rejection: null,
  };
}

interface ApplyResult {
  readonly context: MachineContext;
  readonly effects: readonly Effect[];
  readonly rejection: string | null;
}

function applyEvent(
  ctx: MachineContext,
  event: MachineEvent,
  options: MachineOptions,
): ApplyResult {
  const noEffects: readonly Effect[] = [];

  switch (event.type) {
    case "AGENT_GREETED":
      return {
        context: { ...ctx, greetingDelivered: true },
        effects: noEffects,
        rejection: null,
      };

    case "HAZARD_GUIDANCE_DELIVERED":
      return {
        context: { ...ctx, hazardGuidanceDelivered: true },
        effects: noEffects,
        rejection: null,
      };

    case "HAZARD_DETECTED": {
      if (!EMERGENCY_INTERRUPTIBLE_STATES.includes(ctx.state)) {
        return { context: ctx, effects: noEffects, rejection: "not interruptible" };
      }
      const action = HAZARD_ACTIONS[event.detection.category];
      return {
        context: {
          ...ctx,
          state: "EMERGENCY",
          escalation: { reason: "EMERGENCY_HAZARD", hazard: event.detection },
        },
        effects: [
          {
            type: "ESCALATE",
            reason: "EMERGENCY_HAZARD",
            action,
            hazard: event.detection,
          },
        ],
        rejection: null,
      };
    }

    case "CALLER_REQUESTED_HUMAN":
      return { context: escalateNow(ctx, "CALLER_REQUESTED_HUMAN"), effects: escalationEffects("CALLER_REQUESTED_HUMAN"), rejection: null };

    case "AGENT_ERROR":
      return {
        context: escalateNow(ctx, "AGENT_ERROR"),
        effects: escalationEffects("AGENT_ERROR"),
        rejection: null,
      };

    case "CALLER_HUNG_UP":
      return {
        context: { ...ctx, state: "CLOSE", outcome: "CALLER_HUNG_UP" },
        effects: noEffects,
        rejection: null,
      };

    case "SLOT_CONFIRMED": {
      const r = ctx.slots.confirm(event.key);
      if (!r.ok) {
        return { context: ctx, effects: noEffects, rejection: r.error.message };
      }
      return { context: { ...ctx, slots: r.book }, effects: noEffects, rejection: null };
    }

    case "SLOT_RETRACTED":
      return {
        context: { ...ctx, slots: ctx.slots.unconfirm(event.key) },
        effects: noEffects,
        rejection: null,
      };

    case "EXTRACTION_FAILED":
      return recordExtractionFailure(ctx, event.key, options);

    case "SLOT_FILLED": {
      const r = ctx.slots.fill(event.key, event.value, event.input);
      if (!r.ok) {
        // A hallucinated shape is an extraction failure, not a stored fact.
        return recordExtractionFailure(ctx, event.key, options, r.error.message);
      }
      return {
        context: {
          ...ctx,
          slots: r.book,
          extractionFailures: { ...ctx.extractionFailures, [event.key]: 0 },
        },
        effects: noEffects,
        rejection: null,
      };
    }
  }
}

function recordExtractionFailure(
  ctx: MachineContext,
  key: SlotKey,
  options: MachineOptions,
  rejection: string | null = null,
): ApplyResult {
  const limit = options.maxExtractionFailures ?? DEFAULT_MAX_EXTRACTION_FAILURES;
  const count = (ctx.extractionFailures[key] ?? 0) + 1;
  const withCount: MachineContext = {
    ...ctx,
    extractionFailures: { ...ctx.extractionFailures, [key]: count },
  };

  if (count >= limit) {
    return {
      context: escalateNow(withCount, "REPEATED_EXTRACTION_FAILURE"),
      effects: escalationEffects("REPEATED_EXTRACTION_FAILURE"),
      rejection: null,
    };
  }
  return { context: withCount, effects: [], rejection };
}

function escalateNow(
  ctx: MachineContext,
  reason: EscalationReason,
): MachineContext {
  return {
    ...ctx,
    state: "HANDOFF",
    outcome: OUTCOME_FOR_ESCALATION[reason],
    escalation: { reason, hazard: null },
  };
}

function escalationEffects(reason: EscalationReason): readonly Effect[] {
  return [
    {
      type: "ESCALATE",
      reason,
      action: ACTION_FOR_ESCALATION[reason],
      hazard: null,
    },
  ];
}

interface AdvanceResult {
  readonly context: MachineContext;
  readonly transitions: readonly CallState[];
  readonly effects: readonly Effect[];
}

/**
 * Walk forward as far as the validated slots allow.
 *
 * The loop — rather than a single step — is what makes out-of-order fills work:
 * a caller who opens with "Hi, it's Rosa at 1247 Calle Ocho, my heater's dead,
 * can someone come Thursday morning?" satisfies four states at once, and we
 * take all four rather than interrogating them for facts they already gave.
 */
function advance(start: MachineContext, guards: GuardSet): AdvanceResult {
  let ctx = start;
  const transitions: CallState[] = [];
  const effects: Effect[] = [];

  // Bounded by the graph's length; the cap turns a mis-specified cycle into a
  // stalled call rather than a hung worker.
  for (let step = 0; step < MAX_ADVANCE_STEPS; step++) {
    const spec = STATE_SPECS[ctx.state];
    if (spec.terminal || spec.next === null) break;

    const slotsReady = spec.requiredSlots.every((k) => ctx.slots.isSatisfied(k));
    if (!slotsReady) break;

    let blocked = false;
    for (const guard of spec.guards) {
      const verdict = guards[guard](ctx);
      if (verdict.kind === "escalate") {
        ctx = escalateNow(ctx, verdict.reason);
        transitions.push("HANDOFF");
        effects.push(...escalationEffects(verdict.reason));
        return { context: ctx, transitions, effects };
      }
      if (verdict.kind === "block") {
        blocked = true;
        break;
      }
    }
    if (blocked) break;

    const next = spec.next;
    const enteringFromEmergency = ctx.state === "EMERGENCY";
    ctx = { ...ctx, state: next };
    transitions.push(next);

    if (next === "CLOSE") {
      ctx = { ...ctx, outcome: "BOOKED" };
      effects.push({ type: "CREATE_PENDING_BOOKING" });
      break;
    }
    if (next === "HANDOFF") {
      if (enteringFromEmergency) {
        ctx = { ...ctx, outcome: "ESCALATED_EMERGENCY" };
      }
      break;
    }
  }

  return { context: ctx, transitions, effects };
}

/**
 * What the agent should say next: greet, read back an unconfirmed critical
 * slot, or ask for the next missing required one. Exactly one prompt per turn —
 * the model is never handed a menu of tools to choose between (plan,
 * principle #1).
 *
 * Exported because a call opens with no event at all. The worker asks
 * `nextPrompt(initialContext())` and is told to `GREET`, which is how the AI
 * disclosure reaches the caller before the `greeting_delivered` guard will let
 * the call move.
 */
export function nextPrompt(ctx: MachineContext): readonly Effect[] {
  const spec = STATE_SPECS[ctx.state];
  if (spec.terminal) return [];

  // Reachable only before AGENT_GREETED: the guard passes the moment the
  // greeting lands, and `advance()` leaves GREETING in the same transition.
  if (ctx.state === "GREETING") return [{ type: "GREET" }];

  if (ctx.state === "CONFIRM") {
    const pending = ctx.slots.pendingConfirmations();
    const first = pending[0];
    return first ? [{ type: "READ_BACK", key: first }] : [];
  }

  const missing = spec.requiredSlots.filter((k) => !ctx.slots.isSatisfied(k));
  if (missing.length === 0) return [];

  // Prefer the state's declared focus so the conversation has a natural spine,
  // but fall back to whatever else is still missing.
  const focus = spec.focus;
  const key = focus && missing.includes(focus) ? focus : missing[0]!;
  return [{ type: "ASK_FOR", key }];
}

/* -------------------------------------------------------------------------- */
/* Derived                                                                     */
/* -------------------------------------------------------------------------- */

export function isTerminal(ctx: MachineContext): boolean {
  return STATE_SPECS[ctx.state].terminal;
}

/** Booked with no human involvement. Derived, never hand-set. */
export function isContained(ctx: MachineContext): boolean {
  return ctx.outcome !== null && CONTAINED_OUTCOMES.includes(ctx.outcome);
}

/** Convenience for drivers: fold a batch of events in order. */
export function run(
  ctx: MachineContext,
  events: readonly MachineEvent[],
  options: MachineOptions,
): MachineContext {
  return events.reduce((acc, e) => transition(acc, e, options).context, ctx);
}
