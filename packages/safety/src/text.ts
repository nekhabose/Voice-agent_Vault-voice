/**
 * Text primitives for the emergency classifier.
 *
 * Everything here is deterministic and dependency-free. The classifier must
 * keep working when the LLM is down, rate-limited, or confidently wrong, so it
 * cannot borrow the model's tokenizer or embeddings (plan, principle #4).
 */

export interface Token {
  /** Lowercased, accent-stripped. `está` → `esta`, `niño` → `nino`. */
  readonly norm: string;
  /** Offsets into the *original* string, so matches can be quoted verbatim. */
  readonly start: number;
  readonly end: number;
}

const WORD = /[\p{L}\p{N}]+/gu;
const DIACRITIC = /\p{Diacritic}/gu;

/** Accent-stripped lowercase. Spanish callers do not dictate their accents. */
export function normalize(word: string): string {
  return word.normalize("NFD").replace(DIACRITIC, "").toLowerCase();
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(WORD)) {
    const raw = m[0];
    const start = m.index;
    tokens.push({ norm: normalize(raw), start, end: start + raw.length });
  }
  return tokens;
}

/**
 * Levenshtein distance, abandoned as soon as it exceeds `max`. We only ever ask
 * "is this within one edit", so the full matrix is wasted work.
 */
export function withinEditDistance(a: string, b: string, max: number): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > max) return false;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        prev[j]! + 1, // deletion
        curr[j - 1]! + 1, // insertion
        prev[j - 1]! + cost, // substitution
      );
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    // Every remaining path can only grow, so bail out early.
    if (rowMin > max) return false;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]! <= max;
}

export const MAX_EDIT_DISTANCE = 1;

/**
 * ASR mangles word endings, so hazard terms are matched with one edit of slack.
 * How much slack depends on how much context the surrounding phrase provides.
 *
 * A **standalone** term must be five characters before we fuzz it: at four,
 * one edit turns `fire` into `hire`, and at three it turns `gas` into `has`.
 *
 * Inside a **multi-word phrase** the neighbouring tokens do the disambiguating,
 * so four characters is safe. This is what lets `gas leak` still fire when the
 * recognizer hears "gas leek" — `leak` is four characters and would otherwise
 * be matched exactly — while `has` never fires, because `gas` stays at the
 * three-character exact floor either way.
 */
export const MIN_FUZZY_LENGTH_STANDALONE = 5;
export const MIN_FUZZY_LENGTH_IN_PHRASE = 4;

/**
 * Utterance tokens that must never fuzzy-match a hazard term.
 *
 * Each entry is a collision measured against the labeled corpus, not a guess.
 * `flooring` and `floored` are each one edit from `flooding` / `flooded` and
 * are said constantly on home-services calls; without this, every hardwood job
 * pages a human at 2am.
 */
export const FUZZY_EXCLUSIONS: ReadonlySet<string> = new Set([
  "flooring",
  "floored",
]);

/** Does an utterance token match a lexicon token? */
export function tokenMatches(
  utterance: string,
  lexicon: string,
  minFuzzyLength: number = MIN_FUZZY_LENGTH_STANDALONE,
): boolean {
  if (utterance === lexicon) return true;
  if (lexicon.length < minFuzzyLength) return false;
  if (FUZZY_EXCLUSIONS.has(utterance)) return false;
  return withinEditDistance(utterance, lexicon, MAX_EDIT_DISTANCE);
}

export interface Span {
  /** Inclusive token index. */
  readonly from: number;
  /** Exclusive token index. */
  readonly to: number;
}

/**
 * Every position where `phrase` (a normalized token sequence) appears in
 * `tokens`, allowing one edit per long word.
 */
export function findPhrase(tokens: readonly Token[], phrase: readonly string[]): Span[] {
  if (phrase.length === 0 || phrase.length > tokens.length) return [];

  // Neighbouring tokens disambiguate, so a multi-word phrase earns extra slack.
  const minFuzzy =
    phrase.length >= 2 ? MIN_FUZZY_LENGTH_IN_PHRASE : MIN_FUZZY_LENGTH_STANDALONE;

  const spans: Span[] = [];
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    let hit = true;
    for (let j = 0; j < phrase.length; j++) {
      if (!tokenMatches(tokens[i + j]!.norm, phrase[j]!, minFuzzy)) {
        hit = false;
        break;
      }
    }
    if (hit) spans.push({ from: i, to: i + phrase.length });
  }
  return spans;
}
