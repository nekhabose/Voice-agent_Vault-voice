import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "groq-sdk/resources/chat/completions";

/**
 * How to make a Groq model return an object instead of a paragraph — and the
 * discovery that there is no single answer.
 *
 * Anthropic has one mechanism: a forced `tool_choice`, which every model honours.
 * Groq has two, and **they are mutually exclusive per model.** Measured, live,
 * across five models and three utterances:
 *
 * | model                      | forced `tools`          | `response_format: json_schema` |
 * |----------------------------|-------------------------|--------------------------------|
 * | `openai/gpt-oss-120b`      | 400 `tool_use_failed`   | correct                        |
 * | `llama-3.3-70b-versatile`  | correct                 | 400                            |
 * | `llama-3.1-8b-instant`     | correct (and fastest)   | 400                            |
 * | `qwen/qwen3-32b`           | correct                 | 400                            |
 *
 * Not "one is better". Each model supports exactly one and rejects the other with
 * a `400`. A binding that hard-codes either mechanism silently rules out half the
 * catalogue — including, in the `tools`-only direction, the model that turned out
 * to be the most accurate, and in the `json_schema`-only direction the one that
 * was twice as fast.
 *
 * So the mode is a property of the model, both modes are built from the **same**
 * strictified JSON Schema, and choosing between them is an A/B we can actually
 * run rather than a decision we had to make blind (plan, §11).
 */

export type StructuredMode = "tools" | "json_schema";

/**
 * `json_schema` for the gpt-oss family, forced `tools` for everything else.
 *
 * The default is `tools` rather than `json_schema` because `tools` is what the
 * long tail of open-weight models on Groq implements, and because a wrong guess
 * in that direction fails loudly on the first call — a `400`, in staging — rather
 * than degrading.
 */
export function modeFor(model: string): StructuredMode {
  return /^openai\/gpt-oss/.test(model) ? "json_schema" : "tools";
}

/**
 * The `thinking: {type: "disabled"}` of this vendor — and it does not go all the
 * way down.
 *
 * `packages/extraction` pins Anthropic's `thinking` off because Sonnet reasons
 * adaptively when the field is omitted, and an extractor that pays multi-second
 * thinking latency on every turn fails `checkBudgets()` with no visible cause.
 * The identical trap is here, with a sharper edge: **`openai/gpt-oss-120b` reasons
 * at `medium` by default**, and unlike Sonnet it has no "off" — the API accepts
 * only `low`, `medium`, or `high` for that family. So the best we can do is `low`,
 * and the p95-first-word budget (1.2s) is a real constraint on whether a reasoning
 * model belongs in the audio path at all. That is a finding for the A/B, not a
 * thing to paper over.
 *
 * qwen3 accepts `none` and takes it. Llama does not reason, and sending the field
 * to a model that has no opinion about it is noise on the wire.
 */
export function reasoningEffortFor(model: string): "none" | "low" | undefined {
  if (/^openai\/gpt-oss/.test(model)) return "low";
  if (/qwen3/.test(model)) return "none";
  return undefined;
}

/**
 * A schema the model must fill, named and described.
 *
 * The schema is expected to be **already strictified** — every property required,
 * `additionalProperties: false`, no semantic keywords — which is
 * `packages/extraction`'s `strictify()`, unchanged and reused. That function was
 * written for Anthropic's `strict` tool use and turns out to produce exactly the
 * subset Groq's structured outputs accept in *both* modes, because both are the
 * same OpenAI-derived subset. It is the one piece of this migration that was free.
 */
export interface StructuredTool {
  readonly name: string;
  readonly description: string;
  readonly schema: Record<string, unknown>;
}

export interface StructuredRequestOptions {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly tool: StructuredTool;
  readonly maxTokens: number;
  /** Defaults to {@link modeFor}. Set explicitly only to A/B a model against both. */
  readonly mode?: StructuredMode;
}

/**
 * One request, in whichever mode this model speaks.
 *
 * `temperature: 0` in both. This is transcription, not composition: the same
 * utterance must yield the same slot on Tuesday as it did on Monday, and a
 * reliability number computed over a sampling temperature is a number with a
 * random variable in it.
 */
export function structuredRequest(
  options: StructuredRequestOptions,
): ChatCompletionCreateParamsNonStreaming {
  const { model, system, user, tool, maxTokens } = options;
  const mode = options.mode ?? modeFor(model);
  const effort = reasoningEffortFor(model);

  const base = {
    model,
    max_completion_tokens: maxTokens,
    temperature: 0,
    messages: [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ],
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
  };

  if (mode === "json_schema") {
    return {
      ...base,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: tool.name,
          description: tool.description,
          schema: tool.schema,
          strict: true,
        },
      },
    };
  }

  return {
    ...base,
    tools: [
      {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.schema,
        },
      },
    ],
    tool_choice: { type: "function", function: { name: tool.name } },
    parallel_tool_calls: false,
  };
}

/**
 * What came back, or why nothing usable did.
 *
 * `malformed` is deliberately *not* "the caller said nothing". It is the same
 * position `packages/extraction` takes when a forced `tool_choice` somehow yields
 * no `tool_use` block: we could not ask the question, which is not the same as
 * having asked it and been told nothing. Each call site maps this to its own
 * `unavailable`.
 */
export type StructuredOutcome =
  | { readonly kind: "parsed"; readonly value: unknown }
  | { readonly kind: "malformed"; readonly reason: string };

/**
 * Read the object back out, from whichever mode produced it.
 *
 * In `tools` mode it arrives as a JSON *string* in
 * `message.tool_calls[0].function.arguments`; in `json_schema` mode as a JSON
 * string in `message.content`. Both are strings the model wrote, so both can be
 * unparseable, and neither is trusted past this point: every call site re-validates
 * the parsed value against its Zod contract, because a schema guarantees the shape
 * and never the meaning (principle #3).
 */
export function readStructured(
  completion: ChatCompletion,
  toolName: string,
): StructuredOutcome {
  const choice = completion.choices[0];
  if (!choice) return { kind: "malformed", reason: "no choices" };

  const call = choice.message.tool_calls?.find(
    (candidate) => candidate.function.name === toolName,
  );
  const raw = call ? call.function.arguments : choice.message.content;

  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      kind: "malformed",
      reason: `no ${toolName} output (finish_reason: ${choice.finish_reason})`,
    };
  }

  try {
    return { kind: "parsed", value: JSON.parse(raw) };
  } catch {
    return { kind: "malformed", reason: `unparseable ${toolName} output` };
  }
}
