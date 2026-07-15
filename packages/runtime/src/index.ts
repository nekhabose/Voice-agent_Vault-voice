/**
 * @ledgerline/runtime — the seam the voice worker binds to.
 *
 * `CallRuntime` turns raw caller speech into validated machine events and
 * machine effects into spoken sentences (plan, §10.4). It runs the *real* state
 * machine, the *real* emergency classifier, the *real* validators, and the
 * *real* extractor port — the audio layer is a `VoiceSession`, and the only
 * thing that reaches the CRM is a `PendingBooking` posted after hangup.
 *
 * Everything consequential lives here, in TypeScript, so a whole call is
 * testable without a phone. The Python LiveKit worker (apps/agent) is the thin
 * binding that gives this a real microphone and a real SIP trunk (Step 4.2/4.6).
 */
export * from "./runtime.js";
export * from "./fakes.js";
export * from "./booking.js";
export * from "./validate.js";
