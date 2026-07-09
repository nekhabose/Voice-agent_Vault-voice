import { HAZARD_ACTIONS, type HazardDetection } from "@ledgerline/contracts";
import {
  COMPILED_RULES,
  FREEZING_POINT_F,
  HAZARD_SEVERITY,
  type CompiledRule,
} from "./lexicon.js";
import { findPhrase, tokenize, type Span, type Token } from "./text.js";

/**
 * Ambient facts the runtime knows that the caller never says out loud.
 */
export interface ClassifierContext {
  /** Outdoor temperature at the service address, if known. */
  readonly outdoorTempF?: number | null;
}

const EMPTY_CONTEXT: ClassifierContext = {};

/**
 * Deterministic emergency classifier.
 *
 * Runs on every ASR partial, in parallel with and independent of the LLM. It
 * does not ask a model for permission, because false negatives here are
 * catastrophic and models are only ~95% right on a good day.
 *
 * Deliberately does **not** implement negation suppression. "There's no gas
 * leak, right?" transfers to a human. That is the correct trade: a false
 * positive costs one annoyed dispatcher, a false negative costs a house.
 */
export function classify(
  utterance: string,
  context: ClassifierContext = EMPTY_CONTEXT,
): HazardDetection | null {
  return detectAll(utterance, context)[0] ?? null;
}

/**
 * Every rule that fires, most severe first. Used for tuning and for the
 * per-rule precision numbers we report each release — `classify` acts on the
 * head of this list.
 */
export function detectAll(
  utterance: string,
  context: ClassifierContext = EMPTY_CONTEXT,
): HazardDetection[] {
  const tokens = tokenize(utterance);
  if (tokens.length === 0) return [];

  const detections: HazardDetection[] = [];

  for (const rule of COMPILED_RULES) {
    if (rule.requiresFreezing && !isFreezing(context)) continue;

    const span = matchRule(rule, tokens);
    if (!span) continue;

    detections.push({
      category: rule.category,
      action: HAZARD_ACTIONS[rule.category],
      matchedText: utterance.slice(tokens[span.from]!.start, tokens[span.to - 1]!.end),
      ruleId: rule.id,
    });
  }

  // Severity first; rule id breaks ties so the output is stable across runs.
  return detections.sort(
    (a, b) =>
      HAZARD_SEVERITY[b.category] - HAZARD_SEVERITY[a.category] ||
      a.ruleId.localeCompare(b.ruleId),
  );
}

function isFreezing(context: ClassifierContext): boolean {
  const t = context.outdoorTempF;
  return typeof t === "number" && t <= FREEZING_POINT_F;
}

/**
 * A rule matches when every group matches and the matched groups sit within
 * `withinTokens` of one another. Returns the token span covering the match, so
 * the audit trail can quote what actually fired.
 */
function matchRule(rule: CompiledRule, tokens: readonly Token[]): Span | null {
  const perGroup: Span[][] = [];

  for (const group of rule.groups) {
    const spans = group.flatMap((phrase) => findPhrase(tokens, phrase));
    if (spans.length === 0) return null;
    perGroup.push(spans);
  }

  return tightestCombination(perGroup, rule.withinTokens);
}

/**
 * Pick one span from each group so the total span is as small as possible, and
 * within the limit. Groups are few and matches per group are few, so an
 * exhaustive walk with pruning is both simplest and fastest.
 */
function tightestCombination(
  perGroup: readonly Span[][],
  withinTokens: number | undefined,
): Span | null {
  const limit = withinTokens ?? Number.POSITIVE_INFINITY;
  let best: Span | null = null;

  const walk = (index: number, from: number, to: number): void => {
    if (to - from > limit) return; // any further group can only widen the span
    if (index === perGroup.length) {
      if (!best || to - from < best.to - best.from) best = { from, to };
      return;
    }
    for (const span of perGroup[index]!) {
      walk(index + 1, Math.min(from, span.from), Math.max(to, span.to));
    }
  };

  walk(0, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY);
  return best;
}
