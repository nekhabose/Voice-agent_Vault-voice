import { describe, expect, it } from "vitest";
import {
  ALL_PARTY_CONSENT_STATES,
  AREA_CODE_STATE,
  areaCodeOf,
  assessConsent,
  regimeForState,
  requiresNoticeBeforeRecording,
  stateForNumber,
} from "./consent.js";

/** A Texas plumber: one of the two ends, and the one whose location we actually know. */
const TEXAS = { stateCode: "TX" };
/** A Miami plumber. Florida is all-party, so *every* call to this shop is. */
const FLORIDA = { stateCode: "FL" };
const UNCONFIGURED = { stateCode: "" };

describe("areaCodeOf", () => {
  it("reads the NPA out of a US number", () => {
    expect(areaCodeOf("+13055551234")).toBe("305");
  });

  it.each([
    ["a withheld number", null],
    ["an empty string", ""],
    ["a non-US country", "+442071234567"],
    ["a short code", "+1305"],
    ["an NPA starting with 1", "+11055551234"],
    ["an NPA starting with 0", "+10055551234"],
  ])("cannot read %s", (_label, input) => {
    expect(areaCodeOf(input)).toBeNull();
  });
});

describe("the map, and the one direction it is allowed to be wrong in", () => {
  /**
   * The single most important property in this package.
   *
   * An area code is *evidence* of where somebody is, not a fact about it, and the map
   * will always be incomplete — NANP assigns new codes, we do not redeploy. So the
   * design question is never "is the map complete" but "what happens at its edges", and
   * the answer must be that an edge is a *stricter* answer rather than a laxer one.
   *
   * Break this and nothing else in the suite fails: an unknown area code would quietly
   * become one-party, and we would record a caller in a state that requires their
   * consent, from a code we had simply never heard of.
   */
  it("treats an area code it has never heard of as all-party", () => {
    // A valid NPA, deliberately absent from the map: Puerto Rico.
    expect(AREA_CODE_STATE["787"]).toBeUndefined();
    expect(assessConsent("+17875551234", TEXAS).regime).toBe("UNKNOWN");
    expect(requiresNoticeBeforeRecording("UNKNOWN")).toBe(true);
  });

  it("treats a caller who withheld their number as all-party", () => {
    expect(assessConsent(null, TEXAS).regime).toBe("UNKNOWN");
  });

  it("treats a foreign number as all-party", () => {
    expect(assessConsent("+442071234567", TEXAS).regime).toBe("UNKNOWN");
  });

  /**
   * `UNKNOWN` and `ALL_PARTY` produce the same behaviour, and `ONE_PARTY` is the only
   * exception — so "we do not know" can never be the reason a recording started.
   */
  it("has no regime in which ignorance permits a recording", () => {
    expect(requiresNoticeBeforeRecording("UNKNOWN")).toBe(true);
    expect(requiresNoticeBeforeRecording("ALL_PARTY")).toBe(true);
    expect(requiresNoticeBeforeRecording("ONE_PARTY")).toBe(false);
  });

  it("never maps an area code to a state that is not a two-letter code", () => {
    for (const state of Object.values(AREA_CODE_STATE)) {
      expect(state).toMatch(/^[A-Z]{2}$/);
    }
  });

  /** A duplicate key in an object literal is a silent overwrite, not an error. */
  it("assigns each area code exactly once", () => {
    const codes = Object.keys(AREA_CODE_STATE);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[2-9]\d{2}$/);
  });
});

describe("stateForNumber", () => {
  it.each([
    ["+13055551234", "FL"],
    ["+14155551234", "CA"],
    ["+12065551234", "WA"],
    ["+16175551234", "MA"],
    ["+15125551234", "TX"],
    ["+12125551234", "NY"],
  ])("%s was issued in %s", (e164, state) => {
    expect(stateForNumber(e164)).toBe(state);
  });

  it("is null for a code we do not carry", () => {
    expect(stateForNumber("+17875551234")).toBeNull();
  });
});

describe("regimeForState", () => {
  it("knows the all-party states", () => {
    for (const state of ALL_PARTY_CONSENT_STATES) {
      expect(regimeForState(state)).toBe("ALL_PARTY");
    }
  });

  it("knows the one-party states it has area codes for", () => {
    expect(regimeForState("TX")).toBe("ONE_PARTY");
    expect(regimeForState("NY")).toBe("ONE_PARTY");
  });

  /**
   * Vermont has no wiretapping statute at all, and its Supreme Court has read a privacy
   * interest into the vacuum. "No statute" is not "one-party" — it is `UNKNOWN`, which
   * is the strict branch, and a state whose law nobody can quote is not one we record
   * in without asking.
   */
  it("does not mistake a state with no statute for a permissive one", () => {
    expect(regimeForState("VT")).toBe("UNKNOWN");
  });

  it("is UNKNOWN for an unconfigured tenant, never ONE_PARTY", () => {
    expect(regimeForState("")).toBe("UNKNOWN");
    expect(regimeForState(null)).toBe("UNKNOWN");
    expect(regimeForState("XX")).toBe("UNKNOWN");
  });

  it("is case- and whitespace-insensitive, because a database is", () => {
    expect(regimeForState(" ca ")).toBe("ALL_PARTY");
    expect(regimeForState("tx")).toBe("ONE_PARTY");
  });
});

/**
 * Two people are on the call, and a court applies the stricter of their two states'
 * laws. `ONE_PARTY` is therefore a claim about *both* ends — and since we can never be
 * certain of the caller's, it is a claim we make rarely and defend when we do.
 */
describe("assessConsent — the stricter of the two ends", () => {
  it("is one-party only when both ends are known one-party states", () => {
    const assessment = assessConsent("+15125551234", TEXAS);
    expect(assessment.regime).toBe("ONE_PARTY");
    expect(assessment.callerState).toBe("TX");
  });

  it("is all-party when the *caller* is in an all-party state", () => {
    // A Californian phoning a Texas shop. Texas would let us record; California would
    // not, and California is where the person being recorded is.
    const assessment = assessConsent("+14155551234", TEXAS);
    expect(assessment.regime).toBe("ALL_PARTY");
    expect(assessment.reason).toContain("caller's CA");
  });

  it("is all-party when the *contractor* is in an all-party state", () => {
    // A Texan phoning a Miami shop. The caller's own state would permit it; the
    // contractor's does not, and the contractor is a party too.
    const assessment = assessConsent("+15125551234", FLORIDA);
    expect(assessment.regime).toBe("ALL_PARTY");
    expect(assessment.reason).toContain("contractor's FL");
  });

  /**
   * The realistic bad deployment: somebody onboards a tenant and never fills in the
   * state. Every call to that shop must be strict, and the reason must say so out loud
   * rather than leaving a `null` for somebody to interpret generously later.
   */
  it("is all-party when nobody configured the contractor's state", () => {
    const assessment = assessConsent("+15125551234", UNCONFIGURED);
    expect(assessment.regime).toBe("UNKNOWN");
    expect(assessment.reason).toContain("all-party");
  });

  it("always gives a reason — a verdict with no argument is not auditable", () => {
    const cases = [
      assessConsent("+15125551234", TEXAS),
      assessConsent("+14155551234", TEXAS),
      assessConsent(null, TEXAS),
      assessConsent("+17875551234", UNCONFIGURED),
    ];
    for (const assessment of cases) expect(assessment.reason.length).toBeGreaterThan(10);
  });
});
