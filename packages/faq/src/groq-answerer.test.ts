import {
  RecordingTransport,
  jsonBody,
  modelFailureReply,
  replay,
  testClient,
  toolCallBody,
} from "@ledgerline/groq";
import type { FaqContext } from "@ledgerline/contracts";
import { describe, expect, it } from "vitest";
import { SIMILARITY_FLOOR, TOOL_NAME } from "./answerer.js";
import { FAQ_ENTRIES, OTHER_TENANT_ID, TENANT_ID } from "./fixtures.js";
import { GroqFaqAnswerer } from "./groq-answerer.js";
import { HashingEmbedder, InMemoryFaqIndex } from "./index-memory.js";
import type { IndexedFaqEntry } from "./types.js";

/**
 * The Groq FAQ selector, proven offline against the real retrieval, the real
 * selection tool, and the real `interpretSelection` — the function that turns an
 * `entry_id` we never sent into `unknown`.
 *
 * That last rule is the one this call site exists for, and it is the reason both
 * bindings share the code rather than each having their own: a model that returns
 * an id nobody wrote is a model *writing an answer*, on a recorded line, about a
 * price the contractor never approved. Two copies of the check would be two
 * chances to lose it.
 */

const CTX: FaqContext = { callId: "call-1", turnIndex: 2 };

const embedder = new HashingEmbedder();

async function indexed(): Promise<InMemoryFaqIndex> {
  const entries: IndexedFaqEntry[] = [];
  for (const entry of FAQ_ENTRIES) {
    entries.push({ ...entry, embedding: await embedder.embed(entry.question) });
  }
  return new InMemoryFaqIndex(entries);
}

async function answererFor(
  transport: RecordingTransport,
  tenantId = TENANT_ID,
  model = "llama-3.3-70b-versatile",
): Promise<GroqFaqAnswerer> {
  return new GroqFaqAnswerer({
    client: testClient(transport),
    index: await indexed(),
    embedder,
    tenantId,
    model,
  });
}

const ESTIMATE = FAQ_ENTRIES[0]!;

describe("selection, not generation", () => {
  it("speaks the contractor's committed answer byte for byte", async () => {
    const transport = new RecordingTransport(
      replay(toolCallBody(TOOL_NAME, { entry_id: ESTIMATE.id, confidence: 0.95 })),
    );

    const answerer = await answererFor(transport);
    const outcome = await answerer.answer("Do you charge for an estimate?", CTX);

    expect(outcome).toEqual({
      kind: "answered",
      answer: ESTIMATE.answer,
      entryId: ESTIMATE.id,
    });
    // Not a paraphrase, not a summary. The contractor's sentence.
    expect(outcome).toMatchObject({ answer: expect.stringContaining("seventy-nine dollar") });
  });

  it("works the same way through json_schema, for a model that rejects tools", async () => {
    const transport = new RecordingTransport(
      replay(jsonBody({ entry_id: ESTIMATE.id, confidence: 0.95 })),
    );

    const answerer = await answererFor(transport, TENANT_ID, "openai/gpt-oss-120b");
    const outcome = await answerer.answer("Do you charge for an estimate?", CTX);

    expect(outcome).toMatchObject({ kind: "answered", entryId: ESTIMATE.id });
    expect(transport.only.response_format).toMatchObject({ type: "json_schema" });
  });

  // The hallucinated id. A model that invents an entry is inventing a sentence.
  it("refuses an entry_id we never sent", async () => {
    const transport = new RecordingTransport(
      replay(
        toolCallBody(TOOL_NAME, {
          entry_id: "deadbeef-0000-4000-8000-000000000000",
          confidence: 0.99,
        }),
      ),
    );

    const answerer = await answererFor(transport);
    const outcome = await answerer.answer("Do you charge for an estimate?", CTX);

    expect(outcome).toEqual({ kind: "unknown" });
  });

  it("is unknown when the model selects nothing", async () => {
    const transport = new RecordingTransport(
      replay(toolCallBody(TOOL_NAME, { entry_id: null, confidence: 0.2 })),
    );

    const answerer = await answererFor(transport);
    const outcome = await answerer.answer("Do you charge for an estimate?", CTX);

    expect(outcome).toEqual({ kind: "unknown" });
  });
});

describe("the cheap null, and the tenant wall", () => {
  it("makes no model call at all when nothing clears the floor", async () => {
    const transport = new RecordingTransport(() => {
      throw new Error("the model must not be called");
    });

    const answerer = await answererFor(transport);
    const outcome = await answerer.answer(
      "zzzz qqqq xxxx unrelated gibberish nothing matches",
      CTX,
    );

    expect(outcome).toEqual({ kind: "unknown" });
    expect(transport.requests).toHaveLength(0);
    expect(SIMILARITY_FLOOR).toBeGreaterThan(0);
  });

  // One shop's prices must never reach another's caller. The index is scoped, so
  // a tenant with no FAQ retrieves nothing and the model is never asked.
  it("never speaks one tenant's answer to another's caller", async () => {
    const transport = new RecordingTransport(() => {
      throw new Error("the model must not be called");
    });

    const answerer = await answererFor(transport, OTHER_TENANT_ID);
    const outcome = await answerer.answer("Do you charge for an estimate?", CTX);

    expect(outcome).toEqual({ kind: "unknown" });
    expect(transport.requests).toHaveLength(0);
  });
});

describe("the taxonomy, at the call site", () => {
  it("degrades an outage to unavailable", async () => {
    const transport = new RecordingTransport(() => ({
      status: 503,
      json: { error: { message: "upstream unavailable" } },
    }));

    const answerer = await answererFor(transport);
    const outcome = await answerer.answer("Do you charge for an estimate?", CTX);

    expect(outcome.kind).toBe("unavailable");
  });

  /**
   * The tempting mapping here is `unknown` — the caller is told a human will call
   * back, which is honest, and the call flows on. It is still wrong: the dashboard
   * then cannot tell a question nobody wrote an answer to (the contractor's gap,
   * fixed by writing an FAQ entry) from a model that cannot operate the tool
   * (ours, fixed by changing the model).
   */
  it("does not call a model that failed the schema `unknown` — that would hide our bug in a content gap", async () => {
    const transport = new RecordingTransport(() => modelFailureReply("tool_use_failed"));

    const answerer = await answererFor(transport);
    const outcome = await answerer.answer("Do you charge for an estimate?", CTX);

    expect(outcome.kind).not.toBe("unknown");
    expect(outcome).toMatchObject({
      reason: expect.stringMatching(/^model_failure: tool_use_failed: /),
    });
  });

  it("throws a 401 rather than telling the caller we have no answer", async () => {
    const transport = new RecordingTransport(() => ({
      status: 401,
      json: { error: { message: "invalid api key" } },
    }));

    const answerer = await answererFor(transport);
    await expect(
      answerer.answer("Do you charge for an estimate?", CTX),
    ).rejects.toThrow();
  });

  it("reports a retrieval failure as unavailable, not as no answer", async () => {
    const transport = new RecordingTransport(() => {
      throw new Error("the model must not be called");
    });

    const answerer = new GroqFaqAnswerer({
      client: testClient(transport),
      index: {
        search: async () => {
          throw new Error("pgvector is down");
        },
      },
      embedder,
      tenantId: TENANT_ID,
    });

    const outcome = await answerer.answer("Do you charge for an estimate?", CTX);
    expect(outcome).toEqual({ kind: "unavailable", reason: "pgvector is down" });
  });
});
