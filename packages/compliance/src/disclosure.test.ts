import type { CallTurn } from "@ledgerline/contracts";
import { describe, expect, it } from "vitest";
import {
  AI_DISCLOSURE,
  DISCLOSURE_VERSION,
  auditDisclosure,
  wasDisclosed,
} from "./disclosure.js";

const CALL_A = "11111111-1111-4111-8111-111111111111";
const CALL_B = "22222222-2222-4222-8222-222222222222";

function turn(overrides: Partial<CallTurn> & { callId: string }): CallTurn {
  return {
    idx: 0,
    role: "agent",
    state: "GREETING",
    text: `Thanks for calling Ace Plumbing. ${AI_DISCLOSURE} What can I help you with today?`,
    firstWordLatencyMs: 300,
    turnLatencyMs: 900,
    bargeIn: false,
    turnTakeOk: true,
    createdAt: "2026-07-11T12:00:00.000Z",
    ...overrides,
  };
}

/**
 * The exact-equality pin, moved with the string.
 *
 * `packages/utterance` has had this test since Step 3, and it stays there too — the
 * catalog re-exports the constant, so a reader of `catalog.ts` still sees what a caller
 * hears. This copy exists because the string's *governance* is here now: it is versioned,
 * it carries the recording notice that `recordingDecision` treats as the consent, and a
 * silent edit to it is a silent edit to the legal basis on which we hold somebody's voice.
 */
describe("AI_DISCLOSURE", () => {
  it("is the string a lawyer will be shown, byte for byte", () => {
    expect(AI_DISCLOSURE).toBe(
      "Just so you know, you're speaking with an automated assistant, not a person, and this call may be recorded. You can ask for a human at any time.",
    );
  });

  /** Three claims, and the middle one is what lets us record at all. */
  it("says it is not a person, that the call may be recorded, and that a human is available", () => {
    expect(AI_DISCLOSURE).toContain("not a person");
    expect(AI_DISCLOSURE).toContain("may be recorded");
    expect(AI_DISCLOSURE).toContain("ask for a human");
  });

  it("carries a version, because 'what were callers told, on the day of the call' is a question", () => {
    expect(DISCLOSURE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("wasDisclosed", () => {
  it("is true when an agent turn carried the disclosure and the agent actually spoke", () => {
    expect(wasDisclosed([turn({ callId: CALL_A })])).toBe(true);
  });

  /**
   * The one nobody expects, and it is the same field `checkBudgets()` scores.
   *
   * `turnTakeOk: false` is `SpeechOutcome.spoke === false` — the TTS produced no audio.
   * The sentence was rendered, logged, and never heard, and a disclosure nobody heard is
   * not a disclosure. To `telemetry` this is a turn-take miss; to us it is a call that
   * must not be recorded, and both readings come from the same boolean.
   */
  it("is false when the greeting was rendered but never spoken", () => {
    expect(wasDisclosed([turn({ callId: CALL_A, turnTakeOk: false })])).toBe(false);
  });

  /**
   * The runtime check behind Step 3's "no model rewords the greeting", scored against
   * what was *actually said* rather than against what the catalog says. A paraphrase is a
   * disclosure nobody reviewed, so it does not count — and if one ever ships, this is the
   * number that goes wrong rather than a test somebody deleted.
   */
  it("is false when a model helpfully paraphrased it", () => {
    const paraphrased = turn({
      callId: CALL_A,
      text: "Hi there! Quick heads up, I'm an AI assistant. How can I help?",
    });
    expect(wasDisclosed([paraphrased])).toBe(false);
  });

  it("is false when the caller said it back to us", () => {
    // Absurd, and exactly the sort of thing a naive `text.includes` over all turns does.
    const echoed = turn({ callId: CALL_A, role: "caller" });
    expect(wasDisclosed([echoed])).toBe(false);
  });

  it("is false for a call with no turns at all", () => {
    expect(wasDisclosed([])).toBe(false);
  });
});

/**
 * `checkBudgets()` has targets we argue about — 96% turn-take is an engineering
 * trade-off. This has no target. A call that was answered and never told the caller they
 * were talking to a machine is a violation, and one is too many.
 */
describe("auditDisclosure — the budget with no budget", () => {
  it("scores every call and names the ones that failed", () => {
    const audit = auditDisclosure(
      [CALL_A, CALL_B],
      [turn({ callId: CALL_A }), turn({ callId: CALL_B, turnTakeOk: false })],
    );

    expect(audit.calls).toBe(2);
    expect(audit.disclosed).toBe(1);
    expect(audit.rate).toBe(0.5);
    expect(audit.undisclosed).toEqual([CALL_B]);
  });

  /**
   * A call that was answered and produced no turns — the agent said nothing at all — is
   * exactly the failure this exists to catch, and it is *invisible* in a list of turns.
   * That is why `callIds` is a separate argument, and this is the test that makes the
   * separate argument earn its place.
   */
  it("catches a call that was answered and never spoke", () => {
    const audit = auditDisclosure([CALL_A], []);
    expect(audit.rate).toBe(0);
    expect(audit.undisclosed).toEqual([CALL_A]);
  });

  it("names the calls rather than reporting a percentage nobody can fix", () => {
    const audit = auditDisclosure([CALL_A, CALL_B], [turn({ callId: CALL_A })]);
    expect(audit.undisclosed).toEqual([CALL_B]);
  });

  it("is 1.0 on a clean run", () => {
    const audit = auditDisclosure(
      [CALL_A, CALL_B],
      [turn({ callId: CALL_A }), turn({ callId: CALL_B })],
    );
    expect(audit.rate).toBe(1);
    expect(audit.undisclosed).toEqual([]);
  });

  it("is 1.0, not 0/0, on no calls at all", () => {
    expect(auditDisclosure([], []).rate).toBe(1);
  });
});
