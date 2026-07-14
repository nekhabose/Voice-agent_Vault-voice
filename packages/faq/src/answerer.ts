import Anthropic from "@anthropic-ai/sdk";
import { outageReasonOrThrow } from "@ledgerline/anthropic";
import type {
  FaqAnswerer,
  FaqContext,
  FaqEntry,
  FaqOutcome,
} from "@ledgerline/contracts";
import type { Embedder, FaqIndex, RetrievedFaqEntry } from "./types.js";

/**
 * Call site #3 (plan, §6): the caller asked a question, and the answer is not a
 * slot.
 *
 * The model's entire decision space here is **which of these committed answers
 * responds to the question, or none of them.** It does not write the answer, it
 * does not summarise the answer, and it does not "helpfully" combine two of
 * them. That is the same narrowing as principle #1 applied to a different call
 * site: a model that composes an answer from retrieved context is a model
 * quoting a price on a recorded line that the contractor never approved, and
 * "the retrieval was correct, the phrasing drifted" is not a defence anybody
 * will accept when they are held to it.
 *
 * So: retrieve, select, speak the contractor's own words.
 */

export const FAQ_MODEL = "claude-sonnet-5";

/** One selection needs an id and a number. */
const MAX_TOKENS = 128;

/** Adaptive thinking here is seconds of latency behind a filler. See §10.1. */
const THINKING: Anthropic.ThinkingConfigDisabled = { type: "disabled" };

/** How many entries the model chooses between. */
export const RETRIEVAL_LIMIT = 5;

/**
 * Below this cosine similarity, nothing is worth showing the model.
 *
 * **This number is calibrated against `HashingEmbedder`, which is not the
 * production embedder** — it has no semantics, so it is a floor on token
 * overlap, not on meaning. Re-tune it the day a real embedder is bound (Step 7),
 * and say so out loud rather than inheriting a magic constant whose provenance
 * nobody remembers. It is deliberately generous: the model still has to select,
 * and a null selection costs one honest "someone will call you back".
 */
export const SIMILARITY_FLOOR = 0.15;

export const TOOL_NAME = "select_faq_answer";

/**
 * Frozen. The candidate entries are **not** in here, and must never be: `tools`
 * and `system` render before `messages`, so per-call retrieval results in the
 * prefix would invalidate the prompt cache on every question ever asked (plan,
 * §10.1, and the convention every model binding in this repo follows).
 */
export const SYSTEM_PROMPT = [
  "A caller has asked a question of a US home-services contractor's phone agent.",
  "You are given the question and a numbered list of answers the contractor has",
  "already written and approved.",
  "",
  "Choose the one answer that actually responds to the question, and return its",
  "id. You are selecting, not writing: the caller will hear the contractor's",
  "answer word for word, and you have no way to add to it or qualify it.",
  "",
  "If none of the answers responds to the question — or if the closest one is",
  "about a related but different thing — return null. A null means the caller is",
  "told a person will call them back, which is honest. A near-miss means the",
  "agent confidently states a price, a policy, or a guarantee that does not apply",
  "to what they asked, on a recorded line, and the contractor is held to it.",
].join("\n");

/** Frozen alongside the system prompt: no entry ids, no per-call bytes. */
export const SELECT_TOOL = {
  name: TOOL_NAME,
  description:
    "Record which of the contractor's committed answers responds to the caller's question, or null if none of them does.",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      entry_id: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description:
          "The id of the one answer that responds to the question, or null if none does.",
      },
      confidence: {
        type: "number",
        description:
          "How confident you are, from 0 to 1, that this answer responds to what the caller actually asked.",
      },
    },
    required: ["entry_id", "confidence"],
    additionalProperties: false as const,
  },
};

export interface AnthropicFaqAnswererOptions {
  readonly client: Anthropic;
  readonly index: FaqIndex;
  readonly embedder: Embedder;
  /** Whose FAQ. An answer that crosses tenants speaks one shop's prices to another's caller. */
  readonly tenantId: string;
  readonly model?: string;
}

export class AnthropicFaqAnswerer implements FaqAnswerer {
  private readonly client: Anthropic;
  private readonly index: FaqIndex;
  private readonly embedder: Embedder;
  private readonly tenantId: string;
  private readonly model: string;

  constructor(options: AnthropicFaqAnswererOptions) {
    this.client = options.client;
    this.index = options.index;
    this.embedder = options.embedder;
    this.tenantId = options.tenantId;
    this.model = options.model ?? FAQ_MODEL;
  }

  /**
   * The outgoing request, exposed for the same reason `AnthropicExtractor.request`
   * is: the two ways this fails in production — a per-call byte in the cached
   * prefix, and adaptive thinking left on — are invisible in the response.
   */
  request(
    question: string,
    candidates: readonly FaqEntry[],
  ): Anthropic.MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      max_tokens: MAX_TOKENS,
      thinking: THINKING,
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      tools: [SELECT_TOOL],
      tool_choice: {
        type: "tool",
        name: TOOL_NAME,
        disable_parallel_tool_use: true,
      },
      messages: [{ role: "user", content: promptFor(question, candidates) }],
    };
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
      return { kind: "unavailable", reason: reasonOf(error) };
    }

    const candidates = retrieved
      .filter((hit) => hit.score >= SIMILARITY_FLOOR)
      .map((hit) => hit.entry);

    // Nothing close enough is a *cheap* null: no model call, no latency, and no
    // chance of the model picking the least-bad of five irrelevant answers.
    if (candidates.length === 0) return { kind: "unknown" };

    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(this.request(question, candidates));
    } catch (error) {
      return { kind: "unavailable", reason: outageReasonOrThrow(error) };
    }

    return interpret(message, candidates);
  }
}

/**
 * The candidates, in `messages`, where per-call data belongs.
 *
 * Ids are handed to the model verbatim so the selection round-trips exactly; the
 * answer text is included because "which of these responds to the question" is
 * unanswerable from the questions alone — two entries can share a question and
 * differ in whether they cover after-hours.
 */
export function promptFor(question: string, candidates: readonly FaqEntry[]): string {
  const lines = candidates.map(
    (entry) => `id: ${entry.id}\nquestion: ${entry.question}\nanswer: ${entry.answer}`,
  );
  return [`Caller asked: ${question}`, "", "Committed answers:", "", lines.join("\n\n")].join(
    "\n",
  );
}

/**
 * `strict` guarantees the shape; it does not guarantee the id exists.
 *
 * An id we never sent is the model inventing an answer to speak, which is the one
 * thing this call site is built to prevent — so it is `unknown`, and the caller
 * hears that a person will call back. Same discipline as re-validating the
 * extractor's output against the Zod contract on the way in.
 */
function interpret(
  message: Anthropic.Message,
  candidates: readonly FaqEntry[],
): FaqOutcome {
  const block = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === TOOL_NAME,
  );

  // A forced `tool_choice` makes this unreachable unless the model refused or hit
  // `max_tokens`. Neither means "we have no answer" — it means we could not ask.
  if (!block) {
    return {
      kind: "unavailable",
      reason: `no ${TOOL_NAME} call (stop_reason: ${message.stop_reason})`,
    };
  }

  return interpretSelection(block.input, candidates);
}

/**
 * The `{entry_id}` the model chose, turned into an outcome — vendor-independent,
 * and **shared with `GroqFaqAnswerer`**.
 *
 * The rule it enforces is the whole reason this call site exists: an id we never
 * sent is `unknown`. A model that returns an entry id nobody wrote is a model
 * *writing an answer*, which is the one thing a retrieval-and-select design is
 * built to make impossible — and a second copy of this check behind a second
 * vendor is a second chance to lose it.
 */
export function interpretSelection(
  input: unknown,
  candidates: readonly FaqEntry[],
): FaqOutcome {
  if (typeof input !== "object" || input === null) return { kind: "unknown" };

  const { entry_id: entryId } = input as { entry_id?: unknown };
  if (typeof entryId !== "string") return { kind: "unknown" };

  const chosen = candidates.find((entry) => entry.id === entryId);
  if (!chosen) return { kind: "unknown" };

  return { kind: "answered", answer: chosen.answer, entryId: chosen.id };
}

/** An embedder or index failure is an outage; there is no "our bug" case to raise. */
const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
