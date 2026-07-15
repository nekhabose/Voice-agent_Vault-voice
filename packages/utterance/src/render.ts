import type {
  Address,
  SlotKey,
  SlotValue,
  TimeWindow,
  Urgency,
} from "@ledgerline/contracts";
import { CATALOG, type Placeholder } from "./catalog.js";

/**
 * Turning a stored slot value into something a TTS engine says correctly.
 *
 * This is rendering, not generation. A model asked to "read back the address
 * naturally" can normalise `1247 Calle Ocho` into `1247 Southwest 8th Street`,
 * and the caller will say yes — to an address they never gave. The read-back is
 * the verification step (principle #3); a paraphrase of it verifies nothing.
 */

/** A `READ_BACK` for a slot the machine never filled. Our bug, not the caller's. */
export class MissingUtteranceValueError extends Error {
  constructor(readonly key: SlotKey) {
    super(`no value for ${key}: asked to speak a slot that was never filled`);
    this.name = "MissingUtteranceValueError";
  }
}

export class UnknownPlaceholderError extends Error {
  constructor(readonly placeholder: string) {
    super(`unknown placeholder {${placeholder}} in an utterance template`);
    this.name = "UnknownPlaceholderError";
  }
}

/**
 * Resolve `{business}` / `{value}` / `{phone}`. The only code that touches the
 * catalog's strings, which is what keeps `catalog.ts` reviewable as data.
 */
export function fill(
  template: string,
  vars: Readonly<Partial<Record<Placeholder, string>>>,
): string {
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = vars[name as Placeholder];
    if (value === undefined) throw new UnknownPlaceholderError(name);
    return value;
  });
}

/**
 * `+13055551234` → `305 555 1234`.
 *
 * Grouped, because a TTS engine handed eleven bare digits reads them as one
 * enormous number, and the caller cannot check a number they cannot parse.
 */
export function speakPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  const nanp = digits.length === 11 && digits.startsWith("1");
  if (!nanp) return digits.split("").join(" ");

  const national = digits.slice(1);
  return `${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
}

/** The geocoder's normalised single line — the thing we actually booked. */
export function speakAddress(address: Address): string {
  return address.formatted;
}

/**
 * "Thursday, July 9, between 2 PM and 6 PM", in the *tenant's* zone.
 *
 * Deliberately not shared with `confirmationBody`'s `formatWindow` in
 * `packages/workflows`: an SMS reads `2:00 PM – 6:00 PM`, and an en dash spoken
 * aloud is silence. Same input, two audiences, two renderings. The DST handling
 * is `Intl`'s in both places, so there is no logic to keep in sync.
 */
export function speakWindow(window: TimeWindow, timeZone: string): string {
  const start = new Date(window.startsAt);
  const end = new Date(window.endsAt);

  const day = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(start);

  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  // "2:00 PM" is read as "two oh oh PM". On the hour, drop the minutes.
  const time = (at: Date) => clock.format(at).replace(":00", "");

  return `${day}, between ${time(start)} and ${time(end)}`;
}

export function speakUrgency(urgency: Urgency): string {
  return CATALOG.urgency[urgency];
}

/** Dispatch on the slot key. Every slot has exactly one spoken form. */
export function speakSlot(
  key: SlotKey,
  value: SlotValue,
  timeZone: string,
): string {
  switch (key) {
    case "caller_name":
    case "problem_description":
      return value as string;
    case "callback_phone":
      return speakPhone(value as string);
    case "service_address":
      return speakAddress(value as Address);
    case "urgency":
      return speakUrgency(value as Urgency);
    case "appointment_window":
      return speakWindow(value as TimeWindow, timeZone);
  }
}
