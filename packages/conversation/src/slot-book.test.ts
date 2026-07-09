import { describe, expect, it } from "vitest";
import type { Address } from "@ledgerline/contracts";
import {
  SlotBook,
  VALID,
  invalid,
  unavailable,
  type FillResult,
} from "./slot-book.js";

const ADDRESS: Address = {
  line1: "1247 Calle Ocho",
  city: "Miami",
  state: "FL",
  postalCode: "33135",
  formatted: "1247 Calle Ocho, Miami, FL 33135",
};

const WINDOW = {
  startsAt: "2026-07-09T18:00:00.000Z",
  endsAt: "2026-07-09T22:00:00.000Z",
};

/** Unwraps a fill we expect to succeed, failing loudly rather than silently. */
function ok(result: FillResult): SlotBook {
  if (!result.ok) throw new Error(`expected fill to succeed: ${result.error.message}`);
  return result.book;
}

const fillName = (book: SlotBook, name: string, confidence = 0.99) =>
  book.fill("caller_name", name, { confidence, validatorResult: VALID });

const fillPhone = (book: SlotBook, phone: string) =>
  book.fill("callback_phone", phone, { confidence: 1, validatorResult: VALID });

describe("SlotBook.fill", () => {
  it("rejects a value that does not match the slot schema", () => {
    const r = fillPhone(SlotBook.empty(), "305-555-1234");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SCHEMA_INVALID");
      expect(r.error.key).toBe("callback_phone");
    }
  });

  it("stores a schema-valid value and reports it as newly filled", () => {
    const r = fillName(SlotBook.empty(), "Rosa Delgado");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.outcome).toBe("filled");
    expect(r.book.get("caller_name")?.value).toBe("Rosa Delgado");
    expect(r.book.get("caller_name")?.revision).toBe(0);
    expect(r.book.get("caller_name")?.confirmedByCaller).toBe(false);
  });

  it("normalises values through the schema, not around it", () => {
    // caller_name is `.trim()`ed by its schema.
    const book = ok(fillName(SlotBook.empty(), "  Rosa Delgado  "));
    expect(book.get("caller_name")?.value).toBe("Rosa Delgado");
  });

  it("clamps out-of-range confidence rather than trusting the extractor", () => {
    const high = ok(fillName(SlotBook.empty(), "Rosa", 4.2));
    const low = ok(fillName(SlotBook.empty(), "Rosa", -1));
    expect(high.get("caller_name")?.confidence).toBe(1);
    expect(low.get("caller_name")?.confidence).toBe(0);
  });

  it("leaves the original book untouched", () => {
    const empty = SlotBook.empty();
    ok(fillName(empty, "Rosa"));
    expect(empty.has("caller_name")).toBe(false);
    expect(empty.filled()).toEqual([]);
  });

  it("accepts slots in any order and reports them in canonical order", () => {
    let book = SlotBook.empty();
    book = ok(book.fill("urgency", "SAME_DAY", { confidence: 0.9, validatorResult: VALID }));
    book = ok(fillName(book, "Rosa"));
    book = ok(book.fill("service_address", ADDRESS, { confidence: 0.9, validatorResult: VALID }));
    // Canonical order comes from SLOT_KEYS, not from fill order.
    expect(book.filled()).toEqual([
      "caller_name",
      "service_address",
      "urgency",
    ]);
  });
});

describe("SlotBook.fill — reaffirmation", () => {
  it("treats an identical value as corroboration, not a change", () => {
    const first = ok(fillName(SlotBook.empty(), "Rosa", 0.6));
    const r = fillName(first, "Rosa", 0.95);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.outcome).toBe("reaffirmed");
    expect(r.book.get("caller_name")?.revision).toBe(0);
  });

  it("ratchets confidence up on repetition and never back down", () => {
    let book = ok(fillName(SlotBook.empty(), "Rosa", 0.6));
    book = ok(fillName(book, "Rosa", 0.95));
    expect(book.get("caller_name")?.confidence).toBeCloseTo(0.95);
    book = ok(fillName(book, "Rosa", 0.3));
    expect(book.get("caller_name")?.confidence).toBeCloseTo(0.95);
  });

  it("preserves an existing confirmation when the caller repeats themselves", () => {
    let book = ok(fillName(SlotBook.empty(), "Rosa", 0.5));
    const c = book.confirm("caller_name");
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    book = ok(fillName(c.book, "Rosa", 0.5));
    expect(book.get("caller_name")?.confirmedByCaller).toBe(true);
  });

  it("compares object values structurally, ignoring key order", () => {
    const book = ok(
      SlotBook.empty().fill("service_address", ADDRESS, {
        confidence: 0.9,
        validatorResult: VALID,
      }),
    );
    const reordered = {
      formatted: ADDRESS.formatted,
      postalCode: ADDRESS.postalCode,
      state: ADDRESS.state,
      city: ADDRESS.city,
      line1: ADDRESS.line1,
    };
    const r = book.fill("service_address", reordered, {
      confidence: 0.9,
      validatorResult: VALID,
    });
    expect(r.ok && r.outcome).toBe("reaffirmed");
  });

  it("treats an explicitly-undefined optional field as absent", () => {
    const book = ok(
      SlotBook.empty().fill("service_address", ADDRESS, {
        confidence: 0.9,
        validatorResult: VALID,
      }),
    );
    const r = book.fill(
      "service_address",
      { ...ADDRESS, line2: undefined },
      { confidence: 0.9, validatorResult: VALID },
    );
    expect(r.ok && r.outcome).toBe("reaffirmed");
  });

  it("does not confuse a real second-line change for a reaffirmation", () => {
    const book = ok(
      SlotBook.empty().fill("service_address", ADDRESS, {
        confidence: 0.9,
        validatorResult: VALID,
      }),
    );
    const r = book.fill(
      "service_address",
      { ...ADDRESS, line2: "Apt 4" },
      { confidence: 0.9, validatorResult: VALID },
    );
    expect(r.ok && r.outcome).toBe("corrected");
  });
});

describe("SlotBook.fill — backtracking", () => {
  it("revokes confirmation when the caller changes their mind", () => {
    let book = ok(book_with_confirmed_window());
    expect(book.get("appointment_window")?.confirmedByCaller).toBe(true);

    const later = {
      startsAt: "2026-07-10T18:00:00.000Z",
      endsAt: "2026-07-10T22:00:00.000Z",
    };
    const r = book.fill("appointment_window", later, {
      confidence: 0.9,
      validatorResult: VALID,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.outcome).toBe("corrected");
    book = r.book;
    expect(book.get("appointment_window")?.confirmedByCaller).toBe(false);
    expect(book.get("appointment_window")?.revision).toBe(1);
    // And the call is no longer allowed to close.
    expect(book.allConfirmationsSatisfied()).toBe(false);
  });

  it("counts each distinct correction once", () => {
    let book = ok(fillName(SlotBook.empty(), "Rose"));
    book = ok(fillName(book, "Rosa"));
    book = ok(fillName(book, "Rosa")); // reaffirmation, not a correction
    book = ok(fillName(book, "Rosalia"));
    expect(book.get("caller_name")?.revision).toBe(2);
    expect(book.correctionCount()).toBe(2);
  });

  it("aggregates corrections across slots", () => {
    let book = ok(fillName(SlotBook.empty(), "Rose"));
    book = ok(fillName(book, "Rosa"));
    book = ok(fillPhone(book, "+13055551234"));
    book = ok(fillPhone(book, "+13055559999"));
    expect(book.correctionCount()).toBe(2);
  });

  it("starts a fresh book with zero corrections", () => {
    expect(SlotBook.empty().correctionCount()).toBe(0);
  });
});

function book_with_confirmed_window(): FillResult {
  const filled = ok(
    SlotBook.empty().fill("appointment_window", WINDOW, {
      confidence: 0.9,
      validatorResult: VALID,
    }),
  );
  const confirmed = filled.confirm("appointment_window");
  if (!confirmed.ok) throw new Error("confirm failed");
  return { ok: true, book: confirmed.book, outcome: "filled" };
}

describe("SlotBook.confirm", () => {
  it("refuses to confirm a slot that has no value", () => {
    const r = SlotBook.empty().confirm("caller_name");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SLOT_EMPTY");
  });

  it("refuses to confirm a value the validator rejected", () => {
    const book = ok(
      SlotBook.empty().fill("service_address", ADDRESS, {
        confidence: 0.9,
        validatorResult: invalid("no such street number"),
      }),
    );
    const r = book.confirm("service_address");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("VALUE_KNOWN_INVALID");
      expect(r.error.message).toContain("no such street number");
    }
  });

  it("confirms a value the validator could not reach", () => {
    const book = ok(
      SlotBook.empty().fill("service_address", ADDRESS, {
        confidence: 0.9,
        validatorResult: unavailable("geocoder timeout"),
      }),
    );
    const r = book.confirm("service_address");
    expect(r.ok).toBe(true);
  });
});

describe("SlotBook.unconfirm", () => {
  it("drops the confirmation but keeps the value for the agent to re-read", () => {
    const book = ok(book_with_confirmed_window()).unconfirm("appointment_window");
    expect(book.get("appointment_window")?.confirmedByCaller).toBe(false);
    expect(book.get("appointment_window")?.value).toEqual(WINDOW);
  });

  it("is a no-op on an unconfirmed or absent slot", () => {
    const empty = SlotBook.empty();
    expect(empty.unconfirm("caller_name")).toBe(empty);
    const filled = ok(fillName(empty, "Rosa"));
    expect(filled.unconfirm("caller_name")).toBe(filled);
  });
});

describe("SlotBook.isSatisfied", () => {
  it("is false for an absent slot", () => {
    expect(SlotBook.empty().isSatisfied("caller_name")).toBe(false);
  });

  it("is false for a value the validator rejected", () => {
    const book = ok(
      SlotBook.empty().fill("service_address", ADDRESS, {
        confidence: 0.9,
        validatorResult: invalid("outside coverage"),
      }),
    );
    expect(book.isSatisfied("service_address")).toBe(false);
  });

  it("is true when the validator was unreachable — unverified is not wrong", () => {
    const book = ok(
      SlotBook.empty().fill("service_address", ADDRESS, {
        confidence: 0.9,
        validatorResult: unavailable("geocoder 503"),
      }),
    );
    expect(book.isSatisfied("service_address")).toBe(true);
  });

  it("does not require confirmation — read-back happens later, in CONFIRM", () => {
    const book = ok(fillPhone(SlotBook.empty(), "+13055551234"));
    expect(book.needsConfirmation("callback_phone")).toBe(true);
    expect(book.isSatisfied("callback_phone")).toBe(true);
  });
});

describe("SlotBook.needsConfirmation", () => {
  it("always demands read-back for address, phone, and window", () => {
    let book = ok(fillPhone(SlotBook.empty(), "+13055551234"));
    book = ok(book.fill("service_address", ADDRESS, { confidence: 1, validatorResult: VALID }));
    book = ok(book.fill("appointment_window", WINDOW, { confidence: 1, validatorResult: VALID }));

    // Even at perfect confidence.
    expect(book.needsConfirmation("callback_phone")).toBe(true);
    expect(book.needsConfirmation("service_address")).toBe(true);
    expect(book.needsConfirmation("appointment_window")).toBe(true);
  });

  it("skips read-back for a confidently-heard name", () => {
    const book = ok(fillName(SlotBook.empty(), "Rosa", 0.99));
    expect(book.needsConfirmation("caller_name")).toBe(false);
  });

  it("demands read-back for a name heard poorly", () => {
    const book = ok(fillName(SlotBook.empty(), "Rosa", 0.42));
    expect(book.needsConfirmation("caller_name")).toBe(true);
  });

  it("treats the threshold as exclusive: exactly at it, no read-back", () => {
    const at = ok(fillName(SlotBook.empty(), "Rosa", 0.85));
    const below = ok(fillName(SlotBook.empty(), "Rosa", 0.8499));
    expect(at.needsConfirmation("caller_name")).toBe(false);
    expect(below.needsConfirmation("caller_name")).toBe(true);
  });

  it("is false for an absent slot", () => {
    expect(SlotBook.empty().needsConfirmation("service_address")).toBe(false);
  });

  it("is false once confirmed", () => {
    const book = ok(book_with_confirmed_window());
    expect(book.needsConfirmation("appointment_window")).toBe(false);
  });
});

describe("SlotBook confirmation gate", () => {
  it("passes vacuously on an empty book", () => {
    // The CONFIRM state's required-slot check, not this guard, is what stops an
    // empty call from closing.
    expect(SlotBook.empty().allConfirmationsSatisfied()).toBe(true);
  });

  it("lists pending read-backs in canonical order", () => {
    let book = ok(fillName(SlotBook.empty(), "Rosa", 0.2)); // low → needs it
    book = ok(fillPhone(book, "+13055551234")); // always
    book = ok(book.fill("urgency", "SAME_DAY", { confidence: 0.99, validatorResult: VALID }));
    expect(book.pendingConfirmations()).toEqual([
      "caller_name",
      "callback_phone",
    ]);
  });

  it("opens the gate only once every pending read-back lands", () => {
    let book = ok(fillPhone(SlotBook.empty(), "+13055551234"));
    book = ok(book.fill("service_address", ADDRESS, { confidence: 1, validatorResult: VALID }));
    expect(book.allConfirmationsSatisfied()).toBe(false);

    const a = book.confirm("callback_phone");
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.book.allConfirmationsSatisfied()).toBe(false);

    const b = a.book.confirm("service_address");
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.book.allConfirmationsSatisfied()).toBe(true);
  });
});

describe("SlotBook.toRecords", () => {
  it("emits a persistable record per filled slot, in canonical order", () => {
    let book = ok(book_with_confirmed_window());
    book = ok(fillName(book, "Rosa", 0.42));
    const records = book.toRecords();

    expect(records.map((r) => r.key)).toEqual([
      "caller_name",
      "appointment_window",
    ]);
    expect(records[0]).toMatchObject({
      key: "caller_name",
      value: "Rosa",
      confirmedByCaller: false,
      revision: 0,
    });
    expect(records[1]).toMatchObject({
      key: "appointment_window",
      confirmedByCaller: true,
    });
  });

  it("emits nothing for an empty book", () => {
    expect(SlotBook.empty().toRecords()).toEqual([]);
  });
});
