import type { PendingBookingPayload } from "@ledgerline/contracts";
import { describe, expect, it } from "vitest";
import { transactionalSms } from "./tcpa.js";

const BOOKING: PendingBookingPayload = {
  callId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  customer: {
    name: "Rosa Peña",
    // The `callback_phone` slot: the caller said it, and heard it read back
    // (`SLOT_SPECS.callback_phone.confirm === "always"`).
    phone: "+13055551234",
    locale: "en",
  },
  address: {
    line1: "1247 Calle Ocho",
    city: "Miami",
    state: "FL",
    postalCode: "33135",
    formatted: "1247 SW 8th St, Miami, FL 33135",
  },
  window: {
    startsAt: "2026-07-09T18:00:00.000Z",
    endsAt: "2026-07-09T20:00:00.000Z",
  },
  problemDescription: "water heater stopped working",
  urgency: "SAME_DAY",
  jobTypeId: null,
};

/**
 * The TCPA constraint, as a type.
 *
 * There is no unit test that can prove a negative — "we never send an outbound marketing
 * text" is not a thing a `describe` block establishes. What establishes it is that
 * `SmsSender.send()` takes a `TransactionalSms`, and the only expression in the tree that
 * produces one reads its destination out of a `PendingBookingPayload`. The compiler is
 * the test, and it runs on every file.
 *
 * So what is left to assert here is the thing the *type* cannot say: that the number it
 * reads out is the caller's own.
 */
describe("transactionalSms", () => {
  it("addresses the message to the number the caller gave us on the call", () => {
    const message = transactionalSms(BOOKING, "Confirmed: we'll be there Thursday.");
    expect(message.to).toBe(BOOKING.customer.phone);
    expect(message.body).toBe("Confirmed: we'll be there Thursday.");
  });

  /**
   * `to` is not a parameter, and that is the entire design.
   *
   * A parameter is a thing the *caller of this function* chooses. The number we text has
   * to be a thing the *caller on the phone* chose — and made it through a read-back to
   * prove it. So the destination is read from the booking, and an outbound campaign has
   * nowhere to put a number.
   *
   * The three lines below are the real assertion, and they are commented out because they
   * do not compile. `npm run typecheck` is what runs them:
   *
   * ```ts
   * sender.send({ to: "+15551234567", body: "50% off drain cleaning!" });
   * //           ^ Property '[transactional]' is missing
   *
   * transactionalSms({ ...BOOKING, customer: { ...BOOKING.customer, phone: leadList[0] } }, body);
   * //  ^ compiles, and is the one hole: a *forged booking*. Which is why
   * //    `PendingBookingPayloadSchema` parses on the way into `commitBooking()` and the
   * //    payload comes from `buildPendingBooking()` over confirmed slots — there is no
   * //    path from a CSV to a `PendingBooking` that a call did not produce.
   * ```
   */
  it("takes the booking, not a number — so there is nowhere to put a lead list", () => {
    // Asserting the shape of the function rather than a behaviour: one argument for the
    // booking, one for the body, and no third one for a destination.
    expect(transactionalSms.length).toBe(2);
  });

  it("carries the body verbatim — we do not append a marketing footer to a confirmation", () => {
    const body = "Confirmed: we'll be at 1247 SW 8th St. Reply CANCEL to cancel.";
    expect(transactionalSms(BOOKING, body).body).toBe(body);
  });
});
