import Anthropic from "@anthropic-ai/sdk";
import { RecordingTransport, replay, testClient, type Handler } from "@ledgerline/anthropic";
import { FAQ_EMBEDDING_DIMENSIONS, type FaqContext } from "@ledgerline/contracts";
import { describe, expect, it } from "vitest";
import {
  AnthropicFaqAnswerer,
  FAQ_MODEL,
  SIMILARITY_FLOOR,
  SYSTEM_PROMPT,
  TOOL_NAME,
} from "./answerer.js";
import { FailingEmbedder } from "./fake.js";
import * as fx from "./fixtures.js";
import { HashingEmbedder, InMemoryFaqIndex, cosine } from "./index-memory.js";
import type { Embedder, IndexedFaqEntry } from "./types.js";

const CTX: FaqContext = { callId: "0f8fad5b-d9cb-469f-a165-70867728950e", turnIndex: 3 };

const embedder = new HashingEmbedder();

/** The committed FAQ, embedded with the same embedder the answerer queries with. */
async function indexed(): Promise<IndexedFaqEntry[]> {
  return Promise.all(
    fx.FAQ_ENTRIES.map(async (entry) => ({
      ...entry,
      embedding: await embedder.embed(entry.question),
    })),
  );
}

async function answererOn(
  handler: Handler,
  options: { tenantId?: string; embedder?: Embedder } = {},
): Promise<{ transport: RecordingTransport; answerer: AnthropicFaqAnswerer }> {
  const transport = new RecordingTransport(handler);
  const answerer = new AnthropicFaqAnswerer({
    client: testClient(transport),
    index: new InMemoryFaqIndex(await indexed()),
    embedder: options.embedder ?? embedder,
    tenantId: options.tenantId ?? fx.TENANT_ID,
  });
  return { transport, answerer };
}

const dead = (): Handler => () => ({ throws: new Anthropic.APIConnectionError({}) });

const status = (code: number): Handler => () => ({
  status: code,
  json: { type: "error", error: { type: "error", message: "boom" } },
});

describe("retrieval", () => {
  it("rejects an embedding that is not the width of the pgvector column", () => {
    expect(
      () =>
        new InMemoryFaqIndex([
          { ...fx.FAQ_ENTRIES[0]!, embedding: [0.1, 0.2, 0.3] },
        ]),
    ).toThrow(/expected 1024/);
  });

  /** The db column is `vector(FAQ_EMBEDDING_DIMENSIONS)`. A drift here fails an insert. */
  it("embeds to exactly the width the schema declares", async () => {
    const vector = await embedder.embed("do you charge for an estimate");
    expect(vector).toHaveLength(FAQ_EMBEDDING_DIMENSIONS);
  });

  it("is deterministic, so a fixture means the same thing tomorrow", async () => {
    expect(await embedder.embed("what are your hours")).toEqual(
      await embedder.embed("what are your hours"),
    );
  });

  it("scores a zero vector as zero rather than dividing by it", () => {
    expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosine([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it("ranks the entry the caller actually asked about first", async () => {
    const index = new InMemoryFaqIndex(await indexed());
    const hits = await index.search(
      fx.TENANT_ID,
      await embedder.embed("do you take credit cards"),
      5,
    );
    expect(hits[0]!.entry.id).toBe(fx.FAQ_ENTRIES[2]!.id);
    expect(hits[0]!.score).toBeGreaterThan(SIMILARITY_FLOOR);
  });

  /**
   * One contractor's prices, spoken to another's caller, is the failure mode a
   * tenant-scoped signature exists to make impossible.
   */
  it("never returns another tenant's answers", async () => {
    const index = new InMemoryFaqIndex(await indexed());
    const hits = await index.search(
      fx.OTHER_TENANT_ID,
      await embedder.embed("do you take credit cards"),
      5,
    );
    expect(hits).toEqual([]);
  });
});

describe("the request", () => {
  it("is a forced, single, strict tool call with thinking off", async () => {
    const { transport, answerer } = await answererOn(replay(fx.SELECTED_ESTIMATE_FEE));
    await answerer.answer("do you charge for an estimate", CTX);

    const body = transport.only;
    expect(body.model).toBe(FAQ_MODEL);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toEqual({
      type: "tool",
      name: TOOL_NAME,
      disable_parallel_tool_use: true,
    });
  });

  /**
   * The prefix is the cache. One per-call byte in `system` or `tools` — a caller's
   * question, a retrieved answer, a timestamp — invalidates it on every question
   * ever asked, and the only symptom is the bill (plan, §10.1).
   */
  it("renders an identical prefix for two different questions", async () => {
    const { transport, answerer } = await answererOn(replay(fx.SELECTED_ESTIMATE_FEE));
    await answerer.answer("do you charge for an estimate", CTX);
    await answerer.answer("what are your hours on a saturday", {
      callId: "5c2f8e9a-3b4d-4a6f-8e1c-2d3f4a5b6c7d",
      turnIndex: 9,
    });

    const [first, second] = transport.requests;
    expect(JSON.stringify(second!.body.system)).toBe(JSON.stringify(first!.body.system));
    expect(JSON.stringify(second!.body.tools)).toBe(JSON.stringify(first!.body.tools));
    expect(JSON.stringify(second!.body.messages)).not.toBe(
      JSON.stringify(first!.body.messages),
    );
  });

  it("puts the retrieved candidates in the messages, where per-call data belongs", async () => {
    const { transport, answerer } = await answererOn(replay(fx.SELECTED_ESTIMATE_FEE));
    await answerer.answer("do you charge for an estimate", CTX);

    const prefix = JSON.stringify([transport.only.system, transport.only.tools]);
    expect(prefix).not.toContain(fx.FAQ_ENTRIES[0]!.id);
    expect(prefix).not.toContain("seventy-nine");

    const messages = JSON.stringify(transport.only.messages);
    expect(messages).toContain(fx.FAQ_ENTRIES[0]!.id);
    expect(messages).toContain(fx.FAQ_ENTRIES[0]!.answer);
  });

  it("tells the model to select rather than to write", () => {
    expect(SYSTEM_PROMPT).toContain("selecting, not writing");
  });
});

describe("selecting an answer", () => {
  /**
   * The whole point of the call site: the caller hears the contractor's committed
   * sentence, byte for byte. Not a paraphrase of it, not a summary of it.
   */
  it("speaks the contractor's committed answer verbatim", async () => {
    const { answerer } = await answererOn(replay(fx.SELECTED_ESTIMATE_FEE));
    const outcome = await answerer.answer("is the estimate free", CTX);

    expect(outcome).toEqual({
      kind: "answered",
      answer: fx.FAQ_ENTRIES[0]!.answer,
      entryId: fx.FAQ_ENTRIES[0]!.id,
    });
  });

  it("returns unknown when the model says none of them fits", async () => {
    const { answerer } = await answererOn(replay(fx.SELECTED_NONE));
    expect(await answerer.answer("do you service pools", CTX)).toEqual({ kind: "unknown" });
  });

  /** An id we never sent is a sentence we never wrote. It must not be speakable. */
  it("refuses an id it was never given", async () => {
    const { answerer } = await answererOn(replay(fx.SELECTED_HALLUCINATED_ID));
    expect(await answerer.answer("do you charge for an estimate", CTX)).toEqual({
      kind: "unknown",
    });
  });

  it("speaks nothing when the selection is not even a selection", async () => {
    const { answerer } = await answererOn(replay(fx.MALFORMED_INPUT));
    expect(await answerer.answer("do you charge for an estimate", CTX)).toEqual({
      kind: "unknown",
    });
  });

  it("treats a refusal as unavailable, not as no-answer", async () => {
    const { answerer } = await answererOn(replay(fx.REFUSAL));
    const outcome = await answerer.answer("do you charge for an estimate", CTX);
    expect(outcome.kind).toBe("unavailable");
  });

  /**
   * Nothing close enough is answered without asking anybody: no model call, no
   * latency, and no chance of the model picking the least-bad of five irrelevant
   * answers because it was asked to pick.
   */
  it("answers unknown below the similarity floor without calling the model", async () => {
    const { transport, answerer } = await answererOn(replay(fx.SELECTED_ESTIMATE_FEE));
    const outcome = await answerer.answer("zebra mango orbit", CTX);

    expect(outcome).toEqual({ kind: "unknown" });
    expect(transport.requests).toEqual([]);
  });

  it("never answers from another tenant's FAQ", async () => {
    const { transport, answerer } = await answererOn(replay(fx.SELECTED_ESTIMATE_FEE), {
      tenantId: fx.OTHER_TENANT_ID,
    });
    expect(await answerer.answer("do you charge for an estimate", CTX)).toEqual({
      kind: "unknown",
    });
    expect(transport.requests).toEqual([]);
  });
});

describe("outages", () => {
  /**
   * `unavailable` and `unknown` sound identical to the caller and mean opposite
   * things to us: one says write more FAQ entries, the other says fix the index.
   */
  it("reports a retrieval failure as unavailable, not as unknown", async () => {
    const { transport, answerer } = await answererOn(replay(fx.SELECTED_ESTIMATE_FEE), {
      embedder: new FailingEmbedder(new Error("pgvector: connection refused")),
    });

    const outcome = await answerer.answer("do you charge for an estimate", CTX);
    expect(outcome).toEqual({
      kind: "unavailable",
      reason: "pgvector: connection refused",
    });
    expect(transport.requests).toEqual([]);
  });

  it("reports a dead socket as unavailable", async () => {
    const { answerer } = await answererOn(dead());
    const outcome = await answerer.answer("do you charge for an estimate", CTX);
    expect(outcome.kind).toBe("unavailable");
  });

  it("reports a 429 and a 503 as unavailable", async () => {
    for (const code of [429, 503]) {
      const { answerer } = await answererOn(status(code));
      const outcome = await answerer.answer("do you charge for an estimate", CTX);
      expect(outcome.kind).toBe("unavailable");
    }
  });

  /** A 400 is our bug. It crashes in staging rather than degrading on a call. */
  it("throws on a 400 and a 401", async () => {
    for (const code of [400, 401]) {
      const { answerer } = await answererOn(status(code));
      await expect(answerer.answer("do you charge for an estimate", CTX)).rejects.toThrow();
    }
  });
});
