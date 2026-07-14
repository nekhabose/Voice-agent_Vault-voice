import {
  degradeReasonOrThrow,
  modeFor,
  readStructured,
  structuredRequest,
  type StructuredMode,
  type StructuredTool,
} from "@ledgerline/groq";
import type {
  ExtractionContext,
  ExtractionOutcome,
  SlotExtractor,
  SlotKey,
} from "@ledgerline/contracts";
import type Groq from "groq-sdk";
import type { ChatCompletionCreateParamsNonStreaming } from "groq-sdk/resources/chat/completions";
import { interpretSlotInput, SYSTEM_PROMPT, userMessage } from "./extractor.js";
import { toolFor, toolNameFor } from "./tool.js";

/**
 * The slot extractor, second vendor.
 *
 * This class is the bill for four Steps of port discipline, and it comes to about
 * eighty lines. It shares with `AnthropicExtractor` every single thing that is
 * *ours*: the system prompt, the tool schema derived from
 * `SLOT_SPECS[key].extraction`, the `null`-means-absent contract, and
 * `interpretSlotInput` — the Zod re-validation that keeps a ZIP of `ABCDE` away
 * from the geocoder. What it does not share is anything about the wire, because
 * nothing about the wire was ever allowed upstairs. `CallRuntime` binds a
 * `SlotExtractor`; it cannot tell which one it has.
 *
 * Two things genuinely differ, and both live in `@ledgerline/groq` rather than
 * here:
 *
 * - **How you force an object out of the model.** Groq's models each support
 *   exactly one of forced `tools` and `response_format: json_schema`, and reject
 *   the other with a `400`. `structuredRequest` builds either from the same
 *   strictified schema.
 * - **What a `400` means.** On Anthropic it is always our bug and always throws.
 *   Here it can be `tool_use_failed` — the *model* could not fill the schema —
 *   which must not throw (it would hang up on the caller) and must not be `absent`
 *   (it would blame the caller and hide our failure from the published number).
 *   It degrades to `unavailable`, like an outage, with a reason that says which.
 */

/** Groq serves no Anthropic model; this is a different default, not a rename. */
export const GROQ_EXTRACTION_MODEL = "llama-3.3-70b-versatile";

/** One tool call of `{value, confidence}` does not need more than this. */
const MAX_TOKENS = 256;

export interface GroqExtractorOptions {
  readonly client: Groq;
  readonly model?: string;
  /**
   * Forced only to A/B one model against both mechanisms (plan, §11). Left alone,
   * the mode follows the model, which is the only thing that works.
   */
  readonly mode?: StructuredMode;
  readonly onUsage?: (usage: GroqExtractionUsage) => void;
}

/**
 * No `cacheReadInputTokens`, and its absence is the finding.
 *
 * `AnthropicExtractor` reports it because the prompt cache is the cost model, and
 * caching breaks *silently* — the only symptom is the bill. **Groq has no
 * `cache_control` breakpoint API**, so there is no prefix to pin, nothing to
 * pre-warm, and no cache-hit rate to put on a dashboard. `prewarm()` is therefore
 * absent from this class rather than stubbed: a no-op method named `prewarm` is a
 * promise that the next person will believe.
 */
export interface GroqExtractionUsage {
  readonly slot: SlotKey;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export class GroqExtractor implements SlotExtractor {
  private readonly client: Groq;
  private readonly model: string;
  private readonly mode: StructuredMode;
  private readonly onUsage: (usage: GroqExtractionUsage) => void;

  constructor(options: GroqExtractorOptions) {
    this.client = options.client;
    this.model = options.model ?? GROQ_EXTRACTION_MODEL;
    this.mode = options.mode ?? modeFor(this.model);
    this.onUsage = options.onUsage ?? (() => {});
  }

  /** The outgoing request. Asserted on directly, exactly as the Anthropic one is. */
  request(
    key: SlotKey,
    utterance: string,
    ctx: ExtractionContext,
  ): ChatCompletionCreateParamsNonStreaming {
    return structuredRequest({
      model: this.model,
      mode: this.mode,
      system: SYSTEM_PROMPT,
      // The reference instant reaches the model here, in `messages`, and shares
      // `userMessage` with the Anthropic binding — because "what time is it" is
      // not a vendor's business, and two copies would resolve "tomorrow" in two
      // different time zones.
      user: userMessage(utterance, ctx),
      tool: structuredToolFor(key),
      maxTokens: MAX_TOKENS,
    });
  }

  async extract(
    key: SlotKey,
    utterance: string,
    ctx: ExtractionContext,
  ): Promise<ExtractionOutcome> {
    let completion;
    try {
      completion = await this.client.chat.completions.create(
        this.request(key, utterance, ctx),
      );
    } catch (error) {
      // Outage, or a model that could not fill the schema. Both `unavailable`,
      // and the reason string says which. Anything else is our bug and throws.
      return { kind: "unavailable", reason: degradeReasonOrThrow(error) };
    }

    this.onUsage({
      slot: key,
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
    });

    const structured = readStructured(completion, toolNameFor(key));

    // "The model produced nothing usable" is not "the caller said nothing".
    // Same position `AnthropicExtractor` takes on a missing `tool_use` block.
    if (structured.kind === "malformed") {
      return { kind: "unavailable", reason: structured.reason };
    }

    return interpretSlotInput(key, structured.value);
  }
}

/**
 * The contract's tool, in the shape `@ledgerline/groq` takes.
 *
 * `toolFor(key)` is reused **unchanged**, which is the load-bearing detail: the
 * model's output space is still `SLOT_SPECS[key].extraction` run through
 * `strictify()`, so a slot added to the contract widens both vendors at build
 * time and neither can drift from the other. `strictify()` was written for
 * Anthropic's `strict` tool use and happens to emit exactly the subset Groq
 * accepts in both of its modes, because both are the same OpenAI-derived subset.
 * That is the one part of this migration that cost nothing.
 */
export function structuredToolFor(key: SlotKey): StructuredTool {
  const tool = toolFor(key);
  return {
    name: tool.name,
    description: tool.description,
    schema: tool.input_schema as unknown as Record<string, unknown>,
  };
}
