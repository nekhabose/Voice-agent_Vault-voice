import type { Locale, TimeWindow } from "@ledgerline/contracts";

export interface SmsMessage {
  readonly to: string;
  readonly body: string;
}

export interface SmsSender {
  send(message: SmsMessage): Promise<void>;
}

export class FakeSms implements SmsSender {
  readonly sent: SmsMessage[] = [];

  constructor(private readonly failWith?: Error) {}

  async send(message: SmsMessage): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
  }
}

/**
 * The caller hears their own language, so they read it too.
 *
 * Only `en` and `es` are written; the remaining locales in `Locale` are Phase 3
 * and fall back to English rather than shipping machine-translated confirmations
 * that a contractor cannot proofread.
 */
const TEMPLATES: Partial<Record<Locale, (address: string, when: string) => string>> = {
  en: (address, when) =>
    `Confirmed: we'll be at ${address} on ${when}. Reply CANCEL to cancel.`,
  es: (address, when) =>
    `Confirmado: llegaremos a ${address} el ${when}. Responda CANCELAR para cancelar.`,
};

export function confirmationBody(
  locale: Locale,
  address: string,
  window: TimeWindow,
  timeZone: string,
): string {
  const template = TEMPLATES[locale] ?? TEMPLATES.en!;
  return template(address, formatWindow(window, timeZone, locale));
}

/**
 * "Thursday, July 9, 2:00 PM – 6:00 PM". Rendered in the *tenant's* timezone,
 * not the server's, because a booking that reads as the wrong day is worse than
 * no message at all.
 */
export function formatWindow(
  window: TimeWindow,
  timeZone: string,
  locale: Locale,
): string {
  const tag = locale === "es" ? "es-US" : "en-US";
  const start = new Date(window.startsAt);
  const end = new Date(window.endsAt);

  const day = new Intl.DateTimeFormat(tag, {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(start);

  const time = new Intl.DateTimeFormat(tag, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  });

  return `${day}, ${time.format(start)} – ${time.format(end)}`;
}
