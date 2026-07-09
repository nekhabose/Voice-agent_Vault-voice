import { describe, expect, it } from "vitest";
import { HAZARD_ACTIONS, HAZARD_CATEGORIES } from "@ledgerline/contracts";
import { classify, detectAll } from "./classifier.js";
import {
  HAZARD_SAMPLES,
  KNOWN_FALSE_POSITIVES,
  SAFE_SAMPLES,
} from "./corpus.js";
import { HAZARD_RULES, HAZARD_SEVERITY } from "./lexicon.js";
import { findPhrase, tokenize, withinEditDistance } from "./text.js";

/* -------------------------------------------------------------------------- */
/* The numbers that matter                                                     */
/* -------------------------------------------------------------------------- */

describe("recall — false negatives are catastrophic", () => {
  it("detects a hazard in every hazard sample (recall = 1.0)", () => {
    const missed = HAZARD_SAMPLES.filter(
      (s) => classify(s.text, s.context) === null,
    );
    expect(missed.map((s) => s.text)).toEqual([]);
  });

  it.each(HAZARD_SAMPLES)("classifies $text as $expected", (sample) => {
    const detection = classify(sample.text, sample.context);
    expect(detection).not.toBeNull();
    expect(detection!.category).toBe(sample.expected);
  });

  it("pairs every detection with the correct escalation action", () => {
    for (const sample of HAZARD_SAMPLES) {
      const d = classify(sample.text, sample.context)!;
      expect(d.action).toBe(HAZARD_ACTIONS[d.category]);
    }
  });

  it("quotes the text that actually fired, for the audit trail", () => {
    const d = classify("I think there's a gas leak in the kitchen")!;
    expect(d.matchedText.toLowerCase()).toBe("gas leak");
    expect(d.ruleId).toBe("gas.leak.phrase");
  });
});

describe("precision — false positives cost one annoyed dispatcher", () => {
  it("stays silent on every routine home-services call", () => {
    const fired = SAFE_SAMPLES.filter((s) => classify(s.text, s.context) !== null).map(
      (s) => ({ text: s.text, fired: classify(s.text, s.context) }),
    );
    expect(fired).toEqual([]);
  });

  it("reports precision and recall over the labeled corpus", () => {
    const truePositives = HAZARD_SAMPLES.filter(
      (s) => classify(s.text, s.context) !== null,
    ).length;
    const falseNegatives = HAZARD_SAMPLES.length - truePositives;
    const falsePositives = SAFE_SAMPLES.filter(
      (s) => classify(s.text, s.context) !== null,
    ).length;

    const precision = truePositives / (truePositives + falsePositives);
    const recall = truePositives / (truePositives + falseNegatives);

    // Recall is the hard constraint. Precision is a cost we accept and measure.
    expect(recall).toBe(1);
    expect(precision).toBe(1);
    expect(HAZARD_SAMPLES.length + SAFE_SAMPLES.length).toBeGreaterThan(60);
  });
});

describe("deliberate false positives", () => {
  it.each(KNOWN_FALSE_POSITIVES)(
    "fires on $text because we do not suppress negation",
    (sample) => {
      // If this ever stops firing, someone added negation handling. That may be
      // right — but it must be a decision, not a silent regression.
      expect(classify(sample.text, sample.context)).not.toBeNull();
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Behaviour                                                                   */
/* -------------------------------------------------------------------------- */

describe("severity ordering", () => {
  it("acts on the most dangerous hazard when several fire at once", () => {
    const text = "There's a gas leak and my baby is upstairs and the basement is flooding";
    const all = detectAll(text);
    const categories = all.map((d) => d.category);

    expect(categories).toContain("GAS_LEAK");
    expect(categories).toContain("FLOODING");
    expect(categories).toContain("VULNERABLE_PERSON_AT_RISK");
    // The head of the list is what `classify` acts on.
    expect(all[0]!.category).toBe("GAS_LEAK");
    expect(classify(text)!.action).toBe("DIAL_911_GUIDANCE");
  });

  it("ranks a vulnerable person above the routine hazard they are exposed to", () => {
    expect(HAZARD_SEVERITY.VULNERABLE_PERSON_AT_RISK).toBeGreaterThan(
      HAZARD_SEVERITY.FLOODING,
    );
    expect(HAZARD_SEVERITY.GAS_LEAK).toBeGreaterThan(
      HAZARD_SEVERITY.VULNERABLE_PERSON_AT_RISK,
    );
  });

  it("is deterministic — the same utterance always yields the same order", () => {
    const text = "smoke is coming and there is a gas leak";
    const first = detectAll(text).map((d) => d.ruleId);
    for (let i = 0; i < 5; i++) {
      expect(detectAll(text).map((d) => d.ruleId)).toEqual(first);
    }
  });
});

describe("ambient temperature", () => {
  const NO_HEAT = "The furnace is out";

  it("is a routine job in July", () => {
    expect(classify(NO_HEAT)).toBeNull();
    expect(classify(NO_HEAT, { outdoorTempF: 78 })).toBeNull();
  });

  it("is a life-safety call in a hard freeze", () => {
    expect(classify(NO_HEAT, { outdoorTempF: 18 })?.category).toBe("NO_HEAT_FREEZING");
  });

  it("arms exactly at freezing, not a degree below", () => {
    expect(classify(NO_HEAT, { outdoorTempF: 32 })?.category).toBe("NO_HEAT_FREEZING");
    expect(classify(NO_HEAT, { outdoorTempF: 33 })).toBeNull();
  });

  it("ignores a null temperature rather than treating it as zero", () => {
    expect(classify(NO_HEAT, { outdoorTempF: null })).toBeNull();
  });
});

describe("co-occurrence windows", () => {
  it("links a smell verb to gas across intervening words", () => {
    expect(classify("I can smell something like gas")?.category).toBe("GAS_LEAK");
  });

  it("does not link them across a whole paragraph", () => {
    const far =
      "I can smell something odd but honestly it might just be the neighbours " +
      "cooking dinner again which happens most evenings around here, anyway the " +
      "gas bill also went up";
    expect(classify(far)).toBeNull();
  });

  it("requires the vulnerable person and the hazard in the same breath", () => {
    expect(
      classify("My basement is flooding and I have a newborn baby here")?.category,
    ).toBe("VULNERABLE_PERSON_AT_RISK");
  });
});

describe("multilingual and code-switched input", () => {
  it("strips accents so callers need not dictate them", () => {
    expect(classify("Hay un incendio en el sótano")?.category).toBe("FIRE");
    expect(classify("Hay un incendio en el sotano")?.category).toBe("FIRE");
  });

  it("fires on a hazard stated in Spanish inside an English sentence", () => {
    expect(classify("Hola, huele a gas in the kitchen")?.category).toBe("GAS_LEAK");
  });

  it("fires on a hazard stated in English inside a Spanish sentence", () => {
    expect(
      classify("Mi calentador está leaking y hay agua por todas partes")?.category,
    ).toBe("FLOODING");
  });
});

describe("ASR robustness", () => {
  it("tolerates one edit inside a multi-word hazard phrase", () => {
    expect(classify("there's a gas leek behind the stove")?.category).toBe("GAS_LEAK");
  });

  it("does not fuzz a three-letter word into a hazard", () => {
    // "has" is one edit from "gas"; it must never fire.
    expect(classify("he has leaks under the sink")).toBeNull();
  });

  it("refuses the measured collisions between flooring and flooding", () => {
    expect(classify("We're installing new flooring next week")).toBeNull();
    expect(classify("the old flooring was floored badly")).toBeNull();
  });

  it("still catches genuine flooding despite the exclusion", () => {
    expect(classify("the basement is flooding")?.category).toBe("FLOODING");
  });
});

describe("partial transcripts", () => {
  it("returns nothing for empty or punctuation-only input", () => {
    for (const t of ["", "   ", "...", "\n\t"]) expect(classify(t)).toBeNull();
  });

  it("fires as soon as the hazard words arrive, mid-utterance", () => {
    // The classifier runs on every ASR partial, so it must not wait for a
    // sentence to finish.
    const partials = ["I think", "I think there's", "I think there's a gas", "I think there's a gas leak"];
    const results = partials.map((p) => classify(p));
    expect(results.slice(0, 3).every((r) => r === null)).toBe(true);
    expect(results[3]?.category).toBe("GAS_LEAK");
  });

  it("is idempotent across repeated calls on the same partial", () => {
    const a = classify("the panel is sparking");
    const b = classify("the panel is sparking");
    expect(a).toEqual(b);
  });
});

/* -------------------------------------------------------------------------- */
/* Lexicon hygiene                                                             */
/* -------------------------------------------------------------------------- */

describe("lexicon", () => {
  it("assigns a severity to every hazard category", () => {
    expect(Object.keys(HAZARD_SEVERITY).sort()).toEqual([...HAZARD_CATEGORIES].sort());
  });

  it("gives every rule a unique id", () => {
    const ids = HAZARD_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every hazard category with at least one rule", () => {
    const covered = new Set(HAZARD_RULES.map((r) => r.category));
    expect([...covered].sort()).toEqual([...HAZARD_CATEGORIES].sort());
  });

  it("bounds every co-occurrence rule so it cannot match across a whole call", () => {
    for (const rule of HAZARD_RULES) {
      if (rule.groups.length > 1) expect(rule.withinTokens).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Text primitives                                                             */
/* -------------------------------------------------------------------------- */

describe("withinEditDistance", () => {
  it.each([
    ["leak", "leek", 1, true],
    ["leak", "leak", 0, true],
    ["gas", "has", 1, true],
    ["flooding", "flooring", 1, true],
    ["flooding", "flowering", 1, false],
    ["abc", "abcdef", 1, false],
    ["", "", 0, true],
  ])("distance(%s, %s) <= %i is %s", (a, b, max, expected) => {
    expect(withinEditDistance(a, b, max)).toBe(expected);
  });
});

describe("tokenize", () => {
  it("records offsets into the original string so matches quote verbatim", () => {
    const text = "Huele a GAS!";
    const tokens = tokenize(text);
    expect(tokens.map((t) => t.norm)).toEqual(["huele", "a", "gas"]);
    expect(text.slice(tokens[2]!.start, tokens[2]!.end)).toBe("GAS");
  });

  it("folds accents and ñ", () => {
    expect(tokenize("sótano niño está").map((t) => t.norm)).toEqual([
      "sotano",
      "nino",
      "esta",
    ]);
  });

  it("yields nothing for punctuation-only input", () => {
    expect(tokenize("...!?")).toEqual([]);
  });
});

describe("findPhrase", () => {
  it("finds every occurrence, not just the first", () => {
    const tokens = tokenize("gas leak here and gas leak there");
    expect(findPhrase(tokens, ["gas", "leak"])).toEqual([
      { from: 0, to: 2 },
      { from: 4, to: 6 },
    ]);
  });

  it("returns nothing when the phrase is longer than the utterance", () => {
    expect(findPhrase(tokenize("gas"), ["gas", "leak"])).toEqual([]);
  });

  it("requires adjacency — scattered words are not a phrase", () => {
    expect(findPhrase(tokenize("gas is about to leak"), ["gas", "leak"])).toEqual([]);
  });
});
