import { E164Schema } from "@ledgerline/contracts";
import { accepted, rejected, type Validation } from "./types.js";

/**
 * Normalize a spoken or typed phone number to E.164.
 *
 * The extractor's job is words-to-digits ("three oh five" → "305"). This
 * function's job is deciding whether the resulting digits could possibly be a
 * real phone number — because an SMS confirmation sent to a plausible-looking
 * hallucination is silently lost, and we would never know.
 */
export interface PhoneOptions {
  /** Country assumed when the caller does not say a country code. */
  readonly defaultCallingCode?: string;
}

const NANP_CODE = "1";
const MIN_E164_DIGITS = 8;
const MAX_E164_DIGITS = 15;

export function validatePhone(
  raw: string,
  options: PhoneOptions = {},
): Validation<string> {
  const trimmed = raw.trim();
  if (trimmed === "") return rejected("no digits heard");

  const explicitlyInternational = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits === "") return rejected("no digits heard");

  const e164 = explicitlyInternational
    ? `+${digits}`
    : localToE164(digits, options.defaultCallingCode ?? NANP_CODE);

  if (e164 === null) {
    return rejected(`${digits.length} digits is not a dialable number`);
  }

  if (!E164Schema.safeParse(e164).success) {
    return rejected(`${e164} is not a valid E.164 number`);
  }

  const nationalDigits = e164.slice(1);
  if (nationalDigits.length < MIN_E164_DIGITS) {
    return rejected(`${e164} is too short to dial`);
  }
  if (nationalDigits.length > MAX_E164_DIGITS) {
    return rejected(`${e164} is too long to dial`);
  }

  if (nationalDigits.startsWith(NANP_CODE)) {
    const problem = nanpProblem(nationalDigits.slice(1));
    if (problem) return rejected(problem);
  }

  return accepted(e164);
}

function localToE164(digits: string, callingCode: string): string | null {
  if (callingCode !== NANP_CODE) return `+${callingCode}${digits}`;

  // North America: 10 digits, or 11 with the country code the caller said out
  // of habit ("one, three oh five, ...").
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * NANP structural rules. An area code or exchange starting with 0 or 1 cannot
 * exist, and `N11` area codes are reserved for services like 911 and 411.
 */
function nanpProblem(national: string): string | null {
  if (national.length !== 10) {
    return `${national.length} digits is not a North American number`;
  }
  const npa = national.slice(0, 3);
  const nxx = national.slice(3, 6);

  if (npa[0] === "0" || npa[0] === "1") return `area code ${npa} cannot start with ${npa[0]}`;
  if (nxx[0] === "0" || nxx[0] === "1") return `exchange ${nxx} cannot start with ${nxx[0]}`;
  if (npa.slice(1) === "11") return `${npa} is a reserved service code`;

  return null;
}
