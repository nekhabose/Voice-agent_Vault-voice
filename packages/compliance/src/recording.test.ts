import { describe, expect, it } from "vitest";
import { DPA_VERSION, dpaStatus } from "./dpa.js";
import {
  RECORDING_RETENTION_DAYS,
  TRANSCRIPT_RETENTION_DAYS,
  recordingDecision,
  recordingsExpireBefore,
  transcriptsExpireBefore,
  type TenantRecordingProfile,
} from "./recording.js";

/** A fully configured Texas shop: recording on, DPA current, one-party state. */
const TEXAS: TenantRecordingProfile = {
  stateCode: "TX",
  recordingEnabled: true,
  dpaVersion: DPA_VERSION,
};

const MIAMI: TenantRecordingProfile = { ...TEXAS, stateCode: "FL" };

const TEXAS_CALLER = "+15125551234";
const CALIFORNIA_CALLER = "+14155551234";

describe("dpaStatus", () => {
  it("is current when the accepted version is the one we publish", () => {
    expect(dpaStatus({ dpaVersion: DPA_VERSION })).toEqual({
      kind: "current",
      version: DPA_VERSION,
    });
  });

  it("is stale when they accepted an older one", () => {
    expect(dpaStatus({ dpaVersion: "2020-01-01" })).toEqual({
      kind: "stale",
      accepted: "2020-01-01",
      current: DPA_VERSION,
    });
  });

  it("is none when they never accepted one", () => {
    expect(dpaStatus({ dpaVersion: null })).toEqual({ kind: "none", current: DPA_VERSION });
  });
});

describe("recordingDecision — every unknown lands on the strict side", () => {
  /**
   * The only path on which audio exists before the caller has been told anything, and
   * `assessConsent` will not reach it on an absence of evidence: both ends must be known
   * one-party states.
   */
  it("records from answer only when both ends are known one-party states", () => {
    const decision = recordingDecision(TEXAS_CALLER, TEXAS);
    expect(decision.mode).toBe("RECORD_FROM_ANSWER");
    expect(decision.consent.regime).toBe("ONE_PARTY");
  });

  it("records only after the notice when the caller is in an all-party state", () => {
    expect(recordingDecision(CALIFORNIA_CALLER, TEXAS).mode).toBe("RECORD_AFTER_NOTICE");
  });

  it("records only after the notice when the contractor is in an all-party state", () => {
    expect(recordingDecision(TEXAS_CALLER, MIAMI).mode).toBe("RECORD_AFTER_NOTICE");
  });

  it("records only after the notice when the caller withheld their number", () => {
    expect(recordingDecision(null, TEXAS).mode).toBe("RECORD_AFTER_NOTICE");
  });

  /**
   * This is the mutation that matters. An area code nobody has heard of — a new NANP
   * assignment, a territory, a number that ported oddly — must not become
   * `RECORD_FROM_ANSWER` merely because we had no row for it.
   */
  it("records only after the notice when the area code is not in the map", () => {
    const decision = recordingDecision("+17875551234", TEXAS);
    expect(decision.mode).toBe("RECORD_AFTER_NOTICE");
    expect(decision.consent.regime).toBe("UNKNOWN");
  });

  it("records nobody at all for a tenant nobody has configured", () => {
    const decision = recordingDecision(TEXAS_CALLER, {
      stateCode: "",
      recordingEnabled: false,
      dpaVersion: null,
    });
    expect(decision.mode).toBe("DO_NOT_RECORD");
  });
});

describe("recordingDecision — the contractor has to ask, and has to have signed", () => {
  it("does not record when the contractor has not enabled it", () => {
    const decision = recordingDecision(TEXAS_CALLER, { ...TEXAS, recordingEnabled: false });
    expect(decision.mode).toBe("DO_NOT_RECORD");
    expect(decision.reason).toContain("not enabled");
  });

  /**
   * The DPA is the instrument that authorises us to process a caller's voice on the
   * contractor's behalf. Without it there is no lawful basis, and "we were about to send
   * them the paperwork" is not one.
   */
  it("does not record without an accepted DPA", () => {
    const decision = recordingDecision(TEXAS_CALLER, { ...TEXAS, dpaVersion: null });
    expect(decision.mode).toBe("DO_NOT_RECORD");
    expect(decision.reason).toContain("no data processing addendum");
  });

  /**
   * A stale acceptance is not acceptance. What changes between DPA versions is the
   * subprocessor list and the retention schedule — precisely the two clauses a caller
   * would care about — so a contractor who signed the old one has not agreed to what we
   * now do with a recording.
   *
   * The consequence is meant to hurt: bumping `DPA_VERSION` turns recording off for every
   * tenant until each re-accepts. A version bump that cost nothing would be a version
   * bump nobody read.
   */
  it("treats a stale DPA as no DPA", () => {
    const decision = recordingDecision(TEXAS_CALLER, { ...TEXAS, dpaVersion: "2020-01-01" });
    expect(decision.mode).toBe("DO_NOT_RECORD");
    expect(decision.reason).toContain("2020-01-01");
    expect(decision.reason).toContain(DPA_VERSION);
  });

  /** The refusal comes first, but the assessment is still made — the audit record needs it. */
  it("still reports the consent regime on a call it refuses to record", () => {
    const decision = recordingDecision(CALIFORNIA_CALLER, { ...TEXAS, recordingEnabled: false });
    expect(decision.mode).toBe("DO_NOT_RECORD");
    expect(decision.consent.regime).toBe("ALL_PARTY");
    expect(decision.consent.callerState).toBe("CA");
  });
});

describe("retention windows", () => {
  const NOW = new Date("2026-07-11T00:00:00.000Z");

  it("expires a recording after 90 days and a transcript after a year", () => {
    expect(RECORDING_RETENTION_DAYS).toBe(90);
    expect(TRANSCRIPT_RETENTION_DAYS).toBe(365);
    expect(recordingsExpireBefore(NOW).toISOString()).toBe("2026-04-12T00:00:00.000Z");
    expect(transcriptsExpireBefore(NOW).toISOString()).toBe("2025-07-11T00:00:00.000Z");
  });

  /** The audio outlives nothing. The words outlive the audio. Nothing outlives both. */
  it("keeps the audio for a shorter time than the words", () => {
    expect(recordingsExpireBefore(NOW).getTime()).toBeGreaterThan(
      transcriptsExpireBefore(NOW).getTime(),
    );
  });
});
