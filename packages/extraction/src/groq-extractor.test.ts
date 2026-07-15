import {
  RecordingTransport,
  jsonBody,
  modelFailureReply,
  replay,
  testClient,
  toolCallBody,
} from "@ledgerline/groq";
import type { ExtractionContext } from "@ledgerline/contracts";
import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "./extractor.js";
import { GroqExtractor, structuredToolFor } from "./groq-extractor.js";
import { toolNameFor } from "./tool.js";

const EVAL_NOW = "2026-07-08T12:00:00.000Z";

/**
 * The Groq binding, proven offline — the same discipline as `extraction.test.ts`,
 * driven through the real SDK, the real tool schema derived from the contract,
 * and the real Zod re-validation. Zero live model calls.
 *
 * The response bodies are **transcribed from real Groq responses** measured while
 * building this package, which makes them a strict upgrade on the Anthropic
 * fixtures beside them (hand-authored, never checked against the wire). The
 * `tool_use_failed` body in particular is the real one: it is what
 * `openai/gpt-oss-120b` actually did when handed our address tool.
 */

const CTX: ExtractionContext = { callId: "call-1", turnIndex: 3, now: EVAL_NOW, timeZone: "America/New_York" };

const LLAMA = "llama-3.3-70b-versatile";
const GPT_OSS = "openai/gpt-oss-120b";

const ADDRESS = {
  line1: "1247 Calle Ocho",
  city: "Miami",
  state: "FL",
  postalCode: "33135",
};

const extractorFor = (handler: RecordingTransport, model = LLAMA) =>
  new GroqExtractor({ client: testClient(handler), model });

describe("the tool is the contract's, unchanged", () => {
  // The load-bearing reuse: `toolFor()` and `strictify()` are Anthropic-era code,
  // and they emit exactly the subset Groq accepts in both modes. A slot added to
  // `SLOT_SPECS` widens both vendors at build time; neither can drift.
  it("derives the schema from SLOT_SPECS, not from a hand-written copy", () => {
    const tool = structuredToolFor("service_address");

    expect(tool.name).toBe("record_service_address");
    expect(tool.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["value", "confidence"],
    });

    // The geocoder's output is not in the model's output space (principle #3).
    const value = (tool.schema as { properties: Record<string, unknown> }).properties[
      "value"
    ];
    expect(JSON.stringify(value)).not.toContain("formatted");
    expect(JSON.stringify(value)).not.toContain("lat");
  });
});

describe("two mechanisms, one binding", () => {
  it("forces the tool for llama, and fills the slot", async () => {
    const transport = new RecordingTransport(
      replay(
        toolCallBody(toolNameFor("service_address"), {
          value: ADDRESS,
          confidence: 0.93,
        }),
      ),
    );

    const outcome = await extractorFor(transport).extract(
      "service_address",
      "1247 Calle Ocho, Miami Florida, 33135",
      CTX,
    );

    expect(outcome).toEqual({ kind: "filled", raw: ADDRESS, confidence: 0.93 });
    expect(transport.only.tool_choice).toEqual({
      type: "function",
      function: { name: "record_service_address" },
    });
    expect(transport.only.response_format).toBeUndefined();
    expect(transport.only.messages[0]).toEqual({
      role: "system",
      content: SYSTEM_PROMPT,
    });
  });

  // Same slot, same schema, same outcome — a different wire mechanism, because
  // gpt-oss rejects forced tools with a 400 and this is the only way to reach it.
  it("uses json_schema for gpt-oss, and fills the same slot", async () => {
    const transport = new RecordingTransport(
      replay(jsonBody({ value: ADDRESS, confidence: 0.93 })),
    );

    const outcome = await extractorFor(transport, GPT_OSS).extract(
      "service_address",
      "1247 Calle Ocho, Miami Florida, 33135",
      CTX,
    );

    expect(outcome).toEqual({ kind: "filled", raw: ADDRESS, confidence: 0.93 });
    expect(transport.only.tools).toBeUndefined();
    expect(transport.only.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "record_service_address", strict: true },
    });
  });

  // The `thinking: {type:"disabled"}` discipline. gpt-oss reasons at `medium` by
  // default and cannot be turned off — `low` is the floor, and whether that fits
  // a 1.2s p95 first-word budget is the A/B, not an assumption.
  it("turns gpt-oss's reasoning down, and sends nothing to a model that does not reason", async () => {
    const oss = new RecordingTransport(replay(jsonBody({ value: null, confidence: 0 })));
    await extractorFor(oss, GPT_OSS).extract("caller_name", "hi", CTX);
    expect(oss.only.reasoning_effort).toBe("low");

    const llama = new RecordingTransport(
      replay(toolCallBody(toolNameFor("caller_name"), { value: null, confidence: 0 })),
    );
    await extractorFor(llama).extract("caller_name", "hi", CTX);
    expect(llama.only.reasoning_effort).toBeUndefined();
  });

  it("pins temperature to 0 — a reliability number must not have a random variable in it", async () => {
    const transport = new RecordingTransport(
      replay(toolCallBody(toolNameFor("caller_name"), { value: "Rosa", confidence: 0.9 })),
    );
    await extractorFor(transport).extract("caller_name", "Rosa", CTX);
    expect(transport.only.temperature).toBe(0);
  });
});

describe("null is the only way to decline", () => {
  it("reports absent when the utterance does not state the slot", async () => {
    const transport = new RecordingTransport(
      replay(toolCallBody(toolNameFor("caller_name"), { value: null, confidence: 0 })),
    );

    const outcome = await extractorFor(transport).extract(
      "caller_name",
      "um, hang on",
      CTX,
    );
    expect(outcome).toEqual({ kind: "absent" });
  });

  // `strict` guarantees the shape and never the meaning. A ZIP of ABCDE satisfies
  // `{type: "string"}` and must not reach the geocoder.
  it("re-validates the model's output against the contract, not just the schema", async () => {
    const transport = new RecordingTransport(
      replay(
        toolCallBody(toolNameFor("service_address"), {
          value: { ...ADDRESS, postalCode: "ABCDE" },
          confidence: 0.99,
        }),
      ),
    );

    const outcome = await extractorFor(transport).extract(
      "service_address",
      "1247 Calle Ocho",
      CTX,
    );
    expect(outcome).toEqual({ kind: "absent" });
  });

  it("clamps a confidence the model made up", async () => {
    const transport = new RecordingTransport(
      replay(toolCallBody(toolNameFor("caller_name"), { value: "Rosa", confidence: 7 })),
    );

    const outcome = await extractorFor(transport).extract("caller_name", "Rosa", CTX);
    expect(outcome).toEqual({ kind: "filled", raw: "Rosa", confidence: 1 });
  });
});

describe("the taxonomy, at the call site", () => {
  it("degrades an outage to unavailable, never to absent", async () => {
    const transport = new RecordingTransport(() => ({
      status: 429,
      json: { error: { message: "rate limited" } },
    }));

    const outcome = await extractorFor(transport).extract("caller_name", "Rosa", CTX);
    expect(outcome.kind).toBe("unavailable");
    expect(outcome).toMatchObject({ reason: expect.stringMatching(/^outage: /) });
  });

  /**
   * The finding this whole package was built around.
   *
   * `openai/gpt-oss-120b`, handed `record_service_address` and "1247 Calle Ocho,
   * Miami FL 33135", returned `{"value": {"address": "1247 Calle Ocho, Miami
   * Florida, 33135"}}` — it flattened four fields into one — and Groq turned that
   * into a `400 tool_use_failed`. That is VoiceAgentBench's 60.6% parameter-fill
   * number arriving on turn one, live.
   *
   * Anthropic's rule (a 400 is our bug, and throws) would hang up on the caller.
   * `absent` would blame them for our failure and hide it from the published
   * number. So: `unavailable`, which retries once and then reaches a human.
   */
  it("does not throw when the MODEL could not fill the schema — that would drop the call", async () => {
    const transport = new RecordingTransport(() => modelFailureReply("tool_use_failed"));

    const outcome = await extractorFor(transport, GPT_OSS).extract(
      "service_address",
      "1247 Calle Ocho, Miami FL 33135",
      CTX,
    );

    expect(outcome.kind).toBe("unavailable");
  });

  it("does not call it absent either — that would blame the caller and flatter the number", async () => {
    const transport = new RecordingTransport(() => modelFailureReply("tool_use_failed"));

    const outcome = await extractorFor(transport, GPT_OSS).extract(
      "service_address",
      "1247 Calle Ocho, Miami FL 33135",
      CTX,
    );

    expect(outcome.kind).not.toBe("absent");
    // And the reason distinguishes it from an outage: one is somebody else's
    // incident, the other is fixed by choosing a different model.
    expect(outcome).toMatchObject({
      reason: expect.stringMatching(/^model_failure: tool_use_failed: /),
    });
  });

  it("still throws a 401 — a keyless build must crash in staging, not degrade", async () => {
    const transport = new RecordingTransport(() => ({
      status: 401,
      json: { error: { message: "invalid api key" } },
    }));

    await expect(
      extractorFor(transport).extract("caller_name", "Rosa", CTX),
    ).rejects.toThrow();
  });

  it("still throws an unrecognised 400 — a schema we broke must not look like a bad day", async () => {
    const transport = new RecordingTransport(() => ({
      status: 400,
      json: { error: { message: "unknown parameter", code: "invalid_parameter" } },
    }));

    await expect(
      extractorFor(transport).extract("caller_name", "Rosa", CTX),
    ).rejects.toThrow();
  });

  it("is unavailable, not absent, when the model produced nothing usable", async () => {
    const transport = new RecordingTransport(
      replay({
        id: "c",
        object: "chat.completion",
        created: 1,
        model: LLAMA,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null },
            finish_reason: "length",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );

    const outcome = await extractorFor(transport).extract("caller_name", "Rosa", CTX);
    expect(outcome.kind).toBe("unavailable");
  });
});

describe("usage", () => {
  it("reports tokens, and has no cache-hit rate to report", async () => {
    const seen: unknown[] = [];
    const transport = new RecordingTransport(
      replay(toolCallBody(toolNameFor("caller_name"), { value: "Rosa", confidence: 0.9 })),
    );

    const extractor = new GroqExtractor({
      client: testClient(transport),
      model: LLAMA,
      onUsage: (usage) => seen.push(usage),
    });
    await extractor.extract("caller_name", "Rosa", CTX);

    // Groq has no `cache_control` breakpoint API. There is no prefix to pin, no
    // `prewarm()`, and no cache-hit rate — so the cost model §10.5 derived from
    // Anthropic's caching does not survive the move, and must be re-derived.
    expect(seen).toEqual([
      { slot: "caller_name", inputTokens: 420, outputTokens: 24 },
    ]);
    expect(seen[0]).not.toHaveProperty("cacheReadInputTokens");
  });
});
