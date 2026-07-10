import type Anthropic from "@anthropic-ai/sdk";
import type {
  ExtractionOutcome,
  SlotExtractor,
  SlotKey,
} from "@ledgerline/contracts";
import {
  AnthropicExtractor,
  FakeExtractor,
  filled,
  type ExtractionUsage,
  type Script,
} from "@ledgerline/extraction";
import { DEFAULT_CONFIDENCE, type Scenario } from "./simulate.js";

/**
 * The two arms of the eval's extraction seam (plan, Step 5.1).
 *
 * The PR suite binds `FakeExtractor`, scripted from the scenario's own fills:
 * fast, deterministic, and gating every change to the conversation core. The
 * nightly arm binds the real `AnthropicExtractor` over the same port, so the
 * one thing the fake cannot prove — what `claude-sonnet-5` actually emits from a
 * caller's words — is measured against the model without a third party's uptime
 * ever deciding whether `npm test` is green (`CLAUDE.md`, testing rules).
 */

/**
 * Flatten a scenario's fills into a per-key script, in the order the harness
 * will ask for them. Each turn's fill for a key appends one `filled` outcome;
 * `FakeExtractor` consumes them in order and falls through to `absent` once a
 * caller has stopped restating that slot — which is what a real extractor does.
 *
 * The `raw` in a fill is the value the model *would* have produced; here it is
 * the fake's scripted answer. In the nightly arm the model produces it from the
 * turn's text and the `raw` is ignored — the fill still declares which slot the
 * turn states, which is all the harness needs to arm the extractor.
 */
export function scriptFromScenario(scenario: Scenario): Script {
  const script: Partial<Record<SlotKey, ExtractionOutcome[]>> = {};
  for (const turn of scenario.turns) {
    for (const fill of turn.fills ?? []) {
      (script[fill.key] ??= []).push(
        filled(fill.raw, fill.confidence ?? DEFAULT_CONFIDENCE),
      );
    }
  }
  return script;
}

/** The default PR-suite factory: a fresh fake scripted from each scenario. */
export const scriptedExtractor = (scenario: Scenario): SlotExtractor =>
  new FakeExtractor(scriptFromScenario(scenario));

/**
 * The nightly factory: one live `AnthropicExtractor` over every scenario.
 *
 * Built, not run in the PR suite — no Anthropic credential exists in this
 * environment, exactly as with the Step 1 fixtures. A CI job that has a key
 * passes a client here and swaps this in for `scriptedExtractor`; the scenario
 * argument is ignored because the model, not the script, produces the value.
 * `onUsage` is where task 5.5 asserts `cacheReadInputTokens > 0` on the second
 * request — the live prompt-cache check that cannot live in `npm test`.
 */
export function anthropicExtractor(
  client: Anthropic,
  onUsage?: (usage: ExtractionUsage) => void,
): (scenario: Scenario) => SlotExtractor {
  const extractor = new AnthropicExtractor(
    onUsage ? { client, onUsage } : { client },
  );
  return () => extractor;
}
