import Anthropic from "@anthropic-ai/sdk";
import type {
  ExtractionContext,
  ExtractionOutcome,
  SlotExtractor,
  SlotKey,
} from "@ledgerline/contracts";
import { SLOT_KEYS, SLOT_SPECS } from "@ledgerline/contracts";
import { stripNulls, toolFor, toolNameFor } from "./tool.js";

/**
 * The slot extractor (plan, §10.1).
 *
 * One tool, one field, one turn. The model's entire decision space is "what is
 * the value of this one field, or nothing" — principle #1 enforced by the tool
 * schema rather than by a prompt.
 */

export const EXTRACTION_MODEL = "claude-sonnet-5";

/**
 * Sonnet 5 runs adaptive thinking when `thinking` is omitted. An extractor that
 * omits the field silently pays multi-second thinking latency on every turn,
 * and `checkBudgets()` fails with no obvious cause. Pinned, and asserted on the
 * outgoing request body in `extraction.test.ts`.
 */
const THINKING: Anthropic.ThinkingConfigDisabled = { type: "disabled" };

/** One tool call of `{value, confidence}` does not need more than this. */
const MAX_TOKENS = 256;

/**
 * Frozen. Nothing per-call, per-caller, or per-clock may appear in here: `tools`
 * and `system` render before `messages`, so a single interpolated byte here
 * invalidates the prompt cache for every turn of every call.
 */
export const SYSTEM_PROMPT = [
  "You transcribe one field from one utterance for a US home-services call.",
  "",
  "You are given a single thing the caller just said. Record only what they",
  "actually said. Do not infer, complete, correct, or normalise it: no guessing",
  "a surname from a first name, no filling in a ZIP code you were not given, no",
  "resolving a street to the one you think they meant. If the utterance does not",
  "state the field, or states it in a way that admits more than one reading, the",
  "value is null. A null costs one extra question. A guess costs a truck at the",
  "wrong house.",
  "",
  "Report confidence as your probability that the value is exactly what the",
  "caller said, not your probability that it is a plausible value.",
].join("\n");

export interface ExtractionUsage {
  readonly slot: SlotKey;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

export interface AnthropicExtractorOptions {
  readonly client: Anthropic;
  readonly model?: string;
  /**
   * Called for every request that reached the API. `cacheReadInputTokens`
   * belongs on a dashboard from day one: when caching breaks it breaks
   * silently, and the only symptom is cost.
   */
  readonly onUsage?: (usage: ExtractionUsage) => void;
}

export class AnthropicExtractor implements SlotExtractor {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly onUsage: (usage: ExtractionUsage) => void;

  constructor(options: AnthropicExtractorOptions) {
    this.client = options.client;
    this.model = options.model ?? EXTRACTION_MODEL;
    this.onUsage = options.onUsage ?? (() => {});
  }

  /**
   * Build the outgoing request. Exported behaviour, not an implementation
   * detail: the test suite asserts on what this produces, because the two ways
   * this class fails in production — adaptive thinking left on, and a cache
   * prefix that differs between turns — are both invisible in the response.
   */
  request(
    key: SlotKey,
    utterance: string,
  ): Anthropic.MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      max_tokens: MAX_TOKENS,
      thinking: THINKING,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [toolFor(key)],
      tool_choice: {
        type: "tool",
        name: toolNameFor(key),
        disable_parallel_tool_use: true,
      },
      messages: [{ role: "user", content: utterance }],
    };
  }

  async extract(
    key: SlotKey,
    utterance: string,
    _ctx: ExtractionContext,
  ): Promise<ExtractionOutcome> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(this.request(key, utterance));
    } catch (error) {
      return outageOrThrow(error);
    }

    this.onUsage({
      slot: key,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
    });

    return interpret(key, message);
  }

  /**
   * Warm all six cache prefixes at worker boot.
   *
   * `tools` render first, so one tool per slot means six prefixes, not one.
   * `max_tokens: 0` is rejected alongside a forced `tool_choice`, so pre-warm
   * carries the tools and system prompt without one; changing `tool_choice`
   * invalidates only the messages tier, and the tools + system cache survives.
   */
  async prewarm(keys: readonly SlotKey[] = SLOT_KEYS): Promise<void> {
    for (const key of keys) {
      const { tool_choice: _dropped, ...rest } = this.request(key, "warmup");
      try {
        const message = await this.client.messages.create({
          ...rest,
          max_tokens: 0,
        });
        this.onUsage({
          slot: key,
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheCreationInputTokens:
            message.usage.cache_creation_input_tokens ?? 0,
          cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
        });
      } catch (error) {
        // A cold cache is a cost and latency problem, not a correctness one.
        // Never let boot-time warming take the phone line down.
        if (!isOutage(error)) throw error;
      }
    }
  }
}

/**
 * `strict` guarantees the model returned the shape we asked for. It guarantees
 * nothing about whether the value means anything, so the contract gets the last
 * word — a ZIP of `ABCDE` passes `{type: "string"}` and fails
 * `AddressInputSchema`, and it must not reach the geocoder.
 */
function interpret(key: SlotKey, message: Anthropic.Message): ExtractionOutcome {
  const block = message.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === "tool_use" && b.name === toolNameFor(key),
  );

  // A forced `tool_choice` makes this unreachable unless the model refused or
  // hit `max_tokens`. Neither is the caller's fault, so neither is `absent`:
  // treating a refusal as "they said nothing" would burn a retry and then
  // escalate a caller who was perfectly clear.
  if (!block) {
    return {
      kind: "unavailable",
      reason: `no ${toolNameFor(key)} call (stop_reason: ${message.stop_reason})`,
    };
  }

  const input = block.input;
  if (typeof input !== "object" || input === null) return { kind: "absent" };

  const { value, confidence } = input as { value?: unknown; confidence?: unknown };
  if (value === null || value === undefined) return { kind: "absent" };

  const parsed = SLOT_SPECS[key].extraction.safeParse(stripNulls(value));
  if (!parsed.success) return { kind: "absent" };

  return {
    kind: "filled",
    raw: parsed.data,
    confidence: clampConfidence(confidence),
  };
}

/**
 * `strict` mode strips the `0..1` bound off the schema (it is a numerical
 * constraint), so the bound is ours to hold. An out-of-range confidence is the
 * model being sloppy, not the caller being unclear.
 */
function clampConfidence(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.min(1, Math.max(0, raw));
}

/**
 * Which failures are outages, and which are our bugs.
 *
 * A 400 means we built a bad request, a 401 means we shipped without a key —
 * both are defects that should crash loudly in staging rather than degrade into
 * a caller being asked their name four times.
 */
function isOutage(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.RateLimitError) return true;
  if (error instanceof Anthropic.InternalServerError) return true;
  return false;
}

function outageOrThrow(error: unknown): ExtractionOutcome {
  if (!isOutage(error)) throw error;
  const reason = error instanceof Error ? error.message : String(error);
  return { kind: "unavailable", reason };
}
