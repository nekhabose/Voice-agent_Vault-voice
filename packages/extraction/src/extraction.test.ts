import Anthropic from "@anthropic-ai/sdk";
import {
  RecordingTransport,
  replay,
  testClient,
  type Handler,
} from "@ledgerline/anthropic";
import {
  LOW_CONFIDENCE_THRESHOLD,
  SLOT_KEYS,
  SLOT_SPECS,
  type ExtractionContext,
  type SlotKey,
} from "@ledgerline/contracts";
import { describe, expect, it } from "vitest";
import {
  AnthropicExtractor,
  EXTRACTION_MODEL,
  SYSTEM_PROMPT,
  type ExtractionUsage,
} from "./extractor.js";
import { FakeExtractor, absent, filled, unavailable } from "./fake.js";
import * as fx from "./fixtures.js";
import { strictify, stripNulls, toolFor, toolNameFor } from "./tool.js";

const CTX: ExtractionContext = { callId: "call_01", turnIndex: 0 };

function extractorOn(handler: Handler) {
  const transport = new RecordingTransport(handler);
  const usage: ExtractionUsage[] = [];
  const extractor = new AnthropicExtractor({
    client: testClient(transport),
    onUsage: (u) => usage.push(u),
  });
  return { transport, extractor, usage };
}

/** Anything the SDK turns into a typed error needs a body it can parse. */
const errorBody = (type: string) => ({
  type: "error",
  error: { type, message: type },
});

/* -------------------------------------------------------------------------- */
/* Tool schema, derived from the contract                                      */
/* -------------------------------------------------------------------------- */

describe("toolFor", () => {
  it.each(SLOT_KEYS)("derives a strict, object-rooted tool for %s", (key) => {
    const tool = toolFor(key);
    expect(tool.name).toBe(`record_${key}`);
    expect(tool.strict).toBe(true);
    expect(tool.input_schema.type).toBe("object");
    expect(tool.input_schema.additionalProperties).toBe(false);
    expect([...tool.input_schema.required]).toEqual(["value", "confidence"]);
  });

  it("gives the model a null escape for every slot", () => {
    // Under a forced `tool_choice` the model must call the tool. Without null it
    // would have to invent a name for a caller who never gave one.
    for (const key of SLOT_KEYS) {
      const value = toolFor(key).input_schema.properties["value"] as {
        anyOf: { type?: string }[];
      };
      expect(value.anyOf).toContainEqual({ type: "null" });
    }
  });

  it("never asks the model for a geocoder-owned address field", () => {
    // Principle #3: an address is validated against a geocoder, never trusted
    // from the transcript. A model that can emit `formatted` can hallucinate a
    // normalised address that the read-back then quotes back to the caller.
    const schema = JSON.stringify(toolFor("service_address").input_schema);
    expect(schema).not.toContain("formatted");
    expect(schema).not.toContain("lat");
    expect(schema).not.toContain("lng");
  });

  it("asks for spoken digits, not E.164", () => {
    // `validatePhone` does words-to-E.164. Handing the model E164Schema would
    // make it invent a country code.
    const value = toolFor("callback_phone").input_schema.properties["value"];
    expect(JSON.stringify(value)).not.toContain("\\\\+[1-9]");
  });

  it("moves the contract's optional fields to nullable-and-required", () => {
    const value = toolFor("service_address").input_schema.properties["value"] as {
      anyOf: [{ required: string[]; properties: Record<string, unknown> }, unknown];
    };
    const object = value.anyOf[0];
    expect(object.required.sort()).toEqual(
      ["city", "line1", "line2", "postalCode", "state"].sort(),
    );
    expect(object.properties["line2"]).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
  });

  it("carries the urgency enum through verbatim", () => {
    // The enum is the one semantic constraint strict mode does enforce, and it
    // is the reason urgency cannot come back as "pretty urgent".
    const value = toolFor("urgency").input_schema.properties["value"] as {
      anyOf: [{ enum: string[] }, unknown];
    };
    expect(value.anyOf[0].enum).toEqual([
      "ROUTINE",
      "SOON",
      "SAME_DAY",
      "EMERGENCY",
    ]);
  });
});

describe("strictify", () => {
  it("drops the keywords strict mode rejects", () => {
    const out = strictify({
      type: "object",
      properties: {
        a: { type: "string", minLength: 1, maxLength: 5, pattern: "^x$" },
        b: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["a", "b"],
      $schema: "http://json-schema.org/draft-07/schema#",
    });

    expect(out).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a", "b"],
      additionalProperties: false,
    });
  });

  it("recurses into nested objects", () => {
    const out = strictify({
      type: "object",
      properties: { inner: { type: "object", properties: { x: { type: "string" } } } },
      required: ["inner"],
    }) as { properties: { inner: { additionalProperties: boolean; required: string[] } } };

    expect(out.properties.inner.additionalProperties).toBe(false);
    expect(out.properties.inner.required).toEqual(["x"]);
  });
});

describe("stripNulls", () => {
  it("undoes the nullable-and-required round trip", () => {
    expect(stripNulls({ line1: "a", line2: null, nested: { x: null, y: 1 } })).toEqual({
      line1: "a",
      nested: { y: 1 },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The outgoing request                                                        */
/* -------------------------------------------------------------------------- */

describe("the request body", () => {
  it("pins thinking to disabled", async () => {
    // Sonnet 5 runs adaptive thinking when `thinking` is omitted. Somebody will
    // refactor this class, drop the field, and add seconds to every turn of
    // every call. This test is the only thing that notices.
    const { transport, extractor } = extractorOn(replay(fx.CALLER_NAME_FILLED));
    await extractor.extract("caller_name", "It's Dana Whitfield", CTX);

    expect(transport.only.thinking).toEqual({ type: "disabled" });
  });

  it("forces the one tool for the slot and no other", async () => {
    const { transport, extractor } = extractorOn(replay(fx.URGENCY_FILLED));
    await extractor.extract("urgency", "Today if you can", CTX);

    const body = transport.only;
    expect(body.tools).toHaveLength(1);
    expect(body.tools?.[0]?.name).toBe("record_urgency");
    expect(body.tool_choice).toEqual({
      type: "tool",
      name: "record_urgency",
      disable_parallel_tool_use: true,
    });
    expect(body.model).toBe(EXTRACTION_MODEL);
    expect(body.max_tokens).toBe(256);
  });

  it("puts the utterance after the cache breakpoint, never in the prefix", async () => {
    // `tools` render, then `system`, then `messages`. One interpolated byte in
    // the prefix invalidates the cache on every turn of every call, multiplies
    // extraction cost roughly tenfold, and the only symptom is a latency graph
    // nobody can explain. Assert the bytes, not the intent.
    const { transport, extractor } = extractorOn(
      replay(fx.CALLER_NAME_FILLED, fx.CALLER_NAME_CACHE_WARM),
    );

    await extractor.extract("caller_name", "It's Dana Whitfield", CTX);
    await extractor.extract("caller_name", "Dana, D-A-N-A", {
      callId: "call_99",
      turnIndex: 7,
    });

    const [first, second] = transport.requests.map((r) => r.body);
    expect(JSON.stringify(second!.system)).toBe(JSON.stringify(first!.system));
    expect(JSON.stringify(second!.tools)).toBe(JSON.stringify(first!.tools));
    expect(second!.messages).not.toEqual(first!.messages);
  });

  it("marks the last system block for caching", async () => {
    const { transport, extractor } = extractorOn(replay(fx.CALLER_NAME_FILLED));
    await extractor.extract("caller_name", "Dana", CTX);

    const system = transport.only.system as Anthropic.TextBlockParam[];
    expect(system.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("keeps the system prompt free of anything per-call", () => {
    // A `Date.now()`, a call id, or a caller's name in here is the silent
    // invalidator. Interpolation is what this test exists to forbid.
    expect(SYSTEM_PROMPT).not.toMatch(/\$\{|\d{4}-\d{2}-\d{2}|call_/);
  });
});

/* -------------------------------------------------------------------------- */
/* Replay: recorded responses through the real SLOT_SPECS                      */
/* -------------------------------------------------------------------------- */

describe("replay against the real contracts", () => {
  const cases: readonly [SlotKey, fx.MessageBody, unknown][] = [
    ["caller_name", fx.CALLER_NAME_FILLED, "Dana Whitfield"],
    ["callback_phone", fx.CALLBACK_PHONE_FILLED, "305 555 0142"],
    [
      "service_address",
      fx.SERVICE_ADDRESS_FILLED,
      {
        line1: "1247 Barton Springs Rd",
        city: "Austin",
        state: "TX",
        postalCode: "78704",
      },
    ],
    [
      "problem_description",
      fx.PROBLEM_DESCRIPTION_FILLED,
      "Water heater is leaking from the bottom and the pilot light is out",
    ],
    ["urgency", fx.URGENCY_FILLED, "SAME_DAY"],
    [
      "appointment_window",
      fx.APPOINTMENT_WINDOW_FILLED,
      {
        startsAt: "2026-07-10T13:00:00-05:00",
        endsAt: "2026-07-10T15:00:00-05:00",
      },
    ],
  ];

  it.each(cases)("fills %s", async (key, body, expected) => {
    const { extractor } = extractorOn(replay(body));
    const outcome = await extractor.extract(key, "...", CTX);

    expect(outcome.kind).toBe("filled");
    if (outcome.kind !== "filled") return;
    expect(outcome.raw).toEqual(expected);
    // The raw value is what the contract says it is, not what the model said.
    expect(SLOT_SPECS[key].extraction.safeParse(outcome.raw).success).toBe(true);
  });

  it("drops the null that stood in for an absent optional field", async () => {
    const { extractor } = extractorOn(replay(fx.SERVICE_ADDRESS_FILLED));
    const outcome = await extractor.extract("service_address", "...", CTX);

    if (outcome.kind !== "filled") throw new Error("expected filled");
    expect(outcome.raw).not.toHaveProperty("line2");
  });

  it("reads a null value as absent", async () => {
    const { extractor } = extractorOn(replay(fx.CALLER_NAME_ABSENT));
    expect(await extractor.extract("caller_name", "Uh, hi?", CTX)).toEqual({
      kind: "absent",
    });
  });

  it("reads an ambiguous answer as absent, so the machine re-asks", async () => {
    const { extractor } = extractorOn(replay(fx.APPOINTMENT_WINDOW_AMBIGUOUS));
    expect(
      await extractor.extract("appointment_window", "Tuesday or Wednesday", CTX),
    ).toEqual({ kind: "absent" });
  });

  it("fills below the read-back threshold rather than guessing again", async () => {
    const { extractor } = extractorOn(replay(fx.CALLER_NAME_LOW_CONFIDENCE));
    const outcome = await extractor.extract("caller_name", "Dana", CTX);

    if (outcome.kind !== "filled") throw new Error("expected filled");
    expect(outcome.confidence).toBeLessThan(LOW_CONFIDENCE_THRESHOLD);
  });

  it("rejects a value strict mode could not have caught", async () => {
    // `strict` guarantees the shape. `AddressInputSchema` guarantees the ZIP is
    // a ZIP. Without the second pass, `ABCDE` reaches the geocoder.
    const { extractor } = extractorOn(replay(fx.SERVICE_ADDRESS_MALFORMED));
    expect(await extractor.extract("service_address", "...", CTX)).toEqual({
      kind: "absent",
    });
  });

  it("clamps a confidence the schema can no longer bound", async () => {
    const { extractor } = extractorOn(replay(fx.URGENCY_CONFIDENCE_OUT_OF_RANGE));
    const outcome = await extractor.extract("urgency", "It's an emergency", CTX);

    if (outcome.kind !== "filled") throw new Error("expected filled");
    expect(outcome.confidence).toBe(1);
  });

  it("treats a refusal as unavailable, not as a silent caller", async () => {
    const { extractor } = extractorOn(replay(fx.REFUSAL));
    const outcome = await extractor.extract("caller_name", "Dana", CTX);

    expect(outcome.kind).toBe("unavailable");
  });
});

/* -------------------------------------------------------------------------- */
/* Outage vs. our own bug                                                      */
/* -------------------------------------------------------------------------- */

describe("failure classification", () => {
  it.each([
    [429, "rate_limit_error"],
    [500, "api_error"],
    [529, "overloaded_error"],
  ])("reports HTTP %i as unavailable", async (status, type) => {
    const { extractor } = extractorOn(() => ({ status, json: errorBody(type) }));
    const outcome = await extractor.extract("caller_name", "Dana", CTX);

    expect(outcome.kind).toBe("unavailable");
  });

  it("reports a dead socket as unavailable", async () => {
    const { extractor } = extractorOn(() => ({ throws: new Error("ECONNRESET") }));
    const outcome = await extractor.extract("caller_name", "Dana", CTX);

    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") return;
    expect(outcome.reason).toBeTruthy();
  });

  it.each([
    [400, "invalid_request_error"],
    [401, "authentication_error"],
  ])("throws on HTTP %i, because that is our bug", async (status, type) => {
    // A bad request or a missing key must crash loudly in staging, not degrade
    // into a caller being asked their name four times and then escalated.
    const { extractor } = extractorOn(() => ({ status, json: errorBody(type) }));
    await expect(extractor.extract("caller_name", "Dana", CTX)).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Prompt cache                                                                */
/* -------------------------------------------------------------------------- */

describe("prompt cache", () => {
  it("pre-warms every slot prefix, without a tool_choice", async () => {
    // Six tools means six prefixes, not one. `max_tokens: 0` is rejected
    // alongside a forced `tool_choice`; changing `tool_choice` invalidates only
    // the messages tier, so the tools + system cache survives the real request.
    const { transport, extractor } = extractorOn(replay(fx.CALLER_NAME_FILLED));
    await extractor.prewarm();

    expect(transport.requests).toHaveLength(SLOT_KEYS.length);
    for (const { body } of transport.requests) {
      expect(body.max_tokens).toBe(0);
      expect(body.tool_choice).toBeUndefined();
      expect(body.tools).toHaveLength(1);
    }
    expect(transport.requests.map((r) => r.body.tools?.[0]?.name)).toEqual(
      SLOT_KEYS.map(toolNameFor),
    );
  });

  it("survives a cold cache: warming is a cost problem, not an outage", async () => {
    const { extractor } = extractorOn(() => ({
      status: 529,
      json: errorBody("overloaded_error"),
    }));
    await expect(extractor.prewarm(["caller_name"])).resolves.toBeUndefined();
  });

  it("still throws from prewarm when the request itself is malformed", async () => {
    const { extractor } = extractorOn(() => ({
      status: 400,
      json: errorBody("invalid_request_error"),
    }));
    await expect(extractor.prewarm(["caller_name"])).rejects.toThrow();
  });

  it("surfaces cache_read_input_tokens so a cold cache is visible", async () => {
    // In CI this asserts we *report* the number; the prefix-identity test above
    // is what actually proves the cache can hit. `cache_read_input_tokens > 0`
    // against a live model belongs in the nightly eval arm — see plan.md §9.
    const { extractor, usage } = extractorOn(
      replay(fx.CALLER_NAME_FILLED, fx.CALLER_NAME_CACHE_WARM),
    );

    await extractor.extract("caller_name", "It's Dana", CTX);
    await extractor.extract("caller_name", "Dana Whitfield", CTX);

    expect(usage[0]!.cacheReadInputTokens).toBe(0);
    expect(usage[0]!.cacheCreationInputTokens).toBeGreaterThan(0);
    expect(usage[1]!.cacheReadInputTokens).toBeGreaterThan(0);
    expect(usage.map((u) => u.slot)).toEqual(["caller_name", "caller_name"]);
  });
});

/* -------------------------------------------------------------------------- */
/* FakeExtractor                                                               */
/* -------------------------------------------------------------------------- */

describe("FakeExtractor", () => {
  it("defaults an unscripted slot to absent", async () => {
    const fake = new FakeExtractor();
    expect(await fake.extract("urgency", "hello", CTX)).toEqual({ kind: "absent" });
  });

  it("repeats a single scripted outcome", async () => {
    const fake = new FakeExtractor({ caller_name: filled("Dana", 0.9) });
    expect(await fake.extract("caller_name", "a", CTX)).toEqual(filled("Dana", 0.9));
    expect(await fake.extract("caller_name", "b", CTX)).toEqual(filled("Dana", 0.9));
  });

  it("consumes a scripted sequence, then falls through to absent", async () => {
    const fake = new FakeExtractor({
      caller_name: [unavailable("503"), filled("Dana"), absent],
    });

    expect((await fake.extract("caller_name", "a", CTX)).kind).toBe("unavailable");
    expect((await fake.extract("caller_name", "b", CTX)).kind).toBe("filled");
    expect((await fake.extract("caller_name", "c", CTX)).kind).toBe("absent");
    expect((await fake.extract("caller_name", "d", CTX)).kind).toBe("absent");
  });

  it("records what it was asked", async () => {
    const fake = new FakeExtractor();
    await fake.extract("caller_name", "It's Dana", CTX);
    await fake.extract("urgency", "Right now", { callId: "call_01", turnIndex: 1 });

    expect(fake.calls).toHaveLength(2);
    expect(fake.callsFor("urgency")[0]).toEqual({
      key: "urgency",
      utterance: "Right now",
      ctx: { callId: "call_01", turnIndex: 1 },
    });
  });
});
