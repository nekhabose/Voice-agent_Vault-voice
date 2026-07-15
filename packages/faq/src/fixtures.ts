import type { MessageBody } from "@ledgerline/anthropic";
import type { FaqEntry } from "@ledgerline/contracts";
import { TOOL_NAME } from "./answerer.js";

/**
 * A committed FAQ, and committed model responses to it.
 *
 * **Hand-authored, not recorded** — the same honesty `extraction/fixtures.ts`
 * opens with, and for the same reason: no Anthropic credential exists in this
 * environment, and a fixture that claims to be a recording when it is not is
 * worse than no fixture, because the next person trusts it. They are wire-shaped
 * (exactly what `POST /v1/messages` returns) and they are driven through the real
 * SDK, the real tool schema, and the real selection logic, so they still prove
 * that the binding works and that an invented id is refused.
 *
 * Re-record against `claude-sonnet-5` when a credential exists — task 5.5's
 * sibling for this call site.
 */

const TENANT = "8f7a2a4e-1c3b-4d5e-9f60-1a2b3c4d5e6f";

/**
 * The questions a plumbing shop's callers actually ask. Written by the
 * contractor; spoken to the caller word for word (plan, §6 call site #3).
 */
export const FAQ_ENTRIES: readonly FaqEntry[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: TENANT,
    question: "Do you charge for an estimate?",
    answer:
      "Estimates are free for replacements, and there's a seventy-nine dollar diagnostic fee for repairs, which we credit back if you go ahead with the work.",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    tenantId: TENANT,
    question: "What are your hours?",
    answer:
      "We're open Monday through Friday, eight to five, and we take emergency calls around the clock.",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    tenantId: TENANT,
    question: "Do you take credit cards?",
    answer: "We take all major credit cards, and we can also do financing on bigger jobs.",
  },
];

export const TENANT_ID = TENANT;

/** A tenant with no FAQ of their own — the cross-tenant leak, if one existed. */
export const OTHER_TENANT_ID = "99999999-9999-4999-8999-999999999999";

interface Selection {
  readonly entryId: string | null;
  readonly confidence?: number;
}

function message({ entryId, confidence = 0.94 }: Selection): MessageBody {
  return {
    id: "msg_01FaqFixture",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [
      {
        type: "tool_use",
        id: "toolu_01FaqFixture",
        name: TOOL_NAME,
        input: { entry_id: entryId, confidence },
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 320,
      output_tokens: 24,
      cache_creation_input_tokens: 210,
      cache_read_input_tokens: 0,
    },
  };
}

/** The model picks the diagnostic-fee entry. The caller hears it verbatim. */
export const SELECTED_ESTIMATE_FEE = message({
  entryId: "11111111-1111-4111-8111-111111111111",
});

/** Retrieval surfaced candidates; none of them answers what was asked. */
export const SELECTED_NONE = message({ entryId: null });

/**
 * An id we never sent. The model has invented an answer to speak, which is the
 * one thing this call site exists to prevent — it must come back `unknown`.
 */
export const SELECTED_HALLUCINATED_ID = message({
  entryId: "deadbeef-0000-4000-8000-000000000000",
});

/**
 * A tool call whose input is not an object. `strict` should make this
 * impossible; "should be impossible" is not a reason to speak whatever it was.
 */
export const MALFORMED_INPUT: MessageBody = {
  id: "msg_01FaqMalformed",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [
    { type: "tool_use", id: "toolu_01Malformed", name: TOOL_NAME, input: "the first one" },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: {
    input_tokens: 320,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 210,
  },
};

/** The model refused, or ran out of tokens. Not "no answer" — "could not ask". */
export const REFUSAL: MessageBody = {
  id: "msg_01FaqRefusal",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5",
  content: [{ type: "text", text: "I can't help with that." }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 320,
    output_tokens: 8,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 210,
  },
};
