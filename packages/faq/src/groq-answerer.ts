import {
  degradeReasonOrThrow,
  modeFor,
  readStructured,
  structuredRequest,
  type StructuredMode,
  type StructuredTool,
} from "@ledgerline/groq";
import type {
  FaqAnswerer,
  FaqContext,
  FaqOutcome,
  FaqEntry,
} from "@ledgerline/contracts";
import type Groq from "groq-sdk";
import {
  interpretSelection,
  promptFor,
  RETRIEVAL_LIMIT,
  SELECT_TOOL,
  SIMILARITY_FLOOR,
  SYSTEM_PROMPT,
  TOOL_NAME,
} from "./answerer.js";
import type { Embedder, FaqIndex, RetrievedFaqEntry } from "./types.js";

/**
 * Call site #3, second vendor.
 *
 * Everything that makes this call site safe is shared with `AnthropicFaqAnswerer`
 * and none of it is about the vendor: the retrieval floor, the *selection* tool
 * (an `entry_id`, never a sentence), the tenant scoping, and `interpretSelection`
 * — which turns an id we never sent into `unknown`, because a hallucinated id is
 * a sentence nobody wrote.
 *
 * The one Groq-shaped hazard is worth naming, because it lands hardest here. A
 * `tool_use_failed` means the model could not produce the object; on this call
 * site the tempting mapping is `unknown` ("we have no answer"), which is *almost*
 * right and quietly wrong — the caller is told a human will call them back, which
 * is honest, but the dashboard then cannot distinguish a question nobody wrote an
 * answer to from a model that cannot operate the tool. One is a content gap the
 * contractor fixes by writing an FAQ entry. The other is ours. So it degrades to
 * `unavailable`, like an outage, and the reason says which.
 */

export const GROQ_FAQ_MODEL = "llama-3.3-70b-versatile";

/** One selection needs an id and a number. */
const MAX_TOKENS = 128;

const SELECT_STRUCTURED_TOOL: StructuredTool = {
  name: SELECT_TOOL.name,
  description: SELECT_TOOL.description,
  schema: SELECT_TOOL.input_schema as unknown as Record<string, unknown>,
};

export interface GroqFaqAnswererOptions {
  readonly client: Groq;
  readonly index: FaqIndex;
  readonly embedder: Embedder;
  /** Whose FAQ. An answer that crosses tenants speaks one shop's prices to another's caller. */
  readonly tenantId: string;
  readonly model?: string;
  readonly mode?: StructuredMode;
}

export class GroqFaqAnswerer implements FaqAnswerer {
  private readonly client: Groq;
  private readonly index: FaqIndex;
  private readonly embedder: Embedder;
  private readonly tenantId: string;
  private readonly model: string;
  private readonly mode: StructuredMode;

  constructor(options: GroqFaqAnswererOptions) {
    this.client = options.client;
    this.index = options.index;
    this.embedder = options.embedder;
    this.tenantId = options.tenantId;
    this.model = options.model ?? GROQ_FAQ_MODEL;
    this.mode = options.mode ?? modeFor(this.model);
  }

  request(question: string, candidates: readonly FaqEntry[]) {
    return structuredRequest({
      model: this.model,
      mode: this.mode,
      system: SYSTEM_PROMPT,
      user: promptFor(question, candidates),
      tool: SELECT_STRUCTURED_TOOL,
      maxTokens: MAX_TOKENS,
    });
  }

  async answer(question: string, _ctx: FaqContext): Promise<FaqOutcome> {
    let retrieved: readonly RetrievedFaqEntry[];
    try {
      const embedding = await this.embedder.embed(question);
      retrieved = await this.index.search(this.tenantId, embedding, RETRIEVAL_LIMIT);
    } catch (error) {
      // Retrieval is infrastructure. Its being down is not the caller having
      // asked an unanswerable question, and the dashboard must be able to tell
      // the two apart or we will "fix" the wrong thing.
      return {
        kind: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    const candidates = retrieved
      .filter((hit) => hit.score >= SIMILARITY_FLOOR)
      .map((hit) => hit.entry);

    // Nothing close enough is a *cheap* null: no model call, no latency, and no
    // chance of the model picking the least-bad of five irrelevant answers.
    if (candidates.length === 0) return { kind: "unknown" };

    let completion;
    try {
      completion = await this.client.chat.completions.create(
        this.request(question, candidates),
      );
    } catch (error) {
      return { kind: "unavailable", reason: degradeReasonOrThrow(error) };
    }

    const structured = readStructured(completion, TOOL_NAME);
    if (structured.kind === "malformed") {
      return { kind: "unavailable", reason: structured.reason };
    }

    return interpretSelection(structured.value, candidates);
  }
}
