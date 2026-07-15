import Anthropic from "@anthropic-ai/sdk";
import { RecordingTransport, replay, testClient, type Handler } from "@ledgerline/anthropic";
import { OutcomeClassificationSchema } from "@ledgerline/contracts";
import { describe, expect, it } from "vitest";
import * as fx from "./fixtures.js";
import {
  AnthropicTriager,
  SYSTEM_PROMPT,
  TOOL_NAME,
  TRIAGE_MODEL,
  evidence,
  type TriageUsage,
} from "./triager.js";

function triagerOn(handler: Handler): {
  transport: RecordingTransport;
  triager: AnthropicTriager;
  usage: TriageUsage[];
} {
  const transport = new RecordingTransport(handler);
  const usage: TriageUsage[] = [];
  const triager = new AnthropicTriager({
    client: testClient(transport),
    onUsage: (u) => usage.push(u),
  });
  return { transport, triager, usage };
}

const status = (code: number): Handler => () => ({
  status: code,
  json: { type: "error", error: { type: "error", message: "boom" } },
});

describe("the request", () => {
  it("is a forced, single, strict tool call on the triage model", async () => {
    const { transport, triager } = triagerOn(replay(fx.AGENT_ERROR));
    await triager.classify(fx.MISHEARD_STREET);

    const body = transport.only;
    expect(body.model).toBe(TRIAGE_MODEL);
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toEqual({
      type: "tool",
      name: TOOL_NAME,
      disable_parallel_tool_use: true,
    });
  });

  /**
   * Extended thinking and a forced `tool_choice` cannot coexist in the Messages
   * API. We keep the forced tool: a nightly pass whose label has to be parsed out
   * of a paragraph is a nightly pass that mislabels whatever it fails to parse.
   */
  it("disables thinking, because a forced tool_choice forbids it", async () => {
    const { transport, triager } = triagerOn(replay(fx.AGENT_ERROR));
    await triager.classify(fx.MISHEARD_STREET);
    expect(transport.only.thinking).toEqual({ type: "disabled" });
  });

  it("renders an identical cached prefix for two different bookings", async () => {
    const { transport, triager } = triagerOn(replay(fx.AGENT_ERROR));
    await triager.classify(fx.MISHEARD_STREET);
    await triager.classify(fx.RESCHEDULED);

    const [first, second] = transport.requests;
    expect(JSON.stringify(second!.body.system)).toBe(JSON.stringify(first!.body.system));
    expect(JSON.stringify(second!.body.tools)).toBe(JSON.stringify(first!.body.tools));
    expect(JSON.stringify(second!.body.messages)).not.toBe(
      JSON.stringify(first!.body.messages),
    );
  });

  /** The tool's enum is the contract's enum, or a label could exist that no column accepts. */
  it("offers exactly the three labels the contract defines", async () => {
    const { transport, triager } = triagerOn(replay(fx.AGENT_ERROR));
    await triager.classify(fx.MISHEARD_STREET);

    const schema = JSON.stringify(transport.only.tools);
    for (const label of OutcomeClassificationSchema.options) {
      expect(schema).toContain(label);
    }
  });

  /**
   * The bias correction. A model asked whether an edit was its own fault reaches
   * for the exculpatory reading, and every exculpatory reading improves the number
   * we publish. Delete this and the classifier becomes marketing.
   */
  it("tells the model to be harder on itself, not easier", () => {
    expect(SYSTEM_PROMPT).toContain("harder on yourself, not easier");
  });

  it("shows the model both halves of the evidence, and not the geocoder's address", () => {
    const text = evidence(fx.MISHEARD_STREET);
    expect(text).toContain("1247 Calle Ocho");
    expect(text).toContain("1247 SW 8th St");
    // `formatted` is our geocoder's output, never the contractor's. `diffBooking`
    // refuses to compare it; showing it here would invite the model to.
    expect(text).not.toContain("USA");
  });

  it("tells the model when a booking was cancelled with nothing edited", () => {
    const text = evidence(fx.CANCELLED);
    expect(text).toContain("CANCELLED");
    expect(text).toContain("(no field was edited)");
  });
});

describe("the verdict", () => {
  it("classifies a misheard street as our error, with a rationale a human can check", async () => {
    const { triager } = triagerOn(replay(fx.AGENT_ERROR));
    const verdict = await triager.classify(fx.MISHEARD_STREET);

    expect(verdict.kind).toBe("classified");
    if (verdict.kind !== "classified") throw new Error("unreachable");
    expect(verdict.classification).toBe("agent_error");
    expect(verdict.rationale).toContain("service_address");
  });

  it("classifies a reschedule and an appended gate code", async () => {
    const { triager: a } = triagerOn(replay(fx.BUSINESS_CHANGE));
    const { triager: b } = triagerOn(replay(fx.ENRICHMENT));

    await expect(a.classify(fx.RESCHEDULED)).resolves.toMatchObject({
      classification: "business_change",
    });
    await expect(b.classify(fx.ENRICHED)).resolves.toMatchObject({
      classification: "enrichment",
    });
  });

  /** A shrug is not an acquittal: `declined` leaves the diff counting against us. */
  it("declines when the model returns null", async () => {
    const { triager } = triagerOn(replay(fx.DECLINED));
    const verdict = await triager.classify(fx.RESCHEDULED);
    expect(verdict.kind).toBe("declined");
  });

  it("declines a label that is not one of the three", async () => {
    const { triager } = triagerOn(replay(fx.UNRECOGNISED_LABEL));
    const verdict = await triager.classify(fx.MISHEARD_STREET);
    expect(verdict).toEqual({
      kind: "declined",
      reason: "unrecognised label: our_bad",
    });
  });

  /**
   * An exoneration with no argument behind it cannot be audited, and an
   * unauditable exoneration is precisely what this call site must not produce.
   */
  it("declines a verdict that comes with no rationale", async () => {
    const { triager } = triagerOn(replay(fx.NO_RATIONALE));
    const verdict = await triager.classify(fx.RESCHEDULED);
    expect(verdict).toEqual({ kind: "declined", reason: "no rationale" });
  });

  it("declines an input that is not even a verdict", async () => {
    const { triager } = triagerOn(replay(fx.MALFORMED_INPUT));
    expect(await triager.classify(fx.MISHEARD_STREET)).toEqual({
      kind: "declined",
      reason: "no tool input",
    });
  });

  it("reports a refusal as unavailable rather than as a decline", async () => {
    const { triager } = triagerOn(replay(fx.REFUSAL));
    const verdict = await triager.classify(fx.MISHEARD_STREET);
    expect(verdict.kind).toBe("unavailable");
  });

  it("reports usage, so a silently broken cache shows up as cost", async () => {
    const { triager, usage } = triagerOn(replay(fx.AGENT_ERROR));
    await triager.classify(fx.MISHEARD_STREET);

    expect(usage).toEqual([
      {
        bookingId: fx.MISHEARD_STREET.outcome.bookingId,
        inputTokens: 640,
        outputTokens: 58,
        cacheReadInputTokens: 0,
      },
    ]);
  });
});

describe("outages", () => {
  it("reports a 429, a 503, and a dead socket as unavailable", async () => {
    const cases: Handler[] = [
      status(429),
      status(503),
      () => ({ throws: new Anthropic.APIConnectionError({}) }),
    ];
    for (const handler of cases) {
      const { triager } = triagerOn(handler);
      const verdict = await triager.classify(fx.MISHEARD_STREET);
      expect(verdict.kind).toBe("unavailable");
    }
  });

  it("throws on a 400, because a malformed request is our bug", async () => {
    const { triager } = triagerOn(status(400));
    await expect(triager.classify(fx.MISHEARD_STREET)).rejects.toThrow();
  });
});
