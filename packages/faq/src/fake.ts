import type { FaqAnswerer, FaqContext, FaqOutcome } from "@ledgerline/contracts";
import type { Embedder } from "./types.js";

/** What the fake was asked, so tests assert on the collaborator's view. */
export interface FaqCall {
  readonly question: string;
  readonly ctx: FaqContext;
}

/**
 * Scripted in order, then `unknown` forever after — which is what a real FAQ does
 * once the caller has run out of questions it has answers for.
 *
 * `runtime` binds this rather than `AnthropicFaqAnswerer`, for the reason every
 * fake in this repo exists: a suite whose green depends on a third party's uptime
 * teaches the team to ignore red.
 */
export class FakeFaqAnswerer implements FaqAnswerer {
  readonly calls: FaqCall[] = [];
  private consumed = 0;

  constructor(private readonly script: readonly FaqOutcome[] = []) {}

  async answer(question: string, ctx: FaqContext): Promise<FaqOutcome> {
    this.calls.push({ question, ctx });
    return this.script[this.consumed++] ?? { kind: "unknown" };
  }
}

export const answered = (answer: string, entryId = "faq-1"): FaqOutcome => ({
  kind: "answered",
  answer,
  entryId,
});

export const unknownAnswer: FaqOutcome = { kind: "unknown" };

export const faqUnavailable = (reason: string): FaqOutcome => ({
  kind: "unavailable",
  reason,
});

/** The vector store being down. Proves an outage is not mistaken for "no answer". */
export class FailingEmbedder implements Embedder {
  constructor(private readonly error: Error) {}

  async embed(): Promise<readonly number[]> {
    throw this.error;
  }
}
