import { describe, expect, it } from "vitest";
import { PAN_PLACEHOLDER, containsPan, passesLuhn, redactPan } from "./pci.js";

/**
 * A labeled corpus, both directions, in the shape `packages/safety` uses for hazards —
 * and for the same reason: a redactor is a classifier, and a classifier with no measured
 * precision is a classifier somebody will "improve" into uselessness.
 *
 * The two directions cost different things, and neither is free:
 *
 * - **A miss** puts a card number in `call_turns.text`, in a `tool_use` block on its way
 *   to Anthropic, and in the `description` field of a job in the contractor's CRM. It
 *   puts all three of those systems in PCI scope, which is the thing "we never take
 *   payment on the call" was supposed to avoid.
 * - **A false positive** shreds a number a plumber needed. An over-eager redactor that
 *   eats the caller's own callback number produces a booking nobody can act on, which is
 *   a real failure with a real truck attached to it.
 *
 * The card numbers below are the industry's published test values. They are Luhn-valid
 * by construction and belong to nobody.
 */
const CARDS: readonly (readonly [string, string])[] = [
  ["Visa", "4111111111111111"],
  ["Visa, the other one", "4012888888881881"],
  ["Mastercard", "5555555555554444"],
  ["Mastercard, 51xx", "5105105105105100"],
  ["Amex — 15 digits, and the reason the floor is 13", "378282246310005"],
  ["Amex, the other one", "371449635398431"],
  ["Discover", "6011111111111117"],
  ["Diners — 14 digits", "30569309025904"],
  ["JCB", "3530111333300000"],
];

/**
 * Things a caller actually says to a plumber. Every one of these must survive intact:
 * four of them are slot values the booking cannot be made without.
 */
const NOT_CARDS: readonly (readonly [string, string])[] = [
  ["a callback number", "my number is 305 555 1234"],
  ["a callback number, run together", "3055551234"],
  ["a callback number in E.164", "call me on +13055551234"],
  ["a ZIP+4", "the zip is 33135-2841"],
  ["a street number", "it's 1247 Calle Ocho"],
  ["a time", "Thursday between 2 and 6"],
  ["a price the contractor quoted", "you quoted me 450 dollars last time"],
  ["a model number", "the unit is a Rheem XG50T06EC38U1"],
  ["a year and a street", "built in 1998, at 4120 Ponce de Leon"],
];

/**
 * Deliberate false positives, held separately — `packages/safety`'s `KNOWN_FALSE_POSITIVES`
 * move, and for the same reason.
 *
 * A **contiguous** run of 13–19 digits is redacted whether or not it passes Luhn, so a
 * plumbing customer who reads out a thirteen-digit account number loses it. That is a
 * cost, and it is a cost we are choosing: the alternative is requiring Luhn on contiguous
 * runs, and Luhn is exactly what a real card fails when the ASR mishears one digit of it.
 * Fifteen correct digits of somebody's Visa is not a thing we may keep because a checksum
 * came out wrong.
 *
 * Pinned here rather than fixed, so that a future "improvement" that adds the Luhn check
 * is a conscious decision with a failing test attached to it — and so nobody reads the
 * precision corpus above and concludes this case was overlooked.
 */
const KNOWN_FALSE_POSITIVES: readonly (readonly [string, string])[] = [
  ["a 13-digit account number, said as one blob", "my account is 1234567890123"],
];

describe("passesLuhn", () => {
  it.each(CARDS)("%s", (_label, pan) => {
    expect(passesLuhn(pan)).toBe(true);
  });

  it("rejects a sequential digit string", () => {
    expect(passesLuhn("1234567890123")).toBe(false);
    expect(passesLuhn("1234567890123456")).toBe(false);
  });

  it("rejects an empty string rather than calling it a valid checksum of nothing", () => {
    expect(passesLuhn("")).toBe(false);
  });
});

describe("redactPan — recall", () => {
  it.each(CARDS)("removes a %s the caller read out", (_label, pan) => {
    const said = `I'll just pay now, the card is ${pan}`;
    const redacted = redactPan(said);

    expect(redacted).not.toContain(pan);
    expect(redacted).toContain(PAN_PLACEHOLDER);
    // The rest of the sentence survives. A redactor that eats the turn is a redactor
    // that costs us the reason the caller phoned.
    expect(redacted).toContain("I'll just pay now");
  });

  it.each([
    ["spaces, the way a card is printed", "4111 1111 1111 1111"],
    ["hyphens", "4111-1111-1111-1111"],
    ["Amex's 4-6-5 grouping", "3782 822463 10005"],
  ])("removes one grouped with %s", (_label, pan) => {
    expect(redactPan(`it's ${pan}`)).toBe(`it's ${PAN_PLACEHOLDER}`);
  });

  /**
   * The reason a contiguous run is redacted **without** a Luhn check.
   *
   * ASR mishears digits. A card whose final digit came through wrong fails Luhn — and
   * is still fifteen of the sixteen digits of somebody's real card, which is not a thing
   * we may keep. There is no legitimate 16-digit blob in a call about a water heater, so
   * a contiguous run does not get to argue its way past this.
   */
  it("removes a contiguous run the ASR misheard, even though it fails Luhn", () => {
    const misheard = "4111111111111112";
    expect(passesLuhn(misheard)).toBe(false);
    expect(redactPan(`card is ${misheard}`)).toContain(PAN_PLACEHOLDER);
  });

  it("removes more than one from a single turn", () => {
    const said = `try 4111111111111111 or 5555555555554444`;
    expect(redactPan(said)).toBe(`try ${PAN_PLACEHOLDER} or ${PAN_PLACEHOLDER}`);
  });
});

describe("redactPan — precision", () => {
  it.each(NOT_CARDS)("leaves %s alone", (_label, said) => {
    expect(redactPan(said)).toBe(said);
    expect(containsPan(said)).toBe(false);
  });

  /**
   * The false positive that would actually happen, and the one Luhn is here to prevent.
   *
   * "3055551234 33135" is a phone number and a ZIP said in one breath: fifteen digits
   * separated by a single space, which is exactly the shape of a grouped card. Redact it
   * and the caller has given us their callback number and we have thrown it away.
   *
   * Two independent tests stop it — the ten-digit group is not card-shaped, and the run
   * fails Luhn — and this asserts the outcome rather than either mechanism.
   */
  it("does not glue a phone number and a ZIP into a card", () => {
    const said = "3055551234 33135";
    expect(redactPan(said)).toBe(said);
  });

  /** Longer than any PAN. Redacting a *prefix* of it would be both wrong and unreadable. */
  it("leaves a twenty-digit number entirely alone rather than eating a slice of it", () => {
    const said = "reference 12345678901234567890";
    expect(redactPan(said)).toBe(said);
  });

  it("returns the identical string when there is nothing to do", () => {
    const said = "my water heater is leaking all over the garage";
    expect(redactPan(said)).toBe(said);
  });
});

describe("known false positives — chosen, not overlooked", () => {
  it.each(KNOWN_FALSE_POSITIVES)("redacts %s, and we accept that", (_label, said) => {
    expect(containsPan(said)).toBe(true);
  });
});

describe("containsPan", () => {
  it("says whether a call reached us with a card in it", () => {
    expect(containsPan("the card is 4111111111111111")).toBe(true);
    expect(containsPan("my number is 305 555 1234")).toBe(false);
  });
});
