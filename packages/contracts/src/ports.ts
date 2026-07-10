/**
 * Ports shared across packages. Kept here so nobody reaches into a sibling
 * package for a two-line interface, and so tests never depend on ambient
 * global state.
 */
import type { PendingBookingPayload } from "./booking.js";
import type { Effect } from "./effects.js";
import type { SlotKey, SlotValueMap } from "./slots.js";
import type { EscalationReason } from "./states.js";

/** Injected so nothing in the system reads the wall clock directly. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso) });

/* -------------------------------------------------------------------------- */
/* Slot extraction                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Per-call facts an extractor may need but must never bake into a cached
 * prompt prefix.
 *
 * A `Date.now()` or a call id inside the system prompt invalidates the prompt
 * cache on every turn of every call, multiplies extraction cost roughly
 * tenfold, and the only symptom is a latency graph nobody can explain (plan,
 * §10.1). These fields exist so that information has somewhere honest to go.
 */
export interface ExtractionContext {
  readonly callId: string;
  /** Zero-based index of the caller utterance being extracted from. */
  readonly turnIndex: number;
}

export type ExtractionOutcome =
  /**
   * The model produced a value that satisfies `SLOT_SPECS[key].extraction`.
   * `raw` is pre-validation: `packages/validators` still has to accept it.
   */
  | { readonly kind: "filled"; readonly raw: unknown; readonly confidence: number }
  /**
   * This utterance carries no usable value for this slot — the caller did not
   * say it, said something ambiguous, or said something the contract rejects.
   * The machine re-asks.
   */
  | { readonly kind: "absent" }
  /**
   * We could not ask. Distinct from `absent`, exactly as a geocoder outage
   * yields `unavailable` rather than `invalid` (principle #3): an Anthropic
   * outage must not make the machine believe a perfectly clear caller said
   * nothing. Route to a filler and one bounded retry, then `ESCALATE`.
   */
  | { readonly kind: "unavailable"; readonly reason: string };

/** One field, one turn. Never a plan, never a sequence (principle #1). */
export interface SlotExtractor {
  extract(
    key: SlotKey,
    utterance: string,
    ctx: ExtractionContext,
  ): Promise<ExtractionOutcome>;
}

/* -------------------------------------------------------------------------- */
/* Utterances                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Everything an {@link Utterer} needs to turn an {@link Effect} into a sentence,
 * and nothing more.
 *
 * `values` is what the caller has already established. A `READ_BACK` for a slot
 * absent from it is a machine bug, not a phrasing problem, and `CachedUtterer`
 * throws rather than improvising.
 */
export interface UtteranceContext {
  /** The contractor's trading name, as the caller expects to hear it. */
  readonly businessName: string;
  /** IANA zone of the *tenant*, not the server. A window on the wrong day is a truck on the wrong day. */
  readonly timeZone: string;
  readonly values: Readonly<Partial<SlotValueMap>>;
  /** Times we have already asked for this slot. Non-zero selects the reprompt form. */
  readonly attempt: number;
}

/**
 * Turns an Effect into words. Backed by a build-time catalog (plan, §10.2):
 * a few hundred strings, reviewed by a human and committed, rather than a model
 * call inside the audio path.
 */
export interface Utterer {
  say(effect: Effect, ctx: UtteranceContext): Promise<string>;
}

/* -------------------------------------------------------------------------- */
/* The voice runtime                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What came of speaking one sentence to the caller.
 *
 * Returned rather than discarded because principle #5's budgets are computed
 * from exactly these three numbers, and only the layer that actually spoke can
 * know them. `plan.md` §10.3 sketched `perform(effects): Promise<void>`; a
 * `void` return leaves `CallTurn.turnTakeOk` with nowhere to come from, and
 * `turnTakeOk` is the metric that catches the failure mode Full-Duplex-Bench-v3
 * found in the *fastest* model in its field — silence.
 */
export interface SpeechOutcome {
  /**
   * The agent produced audio at all. Gemini Live said nothing in 22 of 100
   * scenarios; `checkBudgets()` blocks a merge below 96% here.
   */
  readonly spoke: boolean;
  /** The agent talked over the caller. */
  readonly bargeIn: boolean;
  /** End-of-caller-speech to agent's first word. Null when nothing was spoken. */
  readonly firstWordLatencyMs: number | null;
  /** End-of-caller-speech to end-of-agent-turn. Null when nothing was spoken. */
  readonly turnLatencyMs: number | null;
}

/**
 * The audio layer, reduced to the three things it can do that our own code
 * cannot: make noise, hand the call to a human, and end it.
 *
 * `plan.md` §10.3 had this port emit `MachineEvent`. It cannot. A `SLOT_FILLED`
 * event carries a value that has already been through `packages/validators` —
 * the geocoder, the E.164 parse, the business-hours check. An audio layer that
 * could construct one would have to own the geocoder, and principle #3 is that
 * the geocoder decides what an address is, not the thing listening to the
 * caller. So effects go down and *raw* speech comes back up; `CallRuntime` is
 * the only thing that turns the second into the first.
 */
export interface VoiceSession {
  /** Speak one sentence. Resolves when the agent's turn is over. */
  say(text: string): Promise<SpeechOutcome>;
  /** SIP REFER to a human. Only ever reached from an `ESCALATE` effect. */
  transfer(reason: EscalationReason): Promise<void>;
  hangUp(): Promise<void>;
}

/**
 * Where a finished call posts its `PendingBooking`.
 *
 * Nothing is written to the contractor's CRM from inside the call (principle
 * #3). This port reaches the control plane, which starts the durable workflow;
 * it does not reach Housecall Pro, and it must never wait on one.
 */
export interface BookingSink {
  submit(payload: PendingBookingPayload): Promise<void>;
}

/** Injected so retry backoff does not make the test suite slow. */
export type Sleep = (milliseconds: number) => Promise<void>;

export const realSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Records the delays it was asked for, then returns instantly. */
export function recordingSleep(): Sleep & { delays: number[] } {
  const delays: number[] = [];
  const sleep = (async (ms: number) => {
    delays.push(ms);
  }) as Sleep & { delays: number[] };
  sleep.delays = delays;
  return sleep;
}
