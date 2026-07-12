import type { TransactionalSms } from "@ledgerline/compliance";
import type { TimeWindow } from "@ledgerline/contracts";

/**
 * **The port takes a `TransactionalSms`, not an arbitrary `{to, body}`** (Step 8).
 *
 * That one type substitution is the TCPA constraint. `packages/compliance` brands the
 * message, and the only thing in the tree that can mint one reads the destination out
 * of a `PendingBookingPayload` — so the sole number this system is able to text is the
 * `callback_phone` a caller gave us on their own call and confirmed on a read-back.
 *
 * An outbound marketing send is therefore not a policy we have decided against. It is
 * an expression that does not typecheck, which is the same guarantee
 * `Pick<CrmAdapter, "readJob">` gives the poller and `TriageStore.classify` gives the
 * raw diff.
 */
export interface SmsSender {
  send(message: TransactionalSms): Promise<void>;
}

export class FakeSms implements SmsSender {
  readonly sent: TransactionalSms[] = [];

  constructor(private readonly failWith?: Error) {}

  async send(message: TransactionalSms): Promise<void> {
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
