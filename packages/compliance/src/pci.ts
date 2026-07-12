/**
 * "PCI scope avoided entirely by never taking payment on the call" (plan, Step 8).
 *
 * That sentence is a claim about *us*, and PCI scope is not decided by us. It is
 * decided by whether cardholder data is present in our systems, and a caller who
 * says "I'll just give you my card now, it's 4111 1111 1111 1111" has put it there
 * without asking. We never ask for a card; that is not the same as never receiving
 * one, and the difference is a QSA's entire job.
 *
 * So this is the code that makes "never" true. A caller utterance is redacted
 * **before** anything else touches it — before the classifier, before the extractor,
 * before the trace, and therefore before Anthropic, before Postgres, and before the
 * contractor's CRM. `CallRuntime.hear()` and `hearPartial()` are the only two doors
 * into this system for a caller's words, and both redact on the way in.
 *
 * The one thing this cannot reach is the ASR vendor, which has already heard the
 * audio. That boundary is a contract (a DPA and, if a recording exists, its
 * retention), not a regex — and it is named in `docs/COMPLIANCE.md` rather than
 * pretended away.
 *
 * ## The trade-off runs the *opposite* way to the consent map's
 *
 * `consent.ts` errs toward caution because caution costs us only a recording. Here,
 * caution costs the *contractor*: a false positive shreds a digit string in the job
 * description that a plumber may actually need, and an over-eager redactor that eats
 * a caller's phone number is a booking nobody can act on. Both directions are real
 * damage, so the matcher is precise rather than merely aggressive:
 *
 * - **A contiguous run of 13–19 digits is always redacted.** There is no legitimate
 *   13-digit blob in a call about a leaking water heater, and requiring a Luhn check
 *   here would wave through a real card whose last digit the ASR misheard — which is
 *   still 15 of 16 digits of somebody's card, sitting in our database.
 * - **A run split by spaces or hyphens is redacted only if it is card-*shaped* (no
 *   group longer than six digits — cards group in fours, Amex 4-6-5) and passes
 *   Luhn.** Without both tests, `"3055551234 33135"` — a phone number and a ZIP,
 *   said in one breath — is fifteen digits separated by a space, and we would redact
 *   the caller's own callback number.
 */

/** What the caller's card becomes. Deliberately visible: a silent deletion is a lie. */
export const PAN_PLACEHOLDER = "[card number redacted]";

/** Card numbers are 13–19 digits (ISO/IEC 7812). Below 13 lies every phone number. */
const MIN_PAN_DIGITS = 13;
const MAX_PAN_DIGITS = 19;

/** Cards group in fours, Amex in 4-6-5. Nothing legitimate groups in tens. */
const MAX_GROUP_DIGITS = 6;

/**
 * Digits, optionally separated by single spaces or hyphens, not glued to other digits.
 *
 * The lookarounds matter: without them a 22-digit account number would have a
 * 19-digit *prefix* redacted out of the middle of it, which is both wrong and
 * unreadable.
 */
const DIGIT_RUN = /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g;

/**
 * The Luhn checksum. Every real PAN satisfies it — it is a property of the standard,
 * not a heuristic — so it has no false negatives on an *accurately transcribed* card,
 * and it is the only cheap way to tell a card from two unrelated numbers the matcher
 * glued together.
 */
export function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;

  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }

  return digits.length > 0 && sum % 10 === 0;
}

/** Would `redactPan` remove this run? Exposed so the corpus can assert both directions. */
export function looksLikePan(run: string): boolean {
  const groups = run.split(/[ -]/).filter((group) => group !== "");
  const digits = groups.join("");

  if (digits.length < MIN_PAN_DIGITS || digits.length > MAX_PAN_DIGITS) return false;
  if (groups.length === 1) return true;

  if (groups.some((group) => group.length > MAX_GROUP_DIGITS)) return false;
  return passesLuhn(digits);
}

/**
 * The caller's card number, gone, before anything else in this system sees the turn.
 *
 * Returns the text unchanged when there is nothing to redact — which is every call,
 * which is why this must be cheap and must never be the reason a turn is slow.
 */
export function redactPan(text: string): string {
  return text.replace(DIGIT_RUN, (run) => (looksLikePan(run) ? PAN_PLACEHOLDER : run));
}

/** Did we redact anything? For the compliance log: "this call reached us with a card in it." */
export function containsPan(text: string): boolean {
  return redactPan(text) !== text;
}
