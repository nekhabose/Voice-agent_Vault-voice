/**
 * Ports shared across packages. Kept here so nobody reaches into a sibling
 * package for a two-line interface, and so tests never depend on ambient
 * global state.
 */
import type {
  BookingOutcome,
  OutcomeClassification,
  PendingBookingPayload,
} from "./booking.js";
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
  /**
   * Now, as an ISO 8601 instant — and the field whose absence made
   * `appointment_window` **unfillable in principle**.
   *
   * A caller says "tomorrow afternoon". The slot wants two absolute timestamps.
   * Without a reference instant the model's only honest move is to decline, and
   * its only *useful* move is to invent a date — which is a truck at the wrong
   * house on the wrong day, and the exact failure principle #3 exists to prevent.
   * A live `llama-3.3-70b` chose honesty, emitted `{startsAt: null, endsAt: null}`,
   * and Groq rejected the generation outright. Nine Steps of green tests never
   * caught it, because the fake extractor was scripted with the answer.
   *
   * It belongs here rather than in the system prompt because it changes on every
   * turn, and one interpolated byte in the cached prefix multiplies extraction cost
   * roughly tenfold with no error. The extractors render it into `messages`.
   */
  readonly now: string;
  /**
   * The tenant's IANA zone. "Tomorrow afternoon" is a local idea, and a window
   * resolved in UTC for a shop in Miami is a window on the wrong afternoon.
   */
  readonly timeZone: string;
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
/* FAQ answers (plan, §6 call site #3)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Per-call facts the FAQ answerer may need and must never bake into a cached
 * prompt prefix — the same discipline as {@link ExtractionContext}, and separate
 * from it because the two call sites cache different prefixes and will drift.
 */
export interface FaqContext {
  readonly callId: string;
  /** Zero-based index of the caller utterance that asked the question. */
  readonly turnIndex: number;
}

export type FaqOutcome =
  /**
   * A committed answer covers the question. `answer` is the contractor's own
   * text, retrieved verbatim: the model selected it, and did not write it.
   */
  | { readonly kind: "answered"; readonly answer: string; readonly entryId: string }
  /**
   * Nothing the contractor has written answers this. Distinct from a failure —
   * we asked, and the honest answer is that we do not know. The caller is told
   * a person will call them back.
   */
  | { readonly kind: "unknown" }
  /**
   * We could not ask (model or retrieval outage). Distinct from `unknown`
   * exactly as `ExtractionOutcome.unavailable` is distinct from `absent`: the
   * caller hears the same fallback, but a dashboard that cannot tell "we have no
   * answer" from "we were down" cannot tell us to write more FAQ entries.
   */
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Call site #3, and the only model that speaks to the caller *about* the
 * business. It never blocks the audio path: `CallRuntime` speaks a filler
 * first, and whatever comes back is spoken after (plan, §6).
 */
export interface FaqAnswerer {
  answer(question: string, ctx: FaqContext): Promise<FaqOutcome>;
}

/* -------------------------------------------------------------------------- */
/* Correction triage (plan, §6 call site #5 — Step 6)                          */
/* -------------------------------------------------------------------------- */

/**
 * One booking's evidence, as the triage model sees it: what the agent captured,
 * and what the contractor's CRM said afterwards.
 *
 * Both halves are needed. A corrected address in isolation says nothing about
 * *why* it changed; `1247 Calle Ocho` → `1247 SW 8th St` is us getting it wrong,
 * and `1247 Calle Ocho` → `88 Alhambra Cir` is the customer moving the job.
 */
export interface TriageCase {
  readonly outcome: BookingOutcome;
  /** What the call actually captured and committed. */
  readonly booked: PendingBookingPayload;
}

export type TriageVerdict =
  | {
      readonly kind: "classified";
      readonly classification: OutcomeClassification;
      /** Why. Read by the human auditor, who has to be able to disagree cheaply. */
      readonly rationale: string;
    }
  /**
   * The model looked and could not tell. Left unclassified on purpose: an
   * unclassified correction counts as an `agent_error` in the published number
   * (`packages/telemetry`), so a shrug costs us rather than flatters us.
   */
  | { readonly kind: "declined"; readonly reason: string }
  /** Outage. Same rule: nothing is written, and the diff keeps counting against us. */
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * The nightly pass that asks whether an edit was *our* mistake (plan, Step 6.1).
 *
 * A model asked whether a contractor's edit was its own fault has an obvious
 * bias, and this port is arranged so that bias cannot reach the number quietly:
 * it may only *lower* the published rate, only with a written rationale, only on
 * a diff that is stored forever and can be recounted, and only while a weekly
 * human audit agrees with it (Step 6.3). It never writes to `correctedFields`.
 */
export interface CorrectionTriager {
  classify(triageCase: TriageCase): Promise<TriageVerdict>;
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

/* -------------------------------------------------------------------------- */
/* Recording (Step 8)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The thing that captures the caller's voice — and, far more importantly, the thing
 * that does not.
 *
 * **`CallRuntime` is the only caller of `begin()`, and the carrier must not be
 * configured to record on its own.** That is the boundary this port exists to draw. A
 * telephony vendor asked to `record=true` on answer starts the tape before anybody has
 * said anything, and no amount of correct logic on our side unmakes those seconds.
 * `packages/compliance` decides *whether*, `CallRuntime` decides *when*, and the
 * deployment's one job is to leave the carrier's own recording switch off
 * (`docs/COMPLIANCE.md`).
 *
 * Separate from {@link VoiceSession} on purpose, even though the same worker implements
 * both. `VoiceSession` is what we say to the caller; this is what we keep of what they
 * say to us, and the two are governed by different law. A `say()` that also started a
 * recording would be a compliance decision hidden inside an audio one.
 */
export interface Recorder {
  /**
   * Start capturing. Called at most once per call, and never before the consent regime
   * permits it — which, in every state whose law we cannot name, means never before the
   * caller has *heard* the AI disclosure.
   */
  begin(): Promise<void>;
  /** The call is over. Called only if `begin()` was. */
  stop(): Promise<void>;
}

/** A recording deleted, or one the vendor had already lost. Both mean: it is gone. */
export type RecordingDeletion = "deleted" | "already_absent";

/**
 * Where a recording actually lives, and what deletes it.
 *
 * The retention job nulls a column; this makes that column true. A `RetentionStore`
 * without a `RecordingArchive` behind it is a database that has forgotten about a
 * recording somebody else is still holding.
 */
export interface RecordingArchive {
  /** Throws if the vendor may still be holding the media. See `HttpRecordingArchive`. */
  delete(recordingUrl: string): Promise<RecordingDeletion>;
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
