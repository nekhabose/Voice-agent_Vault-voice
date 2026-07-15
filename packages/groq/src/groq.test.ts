import { describe, expect, it } from "vitest";
import { GROQ_HOST, groqClient, normalizeBaseUrl } from "./client.js";
import {
  degradeReasonOrThrow,
  isModelFailure,
  isOutage,
  modelFailureCode,
} from "./errors.js";
import {
  modeFor,
  readStructured,
  reasoningEffortFor,
  structuredRequest,
  type StructuredTool,
} from "./structured.js";
import {
  RecordingTransport,
  jsonBody,
  modelFailureReply,
  replay,
  testClient,
  toolCallBody,
} from "./testing.js";

const TOOL: StructuredTool = {
  name: "record_service_address",
  description: "Record the caller's service address.",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { value: { type: "string" }, confidence: { type: "number" } },
    required: ["value", "confidence"],
  },
};

/** Provoke a real SDK error by answering one request with `reply`. */
async function errorFrom(reply: ReturnType<typeof modelFailureReply>): Promise<unknown> {
  const transport = new RecordingTransport(() => reply);
  try {
    await testClient(transport).chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "hi" }],
    });
  } catch (error) {
    return error;
  }
  throw new Error("expected the SDK to throw");
}

describe("the base URL trap", () => {
  // The SDK appends `/openai/v1/chat/completions` itself, and the base URL in
  // Groq's own docs already ends in `/openai/v1`. Paste that and every call 404s.
  it("strips the OpenAI-compat path the SDK is about to append", () => {
    expect(normalizeBaseUrl("https://api.groq.com/openai/v1")).toBe(GROQ_HOST);
    expect(normalizeBaseUrl("https://api.groq.com/openai/v1/")).toBe(GROQ_HOST);
  });

  it("is idempotent, so either documented form works", () => {
    expect(normalizeBaseUrl("https://api.groq.com")).toBe(GROQ_HOST);
    expect(normalizeBaseUrl(normalizeBaseUrl("https://api.groq.com/openai/v1"))).toBe(
      GROQ_HOST,
    );
  });

  it("falls back to the host when nothing is configured", () => {
    expect(normalizeBaseUrl(undefined)).toBe(GROQ_HOST);
    expect(normalizeBaseUrl("  ")).toBe(GROQ_HOST);
    expect(normalizeBaseUrl("/openai/v1")).toBe(GROQ_HOST);
  });

  it("honours a genuine override, like a proxy", () => {
    expect(normalizeBaseUrl("https://proxy.internal/groq")).toBe(
      "https://proxy.internal/groq",
    );
  });

  // The SDK reads GROQ_BASE_URL from the environment on its own when you do not
  // pass one, so a `.env` written the documented way would poison a client that
  // never mentioned a base URL. The factory always passes an explicit value.
  it("normalises even when the value came from the environment", () => {
    const before = process.env["GROQ_BASE_URL"];
    process.env["GROQ_BASE_URL"] = "https://api.groq.com/openai/v1";
    try {
      expect(groqClient({ apiKey: "gsk-test" }).baseURL).toBe(GROQ_HOST);
    } finally {
      if (before === undefined) delete process.env["GROQ_BASE_URL"];
      else process.env["GROQ_BASE_URL"] = before;
    }
  });

  it("takes an explicit base URL over the environment", () => {
    const client = groqClient({
      apiKey: "gsk-test",
      baseURL: "https://api.groq.com/openai/v1",
      maxRetries: 0,
    });
    expect(client.baseURL).toBe(GROQ_HOST);
  });
});

describe("the outage taxonomy", () => {
  it("degrades a 429", async () => {
    const error = await errorFrom({ status: 429, json: { error: { message: "slow down" } } });
    expect(isOutage(error)).toBe(true);
    expect(degradeReasonOrThrow(error)).toMatch(/^outage: /);
  });

  it("degrades a 500", async () => {
    const error = await errorFrom({ status: 500, json: { error: { message: "boom" } } });
    expect(isOutage(error)).toBe(true);
    expect(degradeReasonOrThrow(error)).toMatch(/^outage: /);
  });

  it("degrades a dead socket", async () => {
    const error = await errorFrom({ throws: new Error("socket hang up") });
    expect(isOutage(error)).toBe(true);
    expect(degradeReasonOrThrow(error)).toMatch(/^outage: /);
  });

  // Our bug. A 401 that degraded would ship a keyless build that quietly asks
  // every caller their name four times instead of crashing in staging.
  it("throws a 401", async () => {
    const error = await errorFrom({ status: 401, json: { error: { message: "no key" } } });
    expect(isOutage(error)).toBe(false);
    expect(isModelFailure(error)).toBe(false);
    expect(() => degradeReasonOrThrow(error)).toThrow();
  });

  it("throws a 404 — the model we named does not exist", async () => {
    const error = await errorFrom({
      status: 404,
      json: { error: { message: "model not found", code: "model_not_found" } },
    });
    expect(() => degradeReasonOrThrow(error)).toThrow();
  });

  // The one that matters: an unrecognised 400 is still OUR bug. A tool schema we
  // broke must not wear the costume of a model having a bad day, or the phone
  // line stays up while every single call escalates to a human.
  it("throws an unrecognised 400", async () => {
    const error = await errorFrom({
      status: 400,
      json: { error: { message: "bad param", code: "invalid_parameter" } },
    });
    expect(isModelFailure(error)).toBe(false);
    expect(() => degradeReasonOrThrow(error)).toThrow();
  });

  it("throws a 400 whose body is not shaped like an error at all", async () => {
    const error = await errorFrom({ status: 400, json: { nonsense: true } });
    expect(modelFailureCode(error)).toBeNull();
    expect(() => degradeReasonOrThrow(error)).toThrow();
  });
});

describe("the third category: the model failed, not us", () => {
  // Measured live: gpt-oss-120b, handed record_service_address, flattened the
  // four-field address into one string and Groq turned that into a 400.
  it("degrades tool_use_failed rather than throwing — it must not drop the call", async () => {
    const error = await errorFrom(modelFailureReply("tool_use_failed"));
    expect(isModelFailure(error)).toBe(true);
    expect(modelFailureCode(error)).toBe("tool_use_failed");
    expect(() => degradeReasonOrThrow(error)).not.toThrow();
  });

  it("degrades json_validate_failed the same way", async () => {
    const error = await errorFrom(modelFailureReply("json_validate_failed"));
    expect(modelFailureCode(error)).toBe("json_validate_failed");
  });

  it("is not an outage, and says so in the reason", async () => {
    const error = await errorFrom(modelFailureReply("tool_use_failed"));

    // Same *behaviour* as an outage — retry, then a human. Completely different
    // bug: one is somebody else's incident, the other is fixed by choosing a
    // different model. A reason string that cannot tell them apart sends
    // somebody to read a status page for a week.
    expect(isOutage(error)).toBe(false);
    expect(degradeReasonOrThrow(error)).toMatch(/^model_failure: tool_use_failed: /);
  });
});

describe("two modes, one schema", () => {
  it("routes gpt-oss to json_schema and everything else to forced tools", () => {
    expect(modeFor("openai/gpt-oss-120b")).toBe("json_schema");
    expect(modeFor("openai/gpt-oss-20b")).toBe("json_schema");
    expect(modeFor("llama-3.3-70b-versatile")).toBe("tools");
    expect(modeFor("llama-3.1-8b-instant")).toBe("tools");
    expect(modeFor("qwen/qwen3-32b")).toBe("tools");
  });

  it("forces the tool and forbids parallel calls in tools mode", () => {
    const request = structuredRequest({
      model: "llama-3.3-70b-versatile",
      system: "s",
      user: "u",
      tool: TOOL,
      maxTokens: 256,
    });

    expect(request.tools?.[0]?.function?.parameters).toEqual(TOOL.schema);
    expect(request.tool_choice).toEqual({
      type: "function",
      function: { name: TOOL.name },
    });
    expect(request.parallel_tool_calls).toBe(false);
    expect(request.response_format).toBeUndefined();
  });

  it("carries the same schema, strict, in json_schema mode", () => {
    const request = structuredRequest({
      model: "openai/gpt-oss-120b",
      system: "s",
      user: "u",
      tool: TOOL,
      maxTokens: 256,
    });

    expect(request.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: TOOL.name,
        description: TOOL.description,
        schema: TOOL.schema,
        strict: true,
      },
    });
    expect(request.tools).toBeUndefined();
    expect(request.tool_choice).toBeUndefined();
  });

  // The A/B is the point (plan, §11). Both modes are built from ONE schema, so a
  // mode override changes the wire and nothing else.
  it("lets a mode be forced, so one model can be measured against both", () => {
    const forced = structuredRequest({
      model: "openai/gpt-oss-120b",
      system: "s",
      user: "u",
      tool: TOOL,
      maxTokens: 256,
      mode: "tools",
    });
    expect(forced.tools).toHaveLength(1);
    expect(forced.response_format).toBeUndefined();
  });

  // The `thinking: {type:"disabled"}` discipline, and the place it does not reach.
  it("disables reasoning where the model allows it, and turns it down where it does not", () => {
    expect(reasoningEffortFor("qwen/qwen3-32b")).toBe("none");
    expect(reasoningEffortFor("openai/gpt-oss-120b")).toBe("low");
    expect(reasoningEffortFor("llama-3.3-70b-versatile")).toBeUndefined();
  });

  it("sends reasoning_effort only when the model has an opinion about it", () => {
    const oss = structuredRequest({
      model: "openai/gpt-oss-120b",
      system: "s",
      user: "u",
      tool: TOOL,
      maxTokens: 256,
    });
    const llama = structuredRequest({
      model: "llama-3.3-70b-versatile",
      system: "s",
      user: "u",
      tool: TOOL,
      maxTokens: 256,
    });

    expect(oss.reasoning_effort).toBe("low");
    expect(llama.reasoning_effort).toBeUndefined();
  });

  // Transcription, not composition. A reliability number computed over a sampling
  // temperature has a random variable in it.
  it("pins temperature to 0 in both modes", () => {
    for (const model of ["openai/gpt-oss-120b", "llama-3.3-70b-versatile"]) {
      const request = structuredRequest({
        model,
        system: "s",
        user: "u",
        tool: TOOL,
        maxTokens: 256,
      });
      expect(request.temperature).toBe(0);
      expect(request.max_completion_tokens).toBe(256);
      expect(request.messages).toEqual([
        { role: "system", content: "s" },
        { role: "user", content: "u" },
      ]);
    }
  });
});

describe("reading the object back", () => {
  const completionOf = async (body: unknown) => {
    const transport = new RecordingTransport(replay(body));
    return testClient(transport).chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "hi" }],
    });
  };

  it("reads a tools-mode tool call", async () => {
    const completion = await completionOf(
      toolCallBody(TOOL.name, { value: "1247 Calle Ocho", confidence: 0.9 }),
    );
    expect(readStructured(completion, TOOL.name)).toEqual({
      kind: "parsed",
      value: { value: "1247 Calle Ocho", confidence: 0.9 },
    });
  });

  it("reads a json_schema-mode content body", async () => {
    const completion = await completionOf(
      jsonBody({ value: "1247 Calle Ocho", confidence: 0.9 }),
    );
    expect(readStructured(completion, TOOL.name)).toEqual({
      kind: "parsed",
      value: { value: "1247 Calle Ocho", confidence: 0.9 },
    });
  });

  it("is malformed, never absent, when the model produced nothing usable", async () => {
    const completion = await completionOf({
      id: "c",
      object: "chat.completion",
      created: 1,
      model: "llama-3.3-70b-versatile",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null },
          finish_reason: "length",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    // "We could not ask the question" is not "we asked and were told nothing".
    expect(readStructured(completion, TOOL.name)).toEqual({
      kind: "malformed",
      reason: `no ${TOOL.name} output (finish_reason: length)`,
    });
  });

  it("is malformed when the model wrote something that is not JSON", async () => {
    const completion = await completionOf({
      id: "c",
      object: "chat.completion",
      created: 1,
      model: "llama-3.3-70b-versatile",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "I'm sorry, I can't help with that." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    expect(readStructured(completion, TOOL.name)).toEqual({
      kind: "malformed",
      reason: `unparseable ${TOOL.name} output`,
    });
  });

  it("is malformed when there are no choices at all", async () => {
    const completion = await completionOf({
      id: "c",
      object: "chat.completion",
      created: 1,
      model: "llama-3.3-70b-versatile",
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    expect(readStructured(completion, TOOL.name)).toEqual({
      kind: "malformed",
      reason: "no choices",
    });
  });

  it("ignores a tool call for a tool we did not send", async () => {
    const completion = await completionOf(toolCallBody("some_other_tool", { a: 1 }));
    expect(readStructured(completion, TOOL.name).kind).toBe("malformed");
  });
});

describe("the transport records what the vendor saw", () => {
  it("records the request body, and `only` insists there was one", async () => {
    const transport = new RecordingTransport(replay(toolCallBody(TOOL.name, {})));
    const client = testClient(transport);

    await client.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(transport.only.model).toBe("llama-3.1-8b-instant");
    expect(transport.requests[0]?.url).toContain("/openai/v1/chat/completions");

    await client.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: "again" }],
    });
    expect(() => transport.only).toThrow(/expected 1 request, saw 2/);
  });

  it("replays each body in turn, then repeats the last", async () => {
    const transport = new RecordingTransport(
      replay(jsonBody({ n: 1 }), jsonBody({ n: 2 })),
    );
    const client = testClient(transport);
    const read = async () =>
      readStructured(
        await client.chat.completions.create({
          model: "openai/gpt-oss-120b",
          messages: [{ role: "user", content: "hi" }],
        }),
        TOOL.name,
      );

    expect(await read()).toEqual({ kind: "parsed", value: { n: 1 } });
    expect(await read()).toEqual({ kind: "parsed", value: { n: 2 } });
    expect(await read()).toEqual({ kind: "parsed", value: { n: 2 } });
  });
});
