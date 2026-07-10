import type { TimeWindow } from "@ledgerline/contracts";

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
 * The product is English-only. `PendingBookingPayload.customer.locale` still
 * records the caller's preferred language and still reaches the contractor's CRM,
 * so a human can call them back appropriately — but we do not send a confirmation
 * we cannot proofread.
 */
export function confirmationBody(
  address: string,
  window: TimeWindow,
  timeZone: string,
): string {
  const when = formatWindow(window, timeZone);
  return `Confirmed: we'll be at ${address} on ${when}. Reply CANCEL to cancel.`;
}

/**
 * "Thursday, July 9, 2:00 PM – 6:00 PM". Rendered in the *tenant's* timezone,
 * not the server's, because a booking that reads as the wrong day is worse than
 * no message at all.
 */
export function formatWindow(window: TimeWindow, timeZone: string): string {
  const tag = "en-US";
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
