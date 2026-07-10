/**
 * Ports shared across packages. Kept here so nobody reaches into a sibling
 * package for a two-line interface, and so tests never depend on ambient
 * global state.
 */
import type { SlotKey } from "./slots.js";

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
