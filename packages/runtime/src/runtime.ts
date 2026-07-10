import type {
  BookingSink,
  CallTurn,
  Clock,
  Effect,
  ExtractionContext,
  HazardDetection,
  Locale,
  SlotExtractor,
  SlotKey,
  SlotValueMap,
  SpeechOutcome,
  UtteranceContext,
  Utterer,
  VoiceSession,
} from "@ledgerline/contracts";
import {
  initialContext,
  isContained,
  isTerminal,
  makeGuards,
  nextPrompt,
  transition,
  type GuardFn,
  type MachineContext,
  type MachineEvent,
  type MachineOptions,
} from "@ledgerline/conversation";
import { classify } from "@ledgerline/safety";
import type { Geocoder, WindowPolicy } from "@ledgerline/validators";
import { buildPendingBooking } from "./booking.js";
import { validateSlot } from "./validate.js";

/**
 * The one thing the audio worker cannot do: turn raw caller speech into
 * validated machine events, and machine effects into spoken sentences.
 *
 * `plan.md` §10.4 gives the worker an `Effect[]` to perform. This is the layer
 * that produces those effects and performs them against a `VoiceSession` — the
 * seam the Python LiveKit worker binds to. Everything consequential happens
 * here, in TypeScript, so it is testable without a phone:
 *
 * - **The machine decides; the audio layer is dumb** (principle #1). The runtime
 *   never plans a sequence. It performs the effects `transition()` returns, and
 *   arms the extractor for exactly the one slot the machine asked about.
 * - **The classifier runs on every ASR partial, before any model** (principle
 *   #4). `hearPartial` short-circuits the turn; a gas leak does not wait on the
 *   extractor, and the extractor is never even asked.
 * - **Nothing reaches the CRM from inside the call** (principle #3). A finished
 *   call posts a `PendingBooking` to the `BookingSink`; the durable workflow
 *   commits it afterwards.
 * - **Every turn is traced** (principle #5). Each spoken sentence and each heard
 *   utterance becomes a `CallTurn`, so `computeMetrics()` / `checkBudgets()` run
 *   over exactly what the caller experienced.
 */
export interface CallRuntimeDeps {
  readonly extractor: SlotExtractor;
  readonly utterer: Utterer;
  readonly voice: VoiceSession;
  readonly bookingSink: BookingSink;
  readonly geocoder: Geocoder;
  readonly windowPolicy: WindowPolicy;
  /** The tenant's service-area polygon, as a guard. */
  readonly serviceArea: GuardFn;
  readonly clock: Clock;
  readonly tenant: {
    readonly tenantId: string;
    /** As the caller expects to hear it, and as read back to them. */
    readonly businessName: string;
    /** IANA zone of the tenant. A window on the wrong day is a truck on the wrong day. */
    readonly timeZone: string;
  };
  /** Must be a UUID: it is the `callId` on every `CallTurn` and the booking. */
  readonly callId: string;
  /** Tenant job type resolved during TRIAGE, or null if unmapped. */
  readonly jobTypeId?: string | null;
  /** Rides the booking to the CRM. English-only product; defaults to `en`. */
  readonly locale?: Locale;
  readonly maxExtractionFailures?: number;
  /** Ambient fact the classifier uses for the freezing-weather rules. */
  readonly outdoorTempF?: number | null;
}

/** What the next completed caller turn is expected to answer. */
type Expecting =
  | { readonly kind: "extract"; readonly key: SlotKey }
  | { readonly kind: "confirm"; readonly key: SlotKey }
  | null;

export class CallRuntime {
  private ctx: MachineContext = initialContext();
  private readonly options: MachineOptions;
  private readonly traced: CallTurn[] = [];

  private expecting: Expecting = null;
  private done = false;
  private idx = 0;
  /** Zero-based index of the caller utterance, for `ExtractionContext`. */
  private callerTurnIndex = 0;

  constructor(private readonly deps: CallRuntimeDeps) {
    this.options = {
      guards: makeGuards(deps.serviceArea),
      ...(deps.maxExtractionFailures !== undefined
        ? { maxExtractionFailures: deps.maxExtractionFailures }
        : {}),
    };
  }

  /* ---- observation ---- */

  get context(): MachineContext {
    return this.ctx;
  }

  /** Every turn, agent and caller, in order — the input to `computeMetrics()`. */
  get callTurns(): readonly CallTurn[] {
    return this.traced;
  }

  get isOver(): boolean {
    return this.done;
  }

  get contained(): boolean {
    return isContained(this.ctx);
  }

  /* ---- driving the call ---- */

  /**
   * The first thing a call does. A call opens with **no event at all**, so the
   * runtime asks `nextPrompt` what to say — and is told to `GREET`, which is how
   * the AI disclosure reaches the caller before the `greeting_delivered` guard
   * will let the call move (plan, Step 3 surprise #2).
   */
  async start(): Promise<void> {
    await this.performEffects(nextPrompt(this.ctx));
  }

  /**
   * A partial ASR transcript. Runs only the classifier, in-process, before the
   * text reaches any model (principle #4). Returns the detection so the worker
   * can stop feeding audio; the escalation is already under way.
   */
  async hearPartial(text: string): Promise<HazardDetection | null> {
    if (this.done) return null;
    const detection = classify(text, { outdoorTempF: this.deps.outdoorTempF ?? null });
    if (!detection) return null;
    this.traceCaller(text);
    // The machine turns the deterministic detection into an ESCALATE effect; the
    // runtime never asks a model whether it was really an emergency. In a
    // non-interruptible (terminal) state the machine no-ops and the call stands.
    await this.drive({ type: "HAZARD_DETECTED", detection });
    return detection;
  }

  /**
   * A completed caller turn. Classified once more (a hazard stated only on the
   * final still transfers), then dispatched against whatever the last prompt
   * armed.
   */
  async hear(text: string): Promise<void> {
    if (this.done) return;
    this.traceCaller(text);
    this.callerTurnIndex += 1;

    const detection = classify(text, { outdoorTempF: this.deps.outdoorTempF ?? null });
    if (detection) {
      await this.drive({ type: "HAZARD_DETECTED", detection });
      return;
    }

    const expecting = this.expecting;
    if (expecting === null) return;

    if (expecting.kind === "extract") {
      await this.extractAndApply(expecting.key, text);
    } else {
      await this.confirmOrCorrect(expecting.key, text);
    }
  }

  /** The caller asked for a person. */
  async requestHuman(): Promise<void> {
    if (this.done) return;
    await this.drive({ type: "CALLER_REQUESTED_HUMAN" });
  }

  /** The line dropped. Terminal, and never reopened (plan, gotchas). */
  async callerHungUp(): Promise<void> {
    if (this.done) return;
    await this.drive({ type: "CALLER_HUNG_UP" });
    this.done = true;
    this.expecting = null;
  }

  /* ---- effect performance ---- */

  private async drive(event: MachineEvent): Promise<void> {
    const result = transition(this.ctx, event, this.options);
    this.ctx = result.context;
    await this.performEffects(result.effects);
  }

  private async performEffects(effects: readonly Effect[]): Promise<void> {
    for (const effect of effects) {
      if (this.done) break;
      await this.performOne(effect);
    }
  }

  private async performOne(effect: Effect): Promise<void> {
    switch (effect.type) {
      case "GREET":
        await this.speak(effect);
        // The disclosure has now been spoken; let the guard pass and advance.
        await this.drive({ type: "AGENT_GREETED" });
        return;

      case "ASK_FOR":
        await this.speak(effect);
        this.expecting = { kind: "extract", key: effect.key };
        return;

      case "READ_BACK":
        await this.speak(effect);
        this.expecting = { kind: "confirm", key: effect.key };
        return;

      case "ESCALATE": {
        await this.speak(effect);
        if (effect.hazard) {
          // Guidance has been read aloud, so the machine may leave EMERGENCY for
          // HANDOFF. Only after the caller has heard how to stay safe do we hand
          // them to a human (plan, §10.4). This emits no further effects.
          await this.drive({ type: "HAZARD_GUIDANCE_DELIVERED" });
        }
        await this.finishEscalation(effect);
        this.done = true;
        this.expecting = null;
        return;
      }

      case "CREATE_PENDING_BOOKING":
        await this.speak(effect);
        await this.deps.bookingSink.submit(
          buildPendingBooking(this.ctx, {
            callId: this.deps.callId,
            tenantId: this.deps.tenant.tenantId,
            jobTypeId: this.deps.jobTypeId ?? null,
            locale: this.deps.locale ?? "en",
          }),
        );
        this.done = true;
        this.expecting = null;
        return;
    }
  }

  private async finishEscalation(effect: Extract<Effect, { type: "ESCALATE" }>): Promise<void> {
    switch (effect.action) {
      case "WARM_TRANSFER":
      case "DIAL_911_GUIDANCE":
        await this.deps.voice.transfer(effect.reason);
        return;
      case "DECLINE":
        // Out of service area: no human needed, just a courteous close.
        await this.deps.voice.hangUp();
        return;
    }
  }

  /* ---- caller input ---- */

  private async extractAndApply(key: SlotKey, text: string): Promise<void> {
    let outcome = await this.deps.extractor.extract(key, text, this.extractionContext());

    // An outage is not a caller error (principle #3): one bounded retry behind a
    // filler, then it is a human's problem, not a caller asked their name again.
    if (outcome.kind === "unavailable") {
      outcome = await this.deps.extractor.extract(key, text, this.extractionContext());
    }
    if (outcome.kind === "unavailable") {
      await this.drive({ type: "AGENT_ERROR", reason: outcome.reason });
      return;
    }
    if (outcome.kind === "absent") {
      await this.drive({ type: "EXTRACTION_FAILED", key });
      return;
    }

    // `strict` guaranteed the shape; the validators guarantee the meaning. A ZIP
    // of `ABCDE` clears the tool schema and is rejected here, which is an
    // extraction failure, not a stored fact.
    const validation = await validateSlot(key, outcome.raw, this.deps);
    if (validation.value === null) {
      await this.drive({ type: "EXTRACTION_FAILED", key });
      return;
    }

    await this.drive({
      type: "SLOT_FILLED",
      key,
      value: validation.value,
      input: { confidence: outcome.confidence, validatorResult: validation.result },
    });
  }

  private async confirmOrCorrect(key: SlotKey, text: string): Promise<void> {
    if (isAffirmative(text)) {
      await this.drive({ type: "SLOT_CONFIRMED", key });
      return;
    }
    // A rejection. The caller usually restates the right value in the same breath
    // ("no, it's 1250"). Re-extract this one slot: a different value corrects it
    // (revoking the confirmation, so the machine reads the new value back), while
    // a bare "no" yields nothing and counts as an extraction failure — the
    // bounded path that escalates a caller stuck rejecting rather than looping.
    await this.extractAndApply(key, text);
  }

  /* ---- tracing ---- */

  private async speak(effect: Effect): Promise<SpeechOutcome> {
    const line = await this.deps.utterer.say(effect, this.utteranceContext(effect));
    const outcome = await this.deps.voice.say(line);
    this.traced.push({
      callId: this.deps.callId,
      idx: this.idx++,
      role: "agent",
      state: this.ctx.state,
      text: line,
      firstWordLatencyMs: outcome.firstWordLatencyMs,
      turnLatencyMs: outcome.turnLatencyMs,
      bargeIn: outcome.bargeIn,
      // Turn-take is "did the agent respond at all". Silence is the failure mode
      // the fastest model in Full-Duplex-Bench-v3 had, and it is not free speed.
      turnTakeOk: outcome.spoke,
      createdAt: this.deps.clock.now().toISOString(),
    });
    return outcome;
  }

  private traceCaller(text: string): void {
    this.traced.push({
      callId: this.deps.callId,
      idx: this.idx++,
      role: "caller",
      state: this.ctx.state,
      text,
      firstWordLatencyMs: null,
      turnLatencyMs: null,
      bargeIn: false,
      turnTakeOk: true,
      createdAt: this.deps.clock.now().toISOString(),
    });
  }

  /* ---- context builders ---- */

  private extractionContext(): ExtractionContext {
    return { callId: this.deps.callId, turnIndex: this.callerTurnIndex };
  }

  private utteranceContext(effect: Effect): UtteranceContext {
    const attempt =
      effect.type === "ASK_FOR" ? this.ctx.extractionFailures[effect.key] ?? 0 : 0;
    return {
      businessName: this.deps.tenant.businessName,
      timeZone: this.deps.tenant.timeZone,
      values: this.slotValues(),
      attempt,
    };
  }

  private slotValues(): Readonly<Partial<SlotValueMap>> {
    const values: Partial<SlotValueMap> = {};
    for (const key of this.ctx.slots.filled()) {
      // The map is keyed so each value is its slot's own type; the cast is the
      // one place that per-key correspondence is asserted rather than inferred.
      (values as Record<SlotKey, unknown>)[key] = this.ctx.slots.get(key)!.value;
    }
    return values;
  }
}

/**
 * A clear yes, and nothing that reads as "no". Deliberately conservative: a
 * read-back is the verification step, and confirming on an ambiguous answer is
 * exactly the failure principle #3 exists to prevent. Anything that is not an
 * unambiguous yes routes back through extraction as a possible correction.
 */
const AFFIRMATIVES = [
  "yes",
  "yeah",
  "yep",
  "yup",
  "correct",
  "right",
  "that's right",
  "thats right",
  "sounds good",
  "perfect",
  "exactly",
  "uh huh",
  "mm hmm",
  "confirm",
  "go ahead",
];

const NEGATIONS = ["no", "nope", "nah", "wrong", "incorrect", "not right", "isn't", "isnt"];

export function isAffirmative(text: string): boolean {
  const normalized = ` ${text.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim()} `;
  if (NEGATIONS.some((n) => normalized.includes(` ${n} `))) return false;
  return AFFIRMATIVES.some((a) => normalized.includes(` ${a} `) || normalized.includes(a));
}

export { isTerminal };
