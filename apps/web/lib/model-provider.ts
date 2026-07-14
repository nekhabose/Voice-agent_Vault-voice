import Anthropic from "@anthropic-ai/sdk";
import type { CorrectionTriager } from "@ledgerline/contracts";
import { groqClient } from "@ledgerline/groq";
import {
  AnthropicTriager,
  GroqTriager,
  GROQ_TRIAGE_MODEL,
  TRIAGE_MODEL,
} from "@ledgerline/triage";

/**
 * Which vendor, decided once, at the edge.
 *
 * Every model call site in this tree is a port, and the whole point of a port is
 * that the choice of implementation is made in exactly one place and nothing
 * upstream of it can tell. This is that place. `workflows` binds a
 * `CorrectionTriager`; it does not know a vendor exists.
 *
 * The failure mode this guards against is not a wrong answer — it is a *silent*
 * one. A missing key must be a `500`, never a fallback to the other vendor and
 * never a no-op: a triage pass that "succeeded" having classified nothing is
 * indistinguishable, on a dashboard, from a night with no corrections. And since
 * an unclassified correction counts as an agent error (principle #5) and an agent
 * error is a booking we waive (principle #7), a quietly-degraded triage run costs
 * us **money**. It must be loud.
 */

export type ModelProvider = "anthropic" | "groq";

/**
 * `MODEL_PROVIDER`, defaulting to Groq — because a Groq credential is the one that
 * exists. An unrecognised value is a **throw**, not a default: a typo in a deploy
 * variable silently routing every call to the wrong vendor is precisely the class
 * of bug that costs a week to find.
 */
export function modelProvider(raw = process.env.MODEL_PROVIDER): ModelProvider {
  const value = (raw ?? "groq").trim().toLowerCase();
  if (value === "anthropic" || value === "groq") return value;
  throw new Error(
    `MODEL_PROVIDER must be "anthropic" or "groq", not ${JSON.stringify(raw)}`,
  );
}

export interface TriagerBinding {
  readonly triager: CorrectionTriager;
  /** Recorded on every verdict, so a re-triage can be told from a re-run. */
  readonly model: string;
}

/**
 * The bound triager, or a reason nobody can mistake for a quiet night.
 *
 * Returns a `string` rather than throwing on a missing key so the route can turn
 * it into a `500` with the variable's name in it. The one thing it will not do is
 * return something that runs.
 */
export function triagerFor(provider: ModelProvider = modelProvider()): TriagerBinding | string {
  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return "ANTHROPIC_API_KEY is not set";
    return {
      triager: new AnthropicTriager({ client: new Anthropic({ apiKey }) }),
      model: process.env.ANTHROPIC_TRIAGE_MODEL ?? TRIAGE_MODEL,
    };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return "GROQ_API_KEY is not set";

  // `groqClient` — never `new Groq(...)` — because the SDK appends `/openai/v1`
  // to the base URL and the documented base URL already ends in it. Constructing
  // the client directly here would 404 every call in production and pass every
  // test, which is the worst available combination.
  const model = process.env.GROQ_TRIAGE_MODEL ?? GROQ_TRIAGE_MODEL;
  return { triager: new GroqTriager({ client: groqClient({ apiKey }), model }), model };
}
