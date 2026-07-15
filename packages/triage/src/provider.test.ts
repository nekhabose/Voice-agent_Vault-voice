import { groqClient, RecordingTransport, replay, testClient, toolCallBody } from "@ledgerline/groq";
import type { CorrectionTriager } from "@ledgerline/contracts";
import { describe, expect, it } from "vitest";
import { MISHEARD_STREET } from "./fixtures.js";
import { GroqTriager } from "./groq-triager.js";
import { TOOL_NAME } from "./triager.js";

/**
 * The port is the product, and this is the assertion that says so.
 *
 * `apps/web/lib/model-provider.ts` chooses a vendor from the environment and hands
 * `runTriage()` a `CorrectionTriager`. That file is eight lines of wiring in a Next
 * route and is not tested (nor are the other three crons — see `CLAUDE.md`). What
 * *is* worth pinning is the property the wiring depends on: **both bindings satisfy
 * the same port, and a caller holding the port cannot tell them apart.** If that
 * ever stops being true, swapping vendors stops being a one-file change and every
 * argument in this repo about ports gets quietly more expensive.
 */

describe("a caller holding the port cannot tell which vendor it has", () => {
  it("accepts either binding as a CorrectionTriager", async () => {
    const transport = new RecordingTransport(
      replay(
        toolCallBody(TOOL_NAME, {
          classification: "agent_error",
          rationale: "The street was rewritten into the form the truck needs.",
        }),
      ),
    );

    // Typed as the port, not the class. This line is the test.
    const triager: CorrectionTriager = new GroqTriager({
      client: testClient(transport),
    });

    const verdict = await triager.classify(MISHEARD_STREET);
    expect(verdict).toMatchObject({
      kind: "classified",
      classification: "agent_error",
    });
  });
});

describe("the client factory, at the edge", () => {
  // `new Groq(...)` here instead of `groqClient(...)` would 404 every call in
  // production and pass every test — the worst available combination. The factory
  // is the only thing standing between the documented base URL and that.
  it("normalises the base URL the documentation tells you to use", () => {
    const client = groqClient({
      apiKey: "gsk-test",
      baseURL: "https://api.groq.com/openai/v1",
    });
    expect(client.baseURL).toBe("https://api.groq.com");
  });
});
