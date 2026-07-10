import {
  CRITICAL_ASR_SLOTS,
  VALID,
  type CallOutcome,
  type CallState,
  type ExtractionContext,
  type HazardCategory,
  type SlotExtractor,
  type SlotKey,
} from "@ledgerline/contracts";
import {
  BUILT_IN_GUARDS,
  initialContext,
  isContained,
  transition,
  type Effect,
  type GuardFn,
  type MachineContext,
  type MachineEvent,
} from "@ledgerline/conversation";
import { classify } from "@ledgerline/safety";
import {
  validateAddress,
  validatePhone,
  validateWindow,
  type Geocoder,
  type WindowPolicy,
} from "@ledgerline/validators";

/**
 * Simulated-caller harness (plan, Step 5).
 *
 * A persona dials the agent and we score what came out. Runs the *real* state
 * machine, the *real* emergency classifier, the *real* validators, and — as of
 * Step 5.1 — the *real* `SlotExtractor` port. The caller's utterance text is
 * handed to `deps.makeExtractor(scenario).extract(key, text, ctx)`, exactly as
 * `CallRuntime` does it; the PR suite binds `FakeExtractor` (scripted from the
 * scenario's fills) and the nightly arm binds `AnthropicExtractor` over the same
 * seam. The extractor is no longer a stub baked into the scenario — a fill now
 * *declares* which slot a turn states and scripts the fake, and the value flows
 * back through the port and the validators, not straight into the machine.
 *
 * Two things are still declarative rather than extracted, on purpose: whether a
 * caller *confirms* a read-back (a yes/no is not a slot value), and the classifier
 * runs on the raw text before any model, as it must (principle #4).
 *
 * The SIP path is out of scope here. This harness answers "given what the
 * caller said, does the system do the right thing?"; a real-SIP variant (task
 * 5.3) is what makes the latency and barge-in numbers comparable to
 * Full-Duplex-Bench-v3.
 */

/** What the extractor would have produced from this utterance. */
export interface SlotFill {
  readonly key: SlotKey;
  /** Raw, pre-validation. Phone strings, address parts, window instants. */
  readonly raw: unknown;
  readonly confidence?: number;
}

export interface ScenarioTurn {
  readonly text: string;
  readonly fills?: readonly SlotFill[];
  /** The caller agrees with the single value the agent last read back. */
  readonly confirms?: boolean;
  /** "Yes, that's all correct" — agrees with the whole read-back summary. */
  readonly confirmsAll?: boolean;
  readonly requestsHuman?: boolean;
  readonly hangsUp?: boolean;
}

export interface Scenario {
  readonly name: string;
  /** Persona notes; documentation, not behaviour. */
  readonly persona?: string;
  readonly outdoorTempF?: number;
  readonly turns: readonly ScenarioTurn[];
  readonly expect: {
    readonly outcome: CallOutcome | null;
    readonly hazard?: HazardCategory;
    /** Expected final value of each critical slot, as a display string. */
    readonly slots?: Partial<Record<SlotKey, string>>;
  };
}

export interface SimulationDeps {
  readonly geocoder: Geocoder;
  readonly windowPolicy: WindowPolicy;
  readonly serviceArea: GuardFn;
  /**
   * The extraction seam. Built per-scenario because the PR-suite fake is
   * scripted from that scenario's fills; the nightly arm ignores the argument
   * and hands back one `AnthropicExtractor`. Defaults to the scripted fake in
   * `evalDeps()`, so the standard PR run needs no wiring.
   */
  readonly makeExtractor: (scenario: Scenario) => SlotExtractor;
}

export interface SimulationResult {
  readonly scenario: string;
  readonly outcome: CallOutcome | null;
  readonly state: CallState;
  readonly contained: boolean;
  readonly hazard: HazardCategory | null;
  /** Turns the caller spent before the call resolved. */
  readonly turnsTaken: number;
  readonly corrections: number;
  readonly slots: Readonly<Partial<Record<SlotKey, string>>>;
  /** Slots the machine refused because a validator rejected them. */
  readonly rejections: readonly string[];
  /**
   * Every slot the agent read back to the caller, in order.
   *
   * Without this the harness can only check that the *final value* was right —
   * which a system that silently keeps a stale confirmation would also pass,
   * having never let the caller hear the correction.
   */
  readonly readBacks: readonly SlotKey[];
}

/** What a fill with no stated confidence scripts the fake to report. */
export const DEFAULT_CONFIDENCE = 0.95;

export async function simulate(
  scenario: Scenario,
  deps: SimulationDeps,
): Promise<SimulationResult> {
  const options = {
    guards: { ...BUILT_IN_GUARDS, address_in_service_area: deps.serviceArea },
  };

  const extractor = deps.makeExtractor(scenario);
  let ctx: MachineContext = initialContext();
  const rejections: string[] = [];
  const readBacks: SlotKey[] = [];
  /** Zero-based caller-utterance index, for the `ExtractionContext`. */
  let callerTurnIndex = 0;

  /** Every transition funnels through here so no read-back goes unrecorded. */
  const step = (event: MachineEvent) => {
    const result = transition(ctx, event, options);
    ctx = result.context;
    for (const effect of result.effects) {
      if (effect.type === "READ_BACK") readBacks.push(effect.key);
    }
    return result;
  };

  // Nothing happens until the caller has heard the greeting and the AI
  // disclosure, exactly as on a real call.
  let lastReadBack = pendingReadBack(step({ type: "AGENT_GREETED" }).effects);
  let hazard: HazardCategory | null = null;
  let turnsTaken = 0;

  for (const turn of scenario.turns) {
    if (terminal(ctx)) break;
    turnsTaken += 1;
    const extractionContext: ExtractionContext = {
      callId: scenario.name,
      turnIndex: callerTurnIndex++,
    };

    // The classifier runs on every caller utterance, in parallel with and
    // independent of anything the extractor believes.
    const detection = classify(turn.text, { outdoorTempF: scenario.outdoorTempF ?? null });
    if (detection) {
      hazard = detection.category;
      step({ type: "HAZARD_DETECTED", detection });
      step({ type: "HAZARD_GUIDANCE_DELIVERED" });
      break;
    }

    if (turn.hangsUp) {
      step({ type: "CALLER_HUNG_UP" });
      break;
    }
    if (turn.requestsHuman) {
      step({ type: "CALLER_REQUESTED_HUMAN" });
      break;
    }

    for (const fill of turn.fills ?? []) {
      const event = await extractAndBuild(
        extractor,
        fill.key,
        turn.text,
        extractionContext,
        deps,
      );
      const result = step(event);
      if (result.rejection) rejections.push(`${fill.key}: ${result.rejection}`);
      lastReadBack = pendingReadBack(result.effects) ?? lastReadBack;
      if (terminal(ctx)) break;
    }

    if (turn.confirms && lastReadBack && !terminal(ctx)) {
      lastReadBack = pendingReadBack(
        step({ type: "SLOT_CONFIRMED", key: lastReadBack }).effects,
      );
    }

    if (turn.confirmsAll) {
      // The agent reads the summary back; the caller says "yes, that's right".
      // Bounded by the slot count so a rejected confirmation cannot spin.
      for (let i = 0; i < CRITICAL_ASR_SLOTS.length + 2; i++) {
        if (!lastReadBack || terminal(ctx)) break;
        const result = step({ type: "SLOT_CONFIRMED", key: lastReadBack });
        if (result.rejection) {
          rejections.push(`${lastReadBack}: ${result.rejection}`);
          break;
        }
        lastReadBack = pendingReadBack(result.effects);
      }
    }
  }

  return {
    scenario: scenario.name,
    outcome: ctx.outcome,
    state: ctx.state,
    contained: isContained(ctx),
    hazard,
    turnsTaken,
    corrections: ctx.slots.correctionCount(),
    slots: display(ctx),
    rejections,
    readBacks,
  };
}

/**
 * The real path a caller's word takes: text → `SlotExtractor` → validators →
 * machine event. This is the seam `CallRuntime` performs at, exercised here
 * against a text-driven harness instead of a phone.
 *
 * An `unavailable` outcome is an outage, not a caller error (principle #3): one
 * bounded retry behind an implied filler, then it is a human's problem — a new
 * `AGENT_ERROR`, never a caller re-asked their name. This mirrors
 * `CallRuntime.extractAndApply` exactly; the two are the same policy on the two
 * sides of the port, and a change to one is a change to the contract both hold.
 */
async function extractAndBuild(
  extractor: SlotExtractor,
  key: SlotKey,
  text: string,
  ctx: ExtractionContext,
  deps: SimulationDeps,
): Promise<MachineEvent> {
  let outcome = await extractor.extract(key, text, ctx);
  if (outcome.kind === "unavailable") outcome = await extractor.extract(key, text, ctx);
  if (outcome.kind === "unavailable") return { type: "AGENT_ERROR", reason: outcome.reason };
  if (outcome.kind === "absent") return { type: "EXTRACTION_FAILED", key };
  return toEvent(key, outcome.raw, outcome.confidence, deps);
}

/**
 * Run one slot's raw extraction through the same validators production uses. A
 * validator that rejects the value produces an extraction failure rather than a
 * stored fact, which is what stops the machine from advancing.
 *
 * This is the same dispatch `packages/runtime/src/validate.ts` performs, kept
 * here rather than shared because this one also builds a `MachineEvent`, and the
 * two jobs pull apart the moment either changes. The validator *set* is the
 * contract; a new one is a compile error in both places.
 */
async function toEvent(
  key: SlotKey,
  raw: unknown,
  confidence: number,
  deps: SimulationDeps,
): Promise<MachineEvent> {
  switch (key) {
    case "callback_phone": {
      const v = validatePhone(String(raw));
      return v.value === null
        ? { type: "EXTRACTION_FAILED", key }
        : { type: "SLOT_FILLED", key, value: v.value, input: { confidence, validatorResult: v.result } };
    }
    case "service_address": {
      const v = await validateAddress(raw as never, deps.geocoder);
      return v.value === null
        ? { type: "EXTRACTION_FAILED", key }
        : { type: "SLOT_FILLED", key, value: v.value, input: { confidence, validatorResult: v.result } };
    }
    case "appointment_window": {
      const v = validateWindow(raw as never, deps.windowPolicy);
      return v.value === null
        ? { type: "EXTRACTION_FAILED", key }
        : { type: "SLOT_FILLED", key, value: v.value, input: { confidence, validatorResult: v.result } };
    }
    default:
      return {
        type: "SLOT_FILLED",
        key,
        value: raw,
        input: { confidence, validatorResult: VALID },
      };
  }
}

const terminal = (ctx: MachineContext): boolean =>
  ctx.state === "CLOSE" || ctx.state === "HANDOFF";

function pendingReadBack(effects: readonly Effect[]): SlotKey | null {
  const readBack = effects.find((e) => e.type === "READ_BACK");
  return readBack && readBack.type === "READ_BACK" ? readBack.key : null;
}

/** Slot values as the contractor would read them, for comparison in scoring. */
function display(ctx: MachineContext): Partial<Record<SlotKey, string>> {
  const out: Partial<Record<SlotKey, string>> = {};
  for (const key of ctx.slots.filled()) {
    const entry = ctx.slots.get(key)!;
    out[key] = stringify(key, entry.value);
  }
  return out;
}

function stringify(key: SlotKey, value: unknown): string {
  if (key === "service_address") return (value as { formatted: string }).formatted;
  if (key === "appointment_window") {
    const w = value as { startsAt: string; endsAt: string };
    return `${w.startsAt}/${w.endsAt}`;
  }
  return String(value);
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                     */
/* -------------------------------------------------------------------------- */

export interface Score {
  readonly scenarios: number;
  readonly containmentRate: number;
  /**
   * Fraction of expected critical slots that came out exactly right. Overall
   * word error rate is a vanity metric: getting `1247 Calle Ocho` right matters,
   * getting `um` right does not.
   */
  readonly criticalSlotAccuracy: number;
  readonly outcomeAccuracy: number;
  readonly failures: readonly string[];
}

export function score(
  runs: readonly { scenario: Scenario; result: SimulationResult }[],
): Score {
  const failures: string[] = [];
  let expectedSlots = 0;
  let correctSlots = 0;
  let correctOutcomes = 0;

  for (const { scenario, result } of runs) {
    if (result.outcome === scenario.expect.outcome) {
      correctOutcomes += 1;
    } else {
      failures.push(
        `${scenario.name}: expected ${scenario.expect.outcome}, got ${result.outcome}`,
      );
    }

    if (scenario.expect.hazard && result.hazard !== scenario.expect.hazard) {
      failures.push(
        `${scenario.name}: expected hazard ${scenario.expect.hazard}, got ${result.hazard}`,
      );
    }

    for (const [key, expected] of Object.entries(scenario.expect.slots ?? {})) {
      if (!CRITICAL_ASR_SLOTS.includes(key as SlotKey)) continue;
      expectedSlots += 1;
      if (result.slots[key as SlotKey] === expected) correctSlots += 1;
      else failures.push(`${scenario.name}: ${key} was "${result.slots[key as SlotKey]}"`);
    }
  }

  const contained = runs.filter((r) => r.result.contained).length;

  return {
    scenarios: runs.length,
    containmentRate: runs.length === 0 ? 0 : contained / runs.length,
    criticalSlotAccuracy: expectedSlots === 0 ? 1 : correctSlots / expectedSlots,
    outcomeAccuracy: runs.length === 0 ? 1 : correctOutcomes / runs.length,
    failures,
  };
}

export async function runAll(
  scenarios: readonly Scenario[],
  deps: SimulationDeps,
): Promise<{ runs: { scenario: Scenario; result: SimulationResult }[]; score: Score }> {
  const runs = [];
  for (const scenario of scenarios) {
    runs.push({ scenario, result: await simulate(scenario, deps) });
  }
  return { runs, score: score(runs) };
}
