/**
 * Recorded model responses, replayed through the real `SLOT_SPECS`.
 *
 * **These were hand-authored, not recorded from a live model.** No Anthropic
 * credential existed when Step 1 was built, and a fixture that claims to be a
 * recording when it is not is worse than no fixture: the next person trusts it.
 * They are wire-shaped — exactly the JSON body `POST /v1/messages` returns —
 * and the replay suite drives them through the real SDK, the real tool schema,
 * and the real Zod contracts, so they still prove that a contract change breaks
 * the extractor at build time.
 *
 * Re-record them against `claude-sonnet-5` the first time a credential exists;
 * the assertions should not need to change. Live calls belong in the nightly
 * eval arm, never in `npm test`.
 */

import type { MessageBody } from "@ledgerline/anthropic";

/** The wire shape of a `POST /v1/messages` response. Shared by every binding. */
export type { MessageBody };

interface ToolUse {
  readonly name: string;
  readonly value: unknown;
  readonly confidence: number;
  readonly cacheRead?: number;
}

function message({ name, value, confidence, cacheRead = 0 }: ToolUse): MessageBody {
  return {
    id: "msg_01ExtractionFixture",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "tool_use", id: "toolu_01Fixture", name, input: { value, confidence } }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 14,
      output_tokens: 42,
      cache_creation_input_tokens: cacheRead === 0 ? 1180 : 0,
      cache_read_input_tokens: cacheRead,
    },
  };
}

/* One per slot: the happy path. -------------------------------------------- */

export const CALLER_NAME_FILLED = message({
  name: "record_caller_name",
  value: "Dana Whitfield",
  confidence: 0.96,
});

/** Spoken digits, not E.164. `validatePhone` owns the normalisation. */
export const CALLBACK_PHONE_FILLED = message({
  name: "record_callback_phone",
  value: "305 555 0142",
  confidence: 0.93,
});

/** No `formatted`, no `lat`/`lng` — the geocoder has not run yet. */
export const SERVICE_ADDRESS_FILLED = message({
  name: "record_service_address",
  value: {
    line1: "1247 Barton Springs Rd",
    line2: null,
    city: "Austin",
    state: "TX",
    postalCode: "78704",
  },
  confidence: 0.91,
});

export const PROBLEM_DESCRIPTION_FILLED = message({
  name: "record_problem_description",
  value: "Water heater is leaking from the bottom and the pilot light is out",
  confidence: 0.94,
});

export const URGENCY_FILLED = message({
  name: "record_urgency",
  value: "SAME_DAY",
  confidence: 0.88,
});

export const APPOINTMENT_WINDOW_FILLED = message({
  name: "record_appointment_window",
  value: { startsAt: "2026-07-10T13:00:00-05:00", endsAt: "2026-07-10T15:00:00-05:00" },
  confidence: 0.9,
});

/* The four that matter more. ----------------------------------------------- */

/** The caller never said it. `null` is the tool's escape from a forced call. */
export const CALLER_NAME_ABSENT = message({
  name: "record_caller_name",
  value: null,
  confidence: 0,
});

/**
 * "Tuesday or Wednesday, whichever works." Ambiguity collapses to `absent`, and
 * the machine re-asks — which is the whole reason the tool has a null escape.
 */
export const APPOINTMENT_WINDOW_AMBIGUOUS = message({
  name: "record_appointment_window",
  value: null,
  confidence: 0.31,
});

/** Below `LOW_CONFIDENCE_THRESHOLD` (0.85): filled, but read back to the caller. */
export const CALLER_NAME_LOW_CONFIDENCE = message({
  name: "record_caller_name",
  value: "Dana",
  confidence: 0.42,
});

/**
 * Shape-valid, meaning-invalid: `strict` cannot enforce the ZIP pattern (a
 * string constraint), so `ABCDE` reaches us and `AddressInputSchema` rejects it.
 * This is the fixture that justifies re-validating on the way in.
 */
export const SERVICE_ADDRESS_MALFORMED = message({
  name: "record_service_address",
  value: {
    line1: "1247 Barton Springs Rd",
    line2: null,
    city: "Austin",
    state: "TX",
    postalCode: "ABCDE",
  },
  confidence: 0.87,
});

/** Confidence outside `[0, 1]`; `strict` strips numeric bounds, so we clamp. */
export const URGENCY_CONFIDENCE_OUT_OF_RANGE = message({
  name: "record_urgency",
  value: "EMERGENCY",
  confidence: 1.4,
});

/** Second turn on a warm prefix: this is what a working cache looks like. */
export const CALLER_NAME_CACHE_WARM = message({
  name: "record_caller_name",
  value: "Dana Whitfield",
  confidence: 0.96,
  cacheRead: 1180,
});

/** No tool call at all. Not the caller's fault, so not `absent`. */
export const REFUSAL: MessageBody = {
  id: "msg_01ExtractionFixtureRefusal",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [],
  stop_reason: "refusal",
  stop_sequence: null,
  usage: {
    input_tokens: 14,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 1180,
  },
};
