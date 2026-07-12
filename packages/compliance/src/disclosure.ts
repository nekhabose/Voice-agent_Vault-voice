import type { CallTurn } from "@ledgerline/contracts";

/**
 * The AI disclosure, and the evidence that a caller actually heard it.
 *
 * ## Why the string lives here and not in the catalog
 *
 * It was in `packages/utterance/src/catalog.ts` from Step 3, and `catalog.ts` still
 * re-exports it, exactly as `machine.ts` re-exports `Effect`. But two packages ask
 * about it now — `utterance` speaks it, and this one *checks that it was spoken* —
 * and by the rule that settled `isCorrected` (Step 6) and the store ports (Step 7),
 * a thing two packages must agree on belongs upstream of both.
 *
 * The better reason is that it is not really an utterance. It is legal text that
 * happens to be spoken, and its natural neighbours are {@link DPA_VERSION} and the
 * consent regime — the things one person reviews in one sitting — rather than the
 * phrasing of "what's the best number to reach you on?".
 */

/**
 * Spoken verbatim at the top of every call, before the conversation begins.
 *
 * California's AB 3030 lineage and the general FTC posture both want *clear*
 * disclosure that the caller is not talking to a person. The `greeting_delivered`
 * guard makes it a precondition of leaving GREETING rather than a courtesy at the
 * top of it, and `LlmUtterer` refuses to paraphrase it.
 *
 * The sentence also carries the recording notice, and that is deliberate rather than
 * economical: in an all-party-consent state, notice plus continued participation is
 * the consent, so **this string is the mechanism by which we are allowed to record at
 * all** (`recordingDecision`). Split the two sentences and one of them will one day be
 * cut in a tone pass, and the cut will be the one that mattered.
 *
 * **Do not reword this in a "tone" pass.** If it must change, it changes here, with
 * {@link DISCLOSURE_VERSION}, in a commit a lawyer can read.
 */
export const AI_DISCLOSURE =
  "Just so you know, you're speaking with an automated assistant, not a person, and this call may be recorded. You can ask for a human at any time.";

/**
 * Bumped whenever {@link AI_DISCLOSURE} changes.
 *
 * The version is what a regulator asks for: *what exactly were callers told, on the
 * day of the call?* A pinned string with no version answers that only for today.
 */
export const DISCLOSURE_VERSION = "2026-07-11";

/**
 * Did this call's caller actually hear the disclosure?
 *
 * Two conditions, and the second is the one nobody expects:
 *
 * 1. An agent turn whose text contains {@link AI_DISCLOSURE} **verbatim**. A
 *    paraphrase is a disclosure nobody reviewed, so it does not count — which makes
 *    this the runtime check behind Step 3's "no model rewords the greeting", scored
 *    against what was really said rather than what the catalog says.
 * 2. `turnTakeOk` — the agent *produced audio*. The failure mode Full-Duplex-Bench-v3
 *    found in the fastest model in its field is silence, and a disclosure the TTS
 *    never spoke is not a disclosure. This is the same `SpeechOutcome.spoke` that
 *    `checkBudgets()` scores, read for a different purpose: a silent greeting is a
 *    turn-take miss to `telemetry` and an unrecordable call to us.
 */
export function wasDisclosed(turns: readonly CallTurn[]): boolean {
  return turns.some(
    (turn) =>
      turn.role === "agent" && turn.turnTakeOk && turn.text.includes(AI_DISCLOSURE),
  );
}

export interface DisclosureAudit {
  readonly calls: number;
  readonly disclosed: number;
  /** Must be `1`. There is no acceptable number of calls that did not hear it. */
  readonly rate: number;
  /** The calls that did not. Named, because "99.4%" is not something you can fix. */
  readonly undisclosed: readonly string[];
}

/**
 * The compliance equivalent of `checkBudgets()`, and it has no budget.
 *
 * `telemetry`'s targets are engineering trade-offs — 96% turn-take is a number we
 * argue about. This one is not a trade-off: a call that was answered and never told
 * the caller they were talking to a machine is a violation, and one is too many. So
 * the only passing value is `1`, and {@link DisclosureAudit.undisclosed} names the
 * calls rather than reporting a percentage, because a percentage is not something
 * anybody can go and fix.
 *
 * `callIds` is passed separately from `turns` on purpose: a call that was answered
 * and produced **no turns at all** — the agent never spoke — is exactly the failure
 * this audit exists to catch, and it is invisible in a list of turns.
 */
export function auditDisclosure(
  callIds: readonly string[],
  turns: readonly CallTurn[],
): DisclosureAudit {
  const byCall = new Map<string, CallTurn[]>();
  for (const turn of turns) {
    const existing = byCall.get(turn.callId);
    if (existing) existing.push(turn);
    else byCall.set(turn.callId, [turn]);
  }

  const undisclosed = callIds.filter((id) => !wasDisclosed(byCall.get(id) ?? []));

  return {
    calls: callIds.length,
    disclosed: callIds.length - undisclosed.length,
    rate: callIds.length === 0 ? 1 : (callIds.length - undisclosed.length) / callIds.length,
    undisclosed,
  };
}
