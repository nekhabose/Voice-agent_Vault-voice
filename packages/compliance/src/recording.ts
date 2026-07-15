import {
  assessConsent,
  requiresNoticeBeforeRecording,
  type ConsentAssessment,
  type TenantConsentProfile,
} from "./consent.js";
import { DPA_VERSION } from "./dpa.js";

/**
 * Whether this call may be recorded, and from when.
 *
 * The whole of Step 8's recording rule is one ordering: **the notice comes first, and
 * the recording comes second.** Everything else in this file is the list of reasons we
 * might not record at all.
 */

/** What the recording gate needs to know about the contractor. */
export interface TenantRecordingProfile extends TenantConsentProfile {
  /**
   * The contractor turned recording on. Defaults to **off** in the database, so a
   * tenant nobody has configured is a tenant we do not record — the failure mode of
   * an unfinished onboarding is a missing feature rather than an unlawful one.
   */
  readonly recordingEnabled: boolean;
  /**
   * The DPA version this contractor has accepted, or `null`. The recording is caller
   * personal data processed *on their behalf*, and the DPA is the instrument that
   * authorises it. No DPA, no lawful basis, no recording.
   */
  readonly dpaVersion: string | null;
}

export type RecordingMode =
  /**
   * The only mode in which audio exists before the caller has been told anything.
   * Reached solely when **both** ends of the call are known one-party-consent
   * states — see `assessConsent`, which will not reach `ONE_PARTY` on an absence
   * of evidence.
   */
  | "RECORD_FROM_ANSWER"
  /**
   * Recording begins after {@link AI_DISCLOSURE} has been *delivered* — not queued,
   * not rendered: spoken, with `SpeechOutcome.spoke === true`. In an all-party state
   * the notice plus the caller's decision to keep talking is the consent, so audio
   * captured before it is audio captured without it.
   */
  | "RECORD_AFTER_NOTICE"
  /** No recording, at any point on this call. */
  | "DO_NOT_RECORD";

export interface RecordingDecision {
  readonly mode: RecordingMode;
  readonly consent: ConsentAssessment;
  /** Kept with the call. "We recorded this, and here is what we believed entitled us to." */
  readonly reason: string;
}

/**
 * The gate. Four questions, in this order, and the order is the argument:
 *
 * 1. **Did the contractor ask for recording?** It is their business and their
 *    customers. Off by default.
 * 2. **Have they signed the current DPA?** We are their processor. Without the
 *    instrument that says so, we have no lawful basis to hold their caller's voice,
 *    and a lapsed version is not a formality — it is the version that describes what
 *    we now do with it.
 * 3. **Is either party in an all-party state, or do we not know?** Then notice first.
 * 4. Only then, and only with both ends known one-party: record from answer.
 *
 * Every early exit in this function is a *refusal*, and every unknown lands on the
 * strict side of a branch. There is no path through it where a missing fact produces
 * a recording — which is the same shape as `isAgentError` counting an unclassified
 * correction against us (principle #5) and `isCronRequest` refusing a missing secret:
 * **the failure mode of this system's own incompleteness must cost us, never the
 * person on the other end of the phone.**
 */
export function recordingDecision(
  callerE164: string | null | undefined,
  tenant: TenantRecordingProfile,
): RecordingDecision {
  const consent = assessConsent(callerE164, tenant);

  if (!tenant.recordingEnabled) {
    return {
      mode: "DO_NOT_RECORD",
      consent,
      reason: "the contractor has not enabled call recording",
    };
  }

  if (tenant.dpaVersion !== DPA_VERSION) {
    return {
      mode: "DO_NOT_RECORD",
      consent,
      reason:
        tenant.dpaVersion === null
          ? `the contractor has accepted no data processing addendum; ${DPA_VERSION} is current`
          : `the contractor accepted DPA ${tenant.dpaVersion}; ${DPA_VERSION} is current and describes what we now do with a recording`,
    };
  }

  if (requiresNoticeBeforeRecording(consent.regime)) {
    return {
      mode: "RECORD_AFTER_NOTICE",
      consent,
      reason: consent.reason,
    };
  }

  return {
    mode: "RECORD_FROM_ANSWER",
    consent,
    reason: consent.reason,
  };
}

/* -------------------------------------------------------------------------- */
/* Retention                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How long a recording lives, and how long the words do.
 *
 * The two numbers differ because the risks differ. A recording is the caller's
 * *voice* — biometric-adjacent, and the thing a breach headline is written about. The
 * transcript is text, and a contractor legitimately wants to reread what a customer
 * said about a job three months ago.
 *
 * **What survives both is the part with no caller in it.** `runRetention()` blanks
 * `call_turns.text` and leaves `first_word_latency_ms`, `barge_in`, and `turn_take_ok`
 * standing, so every number in `computeMetrics()` outlives every word the caller
 * spoke. That is not a lucky accident of the schema; it is why principle #5's metrics
 * were defined over turn *shape* rather than turn content, and it means the published
 * reliability figures can be recomputed from a database that has forgotten everybody.
 *
 * And the evidence behind the published number — `outcomes`, `job_snapshots` — is not
 * on this schedule at all, because the app role holds **no `DELETE` on either**
 * (migration `0002`). The deletion job structurally cannot reach the raw diff. A
 * retention policy that could quietly shred the corrections we published a rate from
 * would be the missed webhook wearing a fourth hat.
 */
export const RECORDING_RETENTION_DAYS = 90;

export const TRANSCRIPT_RETENTION_DAYS = 365;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant before which a recording made at `now` is expired. */
export const recordingsExpireBefore = (now: Date): Date =>
  new Date(now.getTime() - RECORDING_RETENTION_DAYS * DAY_MS);

export const transcriptsExpireBefore = (now: Date): Date =>
  new Date(now.getTime() - TRANSCRIPT_RETENTION_DAYS * DAY_MS);
