import { describe, expect, it } from "vitest";
import { classify } from "./classifier.js";

/* -------------------------------------------------------------------------- */
/* Do not delete this file. Read this first.                                    */
/* -------------------------------------------------------------------------- */

/**
 * Ledgerline is an English-only product. The hazard lexicon is not.
 *
 * `SMELL_VERBS` carries `huele`/`huelo`/`oler`/`olor`. `GAS_NOUNS` carries
 * `propano`/`butano`. There are Spanish phrases for fire, smoke, flooding, and
 * arcing too. After the English-only pivot these look exactly like dead code from
 * an abandoned wedge, and the obvious cleanup is to delete them.
 *
 * They are not dead code.
 *
 * A Spanish-speaking homeowner can dial an English-only plumbing shop — plenty do —
 * and panic reverts people to their first language. Someone who has spoken English
 * for thirty years says "huele a gas" when the kitchen smells like gas.
 *
 * `plan.md` principle #4: recall is a hard constraint, precision is a cost we
 * measure. A false positive here costs one annoyed dispatcher. A false negative
 * costs a house. Keeping these phrases costs nothing at runtime — the classifier
 * is a phrase lookup, and the multi-group rules already match both word orders
 * without writing out the cross product.
 *
 * If you are here because this suite failed after you removed a phrase: that was
 * the point. Put it back, or make the deletion a conscious decision with a
 * rationale attached, the way `KNOWN_FALSE_POSITIVES` does.
 */
describe("spanish hazard phrases survive the english-only pivot", () => {
  const SPANISH_HAZARDS = [
    { text: "huele a gas en la cocina", expected: "GAS_LEAK" },
    { text: "hay una fuga de gas", expected: "GAS_LEAK" },
    { text: "huelo propano cerca del tanque", expected: "GAS_LEAK" },
    { text: "siento un olor a gas muy fuerte", expected: "GAS_LEAK" },
  ] as const;

  it.each(SPANISH_HAZARDS)("transfers on '$text'", ({ text, expected }) => {
    const detection = classify(text);
    expect(detection).not.toBeNull();
    expect(detection!.category).toBe(expected);
  });

  // The English equivalents must keep working too. A "fix" that swapped the
  // Spanish tokens in for the English ones would pass the block above.
  it.each([
    "it smells like gas in here",
    "I smell propane near the tank",
    "I think there's a gas leak in the kitchen",
  ])("still transfers on '%s'", (text) => {
    expect(classify(text)?.category).toBe("GAS_LEAK");
  });

  // A code-switched utterance is the realistic shape of this call, and it is the
  // one a monolingual lexicon misses: English frame, Spanish hazard noun.
  it("transfers on a code-switched utterance", () => {
    expect(classify("I think there's a fuga de gas")?.category).toBe("GAS_LEAK");
  });
});
