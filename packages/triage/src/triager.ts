import Anthropic from "@anthropic-ai/sdk";
import { outageReasonOrThrow } from "@ledgerline/anthropic";
import {
  OutcomeClassificationSchema,
  type CorrectionTriager,
  type TriageCase,
  type TriageVerdict,
} from "@ledgerline/contracts";

/**
 * Call site #5 (plan, §6): was the contractor's edit *our* mistake?
 *
 * This is the model that grades our own homework, and everything about how it is
 * built is a hedge against that:
 *
 * - **It cannot see its own effect on the number.** It classifies one booking at
 *   a time and never learns what the correction rate is.
 * - **It may decline**, and declining costs us: an unclassified correction counts
 *   as an `agent_error` in `packages/telemetry`. A shrug is not an acquittal.
 * - **It must write a rationale**, because the weekly human audit (Step 6.3) has
 *   to be able to disagree cheaply, and "agent_error" with no argument is not
 *   something a human can check in thirty seconds.
 * - **It never writes to `correctedFields`.** The raw diff is retained forever
 *   and anyone can recount (Step 6.2, and `TriageStore` in `packages/workflows`
 *   makes it a type error to try).
 *
 * If it and the humans disagree more than ~5% of the time, we publish the raw
 * correction rate and drop the classifier — `publishedCorrectionRate()` in
 * `packages/telemetry` is that rule, in code.
 */

/** "Correctness over latency", plan §4. Nothing here is in the audio path. */
export const TRIAGE_MODEL = "claude-opus-4-8";

/** A label and a sentence of reasoning. */
const MAX_TOKENS = 512;

/**
 * Disabled, and **not** because of latency — this is a nightly batch.
 *
 * Extended thinking and a forced `tool_choice` are mutually exclusive in the
 * Messages API (thinking allows `auto`/`none` only). Given the choice between a
 * model that reasons at length and might answer in prose, and a model whose
 * every answer lands inside the three-value enum, we take the enum: a triage pass
 * whose output has to be parsed out of a paragraph is a triage pass that
 * silently mislabels whatever it fails to parse.
 */
const THINKING: Anthropic.ThinkingConfigDisabled = { type: "disabled" };

export const TOOL_NAME = "classify_correction";

/**
 * Frozen. The booking under review goes in `messages`, never here (plan, §10.1).
 *
 * The last paragraph is the bias correction, and it is the most important text in
 * this package. Left to itself, a model asked "was this your fault?" reaches for
 * the exculpatory reading — the caller must have changed their mind, the CRM must
 * have enriched it — and every one of those readings quietly improves the number
 * we publish. So the default is guilt, and the burden of proof sits on the
 * exoneration.
 */
export const SYSTEM_PROMPT = [
  "A voice agent booked a job from a phone call. The contractor later edited or",
  "cancelled it in their CRM. You are given what the agent captured and what the",
  "contractor changed it to. Decide why it changed.",
  "",
  "agent_error — the agent got it wrong. It misheard, mis-transcribed, guessed, or",
  "recorded something the caller did not say. The contractor's value is a repair of",
  "our mistake.",
  "",
  "business_change — the world changed after the call. The customer rescheduled or",
  "cancelled, the contractor moved the appointment to fit their day, the job turned",
  "out to be a different job. Nobody got anything wrong.",
  "",
  "enrichment — the contractor added detail we never had and could not have had.",
  "A gate code, an apartment number the caller did not mention, a note for the tech.",
  "The original was not wrong; it was incomplete.",
  "",
  "Choose null if the evidence does not settle it.",
  "",
  "You are classifying the mistakes of the system you are part of, and the label",
  "you choose decides a reliability number that is published. That is a reason to",
  "be harder on yourself, not easier. If a correction is consistent with the agent",
  "having misheard, it is agent_error — even if a story exists in which the customer",
  "simply changed their mind. Do not reach for that story. An address rewritten to a",
  "different form of the same street is agent_error. An appointment moved by two",
  "hours is business_change only if something in the evidence says so.",
].join("\n");

/** Frozen alongside the system prompt: no per-booking bytes. */
export const CLASSIFY_TOOL = {
  name: TOOL_NAME,
  description:
    "Record why the contractor changed this booking, or null if the evidence does not settle it.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      classification: {
        anyOf: [
          { type: "string", enum: [...OutcomeClassificationSchema.options] },
          { type: "null" },
        ],
        description:
          "agent_error, business_change, enrichment, or null if the evidence does not settle it.",
      },
      rationale: {
        type: "string",
        description:
          "One or two sentences a human auditor can check. Name the field and say what the evidence shows.",
      },
    },
    required: ["classification", "rationale"],
    additionalProperties: false as const,
  },
};

export interface TriageUsage {
  readonly bookingId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
}

export interface AnthropicTriagerOptions {
  readonly client: Anthropic;
  readonly model?: string;
  readonly onUsage?: (usage: TriageUsage) => void;
}

export class AnthropicTriager implements CorrectionTriager {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly onUsage: (usage: TriageUsage) => void;

  constructor(options: AnthropicTriagerOptions) {
    this.client = options.client;
    this.model = options.model ?? TRIAGE_MODEL;
    this.onUsage = options.onUsage ?? (() => {});
  }

  /** The outgoing request. Asserted on directly, exactly as the extractor's is. */
  request(triageCase: TriageCase): Anthropic.MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      max_tokens: MAX_TOKENS,
      thinking: THINKING,
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      tools: [CLASSIFY_TOOL],
      tool_choice: {
        type: "tool",
        name: TOOL_NAME,
        disable_parallel_tool_use: true,
      },
      messages: [{ role: "user", content: evidence(triageCase) }],
    };
  }

  async classify(triageCase: TriageCase): Promise<TriageVerdict> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(this.request(triageCase));
    } catch (error) {
      return { kind: "unavailable", reason: outageReasonOrThrow(error) };
    }

    this.onUsage({
      bookingId: triageCase.outcome.bookingId,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
    });

    return interpret(message);
  }
}

/**
 * What the agent captured, and what the contractor made of it.
 *
 * Rendered as text rather than raw JSON because the model has to compare *fields*,
 * and a diff it has to reconstruct from two nested objects is a diff it can get
 * wrong before it starts reasoning about why. The `formatted` address never
 * appears: it is the geocoder's, not the contractor's, and `diffBooking` already
 * refuses to compare it (plan, principle #5).
 */
export function evidence(triageCase: TriageCase): string {
  const { booked, outcome } = triageCase;
  const address = booked.address;

  const lines = [
    "What the agent captured on the call:",
    `  caller_name: ${booked.customer.name}`,
    `  callback_phone: ${booked.customer.phone}`,
    `  service_address: ${[address.line1, address.line2, address.city, address.state, address.postalCode]
      .filter((part) => part !== null && part !== undefined && part !== "")
      .join(", ")}`,
    `  problem_description: ${booked.problemDescription}`,
    `  urgency: ${booked.urgency}`,
    `  appointment_window: ${booked.window.startsAt} to ${booked.window.endsAt}`,
    "",
    outcome.cancelled
      ? "The contractor CANCELLED this job."
      : "The contractor kept the job.",
    "",
    "What the contractor changed:",
  ];

  const corrected = Object.entries(outcome.correctedFields);
  if (corrected.length === 0) {
    lines.push("  (no field was edited)");
  } else {
    for (const [key, value] of corrected) {
      lines.push(`  ${key} -> ${JSON.stringify(value)}`);
    }
  }

  return lines.join("\n");
}

/**
 * `strict` guarantees the shape; the contract's enum guarantees the meaning. A
 * label outside `OutcomeClassificationSchema` is not a fourth kind of correction,
 * it is a model that did not do the task — and it is `declined`, which counts
 * against us, rather than a value written into a column typed to reject it.
 */
function interpret(message: Anthropic.Message): TriageVerdict {
  const block = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === TOOL_NAME,
  );

  if (!block) {
    return {
      kind: "unavailable",
      reason: `no ${TOOL_NAME} call (stop_reason: ${message.stop_reason})`,
    };
  }

  return interpretClassification(block.input);
}

/**
 * The `{classification, rationale}` the model filled, turned into a verdict —
 * vendor-independent, and **shared with `GroqTriager`**.
 *
 * Every rule the interested party is held to lives in this function: a label
 * outside the enum is `declined`, a verdict with no rationale is `declined`, and
 * `declined` counts against us. A second copy of it behind a second vendor is a
 * second place for an unauditable exoneration to get through — and the whole
 * design of this call site is that it cannot produce one.
 */
export function interpretClassification(input: unknown): TriageVerdict {
  if (typeof input !== "object" || input === null) {
    return { kind: "declined", reason: "no tool input" };
  }

  const { classification, rationale } = input as {
    classification?: unknown;
    rationale?: unknown;
  };
  const reason = typeof rationale === "string" && rationale !== "" ? rationale : "no rationale";

  if (classification === null || classification === undefined) {
    return { kind: "declined", reason };
  }

  const parsed = OutcomeClassificationSchema.safeParse(classification);
  if (!parsed.success) {
    return { kind: "declined", reason: `unrecognised label: ${String(classification)}` };
  }

  // A label with no argument behind it is not auditable, and an unauditable
  // exoneration is exactly what this call site must not be able to produce.
  if (typeof rationale !== "string" || rationale.trim() === "") {
    return { kind: "declined", reason: "no rationale" };
  }

  return { kind: "classified", classification: parsed.data, rationale: rationale.trim() };
}
