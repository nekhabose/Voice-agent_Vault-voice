import type { PendingBookingPayload } from "@ledgerline/contracts";

/**
 * "TCPA constraints if we ever do outbound (we should not, initially)" (plan, Step 8).
 *
 * We do not do outbound. But "we should not" is a sentence in a plan, and the TCPA is
 * a statute with a $500–$1,500 *per message* private right of action and a plaintiffs'
 * bar that exists specifically to find companies whose good intentions were written in
 * a document rather than in their code. So this file makes the sentence a type.
 *
 * ## The only text we can send is to a number the caller gave us on their own call
 *
 * {@link TransactionalSms} is branded, and {@link transactionalSms} is the only thing
 * in the tree that can mint one. It takes a `PendingBookingPayload` and reads the
 * destination **out of it** — `booking.customer.phone`, the `callback_phone` slot,
 * which principle #3 required the caller to hear read back and confirm before the call
 * could close.
 *
 * So `SmsSender.send()` cannot be handed a number from a list, a CSV, a lead broker, or
 * a `for` loop over `tenants`. Not "must not": *cannot* — there is no expression that
 * produces a `TransactionalSms` for a number nobody dialled us from, and an outbound
 * marketing campaign is therefore a compile error rather than a policy violation.
 *
 * That is the same move as `OutcomeDeps.crm = Pick<CrmAdapter, "readJob">` (a poller
 * that cannot write) and `TriageStore.classify` (a classifier that cannot edit the
 * diff): where a rule can be carried by the type system, a comment asking nicely is the
 * weaker version of the same idea.
 *
 * ## What this deliberately does *not* build
 *
 * **No quiet-hours check.** The TCPA's 8am–9pm window governs telephone solicitations.
 * Every message this system can send is a confirmation of an appointment the recipient
 * asked for, seconds earlier, on a call *they* placed — if they phoned a plumber at
 * 2am about a burst pipe, texting them the appointment at 2:01am is the service they
 * requested. Building a quiet-hours gate we would have to bypass on exactly the calls
 * that matter most would be theatre, and theatre is worse than nothing: it teaches the
 * next reader that the constraint was considered and handled.
 */

declare const transactional: unique symbol;

/**
 * A message we are entitled to send, because the recipient is the person who called us
 * and this is the confirmation of what they asked for.
 *
 * The brand has no runtime cost and no runtime meaning. Its entire job is to make the
 * set of constructible values exactly one function wide.
 */
export interface TransactionalSms {
  /** Always `booking.customer.phone`. Never a parameter. */
  readonly to: string;
  readonly body: string;
  readonly [transactional]: "transactional";
}

/**
 * The only door.
 *
 * `to` is not an argument. That is the whole design: an argument is a thing a caller
 * chooses, and the number we text must be a thing the *caller on the phone* chose.
 */
export function transactionalSms(
  booking: PendingBookingPayload,
  body: string,
): TransactionalSms {
  // The one cast in this file, and it is what the brand costs. Confined here so that
  // every other call site has to come through the door.
  return { to: booking.customer.phone, body } as unknown as TransactionalSms;
}
