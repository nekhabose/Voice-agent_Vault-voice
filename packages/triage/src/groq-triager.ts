import {
  degradeReasonOrThrow,
  modeFor,
  readStructured,
  structuredRequest,
  type StructuredMode,
  type StructuredTool,
} from "@ledgerline/groq";
import type {
  CorrectionTriager,
  TriageCase,
  TriageVerdict,
} from "@ledgerline/contracts";
import type Groq from "groq-sdk";
import {
  CLASSIFY_TOOL,
  evidence,
  interpretClassification,
  SYSTEM_PROMPT,
  TOOL_NAME,
} from "./triager.js";

/**
 * Call site #5, second vendor: was the contractor's edit *our* mistake?
 *
 * The model that grades our own homework, on a different vendor, with every hedge
 * intact — it still sees one booking at a time, still never learns what the
 * correction rate is, still must write a rationale, and still cannot write to
 * `correctedFields` (a type error, and a Postgres permission error). Those are
 * properties of the port and the schema, not of the model behind them, which is
 * the entire argument for having had a port.
 *
 * One thing gets *worse* on this vendor, and it is worth being precise about.
 * `AnthropicTriager` disables extended thinking because thinking and a forced
 * `tool_choice` are mutually exclusive in the Messages API — a real constraint,
 * and the comment there says we would have paid the latency happily for a nightly
 * batch. Groq's reasoning models have no such exclusion, so a reasoning model here
 * is *available* for the first time. It is still not the default: `reasoningEffortFor`
 * turns qwen3's reasoning off and gpt-oss's down to `low`, because this is the one
 * call site whose output is a number we publish about ourselves, and the failure
 * mode of a model that reasons at length before answering is a model that
 * occasionally answers in prose. A label parsed out of a paragraph is a label that
 * silently mislabels whatever it fails to parse — and every parse failure here is
 * a `declined`, which counts against us. That is the *safe* direction, and it is
 * still not free: a triage pass that declines half its cases is a pass that waives
 * half our revenue (principle #7). Correctness first, but the enum is what makes
 * correctness checkable.
 */

/** "Correctness over latency", plan §4. Nothing here is in the audio path. */
export const GROQ_TRIAGE_MODEL = "llama-3.3-70b-versatile";

/** A label and a sentence of reasoning. */
const MAX_TOKENS = 512;

const CLASSIFY_STRUCTURED_TOOL: StructuredTool = {
  name: CLASSIFY_TOOL.name,
  description: CLASSIFY_TOOL.description,
  schema: CLASSIFY_TOOL.input_schema as unknown as Record<string, unknown>,
};

export interface GroqTriageUsage {
  readonly bookingId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface GroqTriagerOptions {
  readonly client: Groq;
  readonly model?: string;
  readonly mode?: StructuredMode;
  readonly onUsage?: (usage: GroqTriageUsage) => void;
}

export class GroqTriager implements CorrectionTriager {
  private readonly client: Groq;
  private readonly model: string;
  private readonly mode: StructuredMode;
  private readonly onUsage: (usage: GroqTriageUsage) => void;

  constructor(options: GroqTriagerOptions) {
    this.client = options.client;
    this.model = options.model ?? GROQ_TRIAGE_MODEL;
    this.mode = options.mode ?? modeFor(this.model);
    this.onUsage = options.onUsage ?? (() => {});
  }

  /** The outgoing request. Asserted on directly, exactly as the Anthropic one is. */
  request(triageCase: TriageCase) {
    return structuredRequest({
      model: this.model,
      mode: this.mode,
      system: SYSTEM_PROMPT,
      user: evidence(triageCase),
      tool: CLASSIFY_STRUCTURED_TOOL,
      maxTokens: MAX_TOKENS,
    });
  }

  async classify(triageCase: TriageCase): Promise<TriageVerdict> {
    let completion;
    try {
      completion = await this.client.chat.completions.create(this.request(triageCase));
    } catch (error) {
      return { kind: "unavailable", reason: degradeReasonOrThrow(error) };
    }

    this.onUsage({
      bookingId: triageCase.outcome.bookingId,
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
    });

    const structured = readStructured(completion, TOOL_NAME);

    // `unavailable`, not `declined`. Both leave the correction counting against
    // us, so the number is the same either way — but "the model could not answer"
    // and "the model looked and could not tell" are different bugs, and only one
    // of them is fixed by us.
    if (structured.kind === "malformed") {
      return { kind: "unavailable", reason: structured.reason };
    }

    return interpretClassification(structured.value);
  }
}
