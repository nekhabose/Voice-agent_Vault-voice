import {
  RecordingTransport,
  jsonBody,
  modelFailureReply,
  replay,
  testClient,
  toolCallBody,
} from "@ledgerline/groq";
import { describe, expect, it } from "vitest";
import { CANCELLED, ENRICHED, MISHEARD_STREET, RESCHEDULED } from "./fixtures.js";
import { GroqTriager } from "./groq-triager.js";
import { SYSTEM_PROMPT, TOOL_NAME } from "./triager.js";

/**
 * The interested party, on a second vendor.
 *
 * Every hedge that makes this call site safe is a property of the port, the tool,
 * and `interpretClassification` — not of the model behind them — so this suite is
 * the same suite, and that is the point. A verdict with no rationale is `declined`.
 * A label outside the enum is `declined`. `declined` counts against us. None of
 * that moved.
 */

const LLAMA = "llama-3.3-70b-versatile";

const triagerFor = (transport: RecordingTransport, model = LLAMA) =>
  new GroqTriager({ client: testClient(transport), model });

const verdict = (classification: string | null, rationale: string) =>
  toolCallBody(TOOL_NAME, { classification, rationale });

describe("it classifies", () => {
  it("labels a misheard street as our error", async () => {
    const transport = new RecordingTransport(
      replay(
        verdict(
          "agent_error",
          "service_address was rewritten from Calle Ocho to SW 8th St — the same street in the form the truck needs. Consistent with the agent having recorded what it heard rather than what the address is.",
        ),
      ),
    );

    const outcome = await triagerFor(transport).classify(MISHEARD_STREET);

    expect(outcome).toMatchObject({
      kind: "classified",
      classification: "agent_error",
    });
    expect(transport.only.messages[0]).toEqual({
      role: "system",
      content: SYSTEM_PROMPT,
    });
    // The evidence is per-booking and belongs in `messages`, never in the prompt.
    expect(String(transport.only.messages[1]?.content)).toContain("1247 SW 8th St");
  });

  it("labels a reschedule as a business change", async () => {
    const transport = new RecordingTransport(
      replay(verdict("business_change", "The window moved; nothing says the agent misheard it.")),
    );

    const outcome = await triagerFor(transport).classify(RESCHEDULED);
    expect(outcome).toMatchObject({ classification: "business_change" });
  });

  it("labels an added gate code as enrichment", async () => {
    const transport = new RecordingTransport(
      replay(verdict("enrichment", "A gate code the caller never mentioned. Incomplete, not wrong.")),
    );

    const outcome = await triagerFor(transport).classify(ENRICHED);
    expect(outcome).toMatchObject({ classification: "enrichment" });
  });

  it("works the same through json_schema", async () => {
    const transport = new RecordingTransport(
      replay(jsonBody({ classification: "agent_error", rationale: "The street was rewritten." })),
    );

    const outcome = await triagerFor(transport, "openai/gpt-oss-120b").classify(
      MISHEARD_STREET,
    );

    expect(outcome).toMatchObject({ classification: "agent_error" });
    expect(transport.only.response_format).toMatchObject({ type: "json_schema" });
  });
});

describe("an unauditable exoneration must not be constructible", () => {
  // A label with no argument behind it is not something a human auditor can check
  // in thirty seconds, and this is the call site that must not be able to produce
  // one. `declined` counts against us — a shrug is not an acquittal.
  it("declines a verdict with no rationale", async () => {
    const transport = new RecordingTransport(replay(verdict("business_change", "")));

    const outcome = await triagerFor(transport).classify(CANCELLED);
    expect(outcome).toEqual({ kind: "declined", reason: "no rationale" });
  });

  it("declines a label outside the enum", async () => {
    const transport = new RecordingTransport(
      replay(verdict("not_our_problem", "It was the customer's fault.")),
    );

    const outcome = await triagerFor(transport).classify(CANCELLED);
    expect(outcome).toMatchObject({
      kind: "declined",
      reason: expect.stringContaining("unrecognised label"),
    });
  });

  it("declines a null label, and keeps the rationale for the auditor", async () => {
    const transport = new RecordingTransport(
      replay(verdict(null, "The diff is empty and the cancellation has no stated cause.")),
    );

    const outcome = await triagerFor(transport).classify(CANCELLED);
    expect(outcome).toEqual({
      kind: "declined",
      reason: "The diff is empty and the cancellation has no stated cause.",
    });
  });
});

describe("the taxonomy, at the call site", () => {
  // Every failure mode of this pipeline pushes the published number UP: an
  // unclassified correction counts as an agent error, and an agent error is a
  // booking we do not bill for. An outage here costs us money, on purpose.
  it("degrades an outage to unavailable — which still counts against us", async () => {
    const transport = new RecordingTransport(() => ({
      status: 500,
      json: { error: { message: "internal" } },
    }));

    const outcome = await triagerFor(transport).classify(MISHEARD_STREET);
    expect(outcome).toMatchObject({
      kind: "unavailable",
      reason: expect.stringMatching(/^outage: /),
    });
  });

  it("separates a model that could not answer from a model that would not", async () => {
    const transport = new RecordingTransport(() => modelFailureReply("tool_use_failed"));

    const outcome = await triagerFor(transport).classify(MISHEARD_STREET);

    // Both leave the correction counting against us, so the number is the same.
    // But "could not produce the object" and "looked and could not tell" are
    // different bugs, and only one of them is ours to fix.
    expect(outcome.kind).toBe("unavailable");
    expect(outcome).not.toMatchObject({ kind: "declined" });
  });

  it("throws a 401", async () => {
    const transport = new RecordingTransport(() => ({
      status: 401,
      json: { error: { message: "invalid api key" } },
    }));

    await expect(triagerFor(transport).classify(MISHEARD_STREET)).rejects.toThrow();
  });
});

describe("usage", () => {
  it("reports tokens per booking", async () => {
    const seen: unknown[] = [];
    const transport = new RecordingTransport(
      replay(verdict("agent_error", "The street was rewritten.")),
    );

    const triager = new GroqTriager({
      client: testClient(transport),
      model: LLAMA,
      onUsage: (usage) => seen.push(usage),
    });
    await triager.classify(MISHEARD_STREET);

    expect(seen).toEqual([
      {
        bookingId: MISHEARD_STREET.outcome.bookingId,
        inputTokens: 420,
        outputTokens: 24,
      },
    ]);
  });
});
