import type { MessageBody } from "@ledgerline/anthropic";
import type { BookingOutcome, PendingBookingPayload, TriageCase } from "@ledgerline/contracts";
import { TOOL_NAME } from "./triager.js";

/**
 * Committed model responses and the bookings they judge.
 *
 * **Hand-authored, not recorded** — no Anthropic credential exists here, and the
 * repo's rule is that a fixture which claims to be a recording when it is not is
 * worse than none. They are wire-shaped and are driven through the real SDK and
 * the real tool schema, so the binding is proven offline; what they cannot prove
 * is that `claude-opus-4-8` labels these three cases the way a human would. That
 * is exactly what Step 6.3's weekly audit measures, and why we publish the
 * agreement rate instead of asserting it.
 */

const CALL_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const TENANT_ID = "8f7a2a4e-1c3b-4d5e-9f60-1a2b3c4d5e6f";

export const BOOKED: PendingBookingPayload = {
  callId: CALL_ID,
  tenantId: TENANT_ID,
  customer: {
    name: "Dana Whitfield",
    phone: "+13055550142",
    locale: "en",
  },
  address: {
    line1: "1247 Calle Ocho",
    line2: undefined,
    city: "Miami",
    state: "FL",
    postalCode: "33135",
    formatted: "1247 Calle Ocho, Miami, FL 33135, USA",
    lat: 25.7651,
    lng: -80.2201,
  },
  problemDescription: "Water heater is leaking into the garage",
  urgency: "SAME_DAY",
  window: {
    startsAt: "2026-07-13T18:00:00.000Z",
    endsAt: "2026-07-13T22:00:00.000Z",
  },
  jobTypeId: null,
};

const BOOKING_ID = "b8f0d3c2-9a1e-4c7b-8f2d-6e5a4b3c2d1e";

function outcome(fields: Record<string, unknown>, cancelled = false): BookingOutcome {
  return {
    bookingId: BOOKING_ID,
    cancelled,
    correctedFields: fields,
    source: "CRM_POLL",
    classification: null,
    humanLabel: null,
    observedAt: "2026-07-14T18:00:00.000Z",
  };
}

/**
 * The one that matters. `Calle Ocho` is `SW 8th St`; the agent heard the street
 * the caller said and the contractor rewrote it into the form the truck needs.
 * A model looking for an exculpatory story could call this an enrichment.
 */
export const MISHEARD_STREET: TriageCase = {
  booked: BOOKED,
  outcome: outcome({
    service_address: {
      line1: "1247 SW 8th St",
      line2: null,
      city: "Miami",
      state: "FL",
      postalCode: "33135",
    },
  }),
};

/** The customer moved it. Nobody got anything wrong. */
export const RESCHEDULED: TriageCase = {
  booked: BOOKED,
  outcome: outcome({
    appointment_window: {
      startsAt: "2026-07-15T14:00:00.000Z",
      endsAt: "2026-07-15T18:00:00.000Z",
    },
  }),
};

/** A gate code the caller never mentioned. Incomplete, not wrong. */
export const ENRICHED: TriageCase = {
  booked: BOOKED,
  outcome: outcome({
    problem_description:
      "Water heater is leaking into the garage. Gate code 4417. Dog in the yard.",
  }),
};

/** Cancelled with no field edited: the diff is empty and the booking still failed. */
export const CANCELLED: TriageCase = {
  booked: BOOKED,
  outcome: outcome({}, true),
};

interface Verdict {
  readonly classification: string | null;
  readonly rationale?: string;
}

function message({ classification, rationale = "The evidence names the field." }: Verdict): MessageBody {
  return {
    id: "msg_01TriageFixture",
    type: "message",
    role: "assistant",
    model: "claude-opus-4-8",
    content: [
      {
        type: "tool_use",
        id: "toolu_01TriageFixture",
        name: TOOL_NAME,
        input: { classification, rationale },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 640,
      output_tokens: 58,
      cache_creation_input_tokens: 420,
      cache_read_input_tokens: 0,
    },
  };
}

export const AGENT_ERROR = message({
  classification: "agent_error",
  rationale:
    "service_address: 1247 Calle Ocho and 1247 SW 8th St are the same street under two names. The agent recorded the spoken form and the contractor had to rewrite it.",
});

export const BUSINESS_CHANGE = message({
  classification: "business_change",
  rationale:
    "appointment_window: moved two days out, to a window the agent never offered. Nothing suggests the original was misheard.",
});

export const ENRICHMENT = message({
  classification: "enrichment",
  rationale:
    "problem_description: the contractor appended a gate code and a dog. The original description is unchanged and was not wrong.",
});

/** The model looked and could not tell. Counts against us, on purpose. */
export const DECLINED = message({
  classification: null,
  rationale: "The window moved by two hours and nothing in the evidence says why.",
});

/** A label that is not one of the three. Not a fourth kind of correction. */
export const UNRECOGNISED_LABEL = message({
  classification: "our_bad",
  rationale: "It was our fault.",
});

/** A verdict with no argument behind it is not auditable, so it does not count. */
export const NO_RATIONALE = message({ classification: "business_change", rationale: "" });

/**
 * A tool call whose input is not an object at all. `strict` should make this
 * impossible; it is here because "should be impossible" is how a booking gets
 * labeled from a value nobody parsed.
 */
export const MALFORMED_INPUT: MessageBody = {
  id: "msg_01TriageMalformed",
  type: "message",
  role: "assistant",
  model: "claude-opus-4-8",
  content: [
    { type: "tool_use", id: "toolu_01Malformed", name: TOOL_NAME, input: "agent_error" },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: {
    input_tokens: 640,
    output_tokens: 4,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 420,
  },
};

export const REFUSAL: MessageBody = {
  id: "msg_01TriageRefusal",
  type: "message",
  role: "assistant",
  model: "claude-opus-4-8",
  content: [{ type: "text", text: "I'd rather not." }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 640,
    output_tokens: 9,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 420,
  },
};
