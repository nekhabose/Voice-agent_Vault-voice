import { describe, expect, it } from "vitest";
import type { SlotKey } from "@ledgerline/contracts";
import {
  BUILT_IN_GUARDS,
  SlotBook,
  VALID,
  initialContext,
  run,
  type MachineContext,
  type MachineEvent,
} from "@ledgerline/conversation";
import { validateAddress, formatAddress, type AddressInput } from "./address.js";
import { FakeGeocoder } from "./fakes.js";
import { pointInPolygon, serviceAreaGuard, type Polygon } from "./geo.js";
import { validatePhone } from "./phone.js";
import { parseHhMm, validateWindow, weekdayHours, zonedParts } from "./schedule.js";
import { fixedClock } from "./types.js";

/* -------------------------------------------------------------------------- */
/* Phone                                                                       */
/* -------------------------------------------------------------------------- */

describe("validatePhone", () => {
  it.each([
    ["(305) 555-1234", "+13055551234"],
    ["305.555.1234", "+13055551234"],
    ["305 555 1234", "+13055551234"],
    ["3055551234", "+13055551234"],
    ["1-305-555-1234", "+13055551234"],
    ["+1 305 555 1234", "+13055551234"],
    // Already E.164 from Twilio's caller ID — must pass through untouched.
    ["+13055551234", "+13055551234"],
  ])("normalises %s to %s", (raw, expected) => {
    const v = validatePhone(raw);
    expect(v.result.status).toBe("valid");
    expect(v.value).toBe(expected);
  });

  it("accepts an international number when the caller says the country code", () => {
    const v = validatePhone("+52 33 1234 5678");
    expect(v.result.status).toBe("valid");
    expect(v.value).toBe("+523312345678");
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["too few digits", "305 555 123"],
    ["too many digits", "3055551234567890123"],
    ["area code starting with zero", "055-555-1234"],
    ["area code starting with one", "155-555-1234"],
    ["exchange starting with one", "305-155-1234"],
    ["reserved service code", "911-555-1234"],
    ["no digits at all", "call me maybe"],
  ])("rejects %s", (_label, raw) => {
    const v = validatePhone(raw);
    expect(v.result.status).toBe("invalid");
    expect(v.value).toBeNull();
  });

  it("explains why it rejected, for the agent to re-ask intelligently", () => {
    const v = validatePhone("055-555-1234");
    expect(v.result.status === "invalid" && v.result.reason).toContain("area code");
  });

  it("uses a supplied calling code instead of assuming North America", () => {
    const v = validatePhone("3312345678", { defaultCallingCode: "52" });
    expect(v.value).toBe("+523312345678");
  });
});

/* -------------------------------------------------------------------------- */
/* Address                                                                     */
/* -------------------------------------------------------------------------- */

const INPUT: AddressInput = {
  line1: "1247 Calle Ocho",
  city: "Miami",
  state: "FL",
  postalCode: "33135",
};

describe("formatAddress", () => {
  it("renders a single line for caller read-back", () => {
    expect(formatAddress(INPUT)).toBe("1247 Calle Ocho, Miami, FL 33135");
  });

  it("folds the second line into the street", () => {
    expect(formatAddress({ ...INPUT, line2: "Apt 4" })).toBe(
      "1247 Calle Ocho Apt 4, Miami, FL 33135",
    );
  });
});

describe("validateAddress", () => {
  it("accepts and normalises an address the geocoder resolves", async () => {
    const geocoder = new FakeGeocoder().register(INPUT, 25.7651, -80.2197);
    const v = await validateAddress(INPUT, geocoder);

    expect(v.result.status).toBe("valid");
    expect(v.value?.lat).toBeCloseTo(25.7651);
    expect(v.value?.formatted).toBe("1247 Calle Ocho, Miami, FL 33135");
  });

  it("rejects an address that does not exist rather than dispatching a truck", async () => {
    const v = await validateAddress(INPUT, new FakeGeocoder());
    expect(v.result.status).toBe("invalid");
    expect(v.value).toBeNull();
  });

  it("degrades to unverified — not invalid — when the geocoder is down", async () => {
    const v = await validateAddress(INPUT, new FakeGeocoder("unavailable"));
    // An outage at Google must not take the contractor's phone line down too.
    expect(v.result.status).toBe("unavailable");
    expect(v.value?.formatted).toBe("1247 Calle Ocho, Miami, FL 33135");
    expect(v.value?.lat).toBeUndefined();
  });

  it("treats a thrown geocoder as an outage, not a crash", async () => {
    const v = await validateAddress(INPUT, new FakeGeocoder("throws"));
    expect(v.result.status).toBe("unavailable");
    expect(v.result.status === "unavailable" && v.result.reason).toContain("ECONNRESET");
    expect(v.value).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Geo                                                                         */
/* -------------------------------------------------------------------------- */

/** A square around Little Havana, in [lng, lat]. */
const SERVICE_AREA: Polygon = [
  [-80.3, 25.7],
  [-80.1, 25.7],
  [-80.1, 25.9],
  [-80.3, 25.9],
];

describe("pointInPolygon", () => {
  it("finds a point in the middle", () => {
    expect(pointInPolygon([-80.2197, 25.7651], SERVICE_AREA)).toBe(true);
  });

  it.each([
    ["west", [-80.4, 25.8]],
    ["east", [-80.0, 25.8]],
    ["south", [-80.2, 25.6]],
    ["north", [-80.2, 26.0]],
  ])("rejects a point to the %s", (_dir, point) => {
    expect(pointInPolygon(point as [number, number], SERVICE_AREA)).toBe(false);
  });

  it("counts a point on the boundary as inside", () => {
    // A contractor whose boundary runs down a street should serve that street.
    expect(pointInPolygon([-80.2, 25.7], SERVICE_AREA)).toBe(true);
    expect(pointInPolygon([-80.3, 25.8], SERVICE_AREA)).toBe(true);
  });

  it("counts a vertex as inside", () => {
    expect(pointInPolygon([-80.3, 25.7], SERVICE_AREA)).toBe(true);
  });

  it("handles a concave polygon without leaking", () => {
    // A U shape opening east; the notch is outside.
    const u: Polygon = [
      [0, 0],
      [3, 0],
      [3, 1],
      [1, 1],
      [1, 2],
      [3, 2],
      [3, 3],
      [0, 3],
    ];
    expect(pointInPolygon([0.5, 1.5], u)).toBe(true);
    expect(pointInPolygon([2, 1.5], u)).toBe(false);
  });

  it("is false for a degenerate polygon", () => {
    expect(pointInPolygon([0, 0], [])).toBe(false);
    expect(pointInPolygon([0, 0], [[0, 0], [1, 1]])).toBe(false);
  });
});

describe("serviceAreaGuard", () => {
  const guard = serviceAreaGuard(SERVICE_AREA);

  const ctxWithAddress = (lat?: number, lng?: number): MachineContext => {
    const filled = SlotBook.empty().fill(
      "service_address",
      { ...INPUT, lat, lng, formatted: formatAddress(INPUT) },
      { confidence: 1, validatorResult: VALID },
    );
    if (!filled.ok) throw new Error("fixture fill failed");
    return { ...initialContext(), slots: filled.book };
  };

  it("passes an address inside the polygon", () => {
    expect(guard(ctxWithAddress(25.7651, -80.2197))).toEqual({ kind: "pass" });
  });

  it("escalates an address outside it, rather than stalling the caller", () => {
    expect(guard(ctxWithAddress(26.5, -80.2))).toEqual({
      kind: "escalate",
      reason: "OUT_OF_SERVICE_AREA",
    });
  });

  it("passes when the geocoder was down and left no coordinates", () => {
    // Refusing to book during a geocoder outage costs the contractor every job
    // that hour; the address was still read back to the caller.
    expect(guard(ctxWithAddress(undefined, undefined))).toEqual({ kind: "pass" });
  });

  it("passes when no address has been given yet", () => {
    expect(guard(initialContext())).toEqual({ kind: "pass" });
  });

  it("drops a real out-of-area call to HANDOFF end to end", () => {
    const events: MachineEvent[] = [
      { type: "AGENT_GREETED" },
      slot("caller_name", "Rosa"),
      slot("callback_phone", "+13055551234"),
      slot("problem_description", "No hot water"),
      slot("urgency", "SAME_DAY"),
      slot("service_address", {
        ...INPUT,
        lat: 40.7128,
        lng: -74.006, // New York
        formatted: formatAddress(INPUT),
      }),
    ];
    const ctx = run(initialContext(), events, {
      guards: { ...BUILT_IN_GUARDS, address_in_service_area: guard },
    });
    expect(ctx.state).toBe("HANDOFF");
    expect(ctx.outcome).toBe("OUT_OF_SERVICE_AREA");
  });

  it("books the same call when the address is local", () => {
    const ctx = run(
      initialContext(),
      [
        { type: "AGENT_GREETED" },
        slot("caller_name", "Rosa"),
        slot("callback_phone", "+13055551234"),
        slot("problem_description", "No hot water"),
        slot("urgency", "SAME_DAY"),
        slot("service_address", {
          ...INPUT,
          lat: 25.7651,
          lng: -80.2197,
          formatted: formatAddress(INPUT),
        }),
      ],
      { guards: { ...BUILT_IN_GUARDS, address_in_service_area: guard } },
    );
    expect(ctx.state).toBe("SCHEDULE");
  });
});

function slot(key: SlotKey, value: unknown): MachineEvent {
  return {
    type: "SLOT_FILLED",
    key,
    value,
    input: { confidence: 0.99, validatorResult: VALID },
  };
}

/* -------------------------------------------------------------------------- */
/* Schedule                                                                    */
/* -------------------------------------------------------------------------- */

describe("parseHhMm", () => {
  it.each([
    ["00:00", 0],
    ["08:30", 510],
    ["23:59", 1439],
  ])("parses %s", (value, expected) => {
    expect(parseHhMm(value)).toBe(expected);
  });

  it.each(["8:00", "24:00", "08:60", "0800", ""])("throws on %s", (value) => {
    expect(() => parseHhMm(value)).toThrow();
  });
});

describe("zonedParts", () => {
  it("converts an instant into the tenant's local wall clock", () => {
    // 2026-07-09T18:00Z is 14:00 in Miami (EDT, UTC-4). Thursday.
    const p = zonedParts(new Date("2026-07-09T18:00:00.000Z"), "America/New_York");
    expect(p.dow).toBe(4);
    expect(p.minutes).toBe(14 * 60);
  });

  it("respects daylight saving", () => {
    // Same UTC hour in January is 13:00 (EST, UTC-5).
    const p = zonedParts(new Date("2026-01-08T18:00:00.000Z"), "America/New_York");
    expect(p.minutes).toBe(13 * 60);
  });

  it("handles midnight without rendering it as hour 24", () => {
    const p = zonedParts(new Date("2026-07-09T04:00:00.000Z"), "America/New_York");
    expect(p.minutes).toBe(0);
  });

  it("puts a tenant in a different zone on a different day", () => {
    const instant = new Date("2026-07-09T03:00:00.000Z");
    expect(zonedParts(instant, "America/New_York").dow).toBe(3); // Wed 23:00
    expect(zonedParts(instant, "Europe/Madrid").dow).toBe(4); // Thu 05:00
  });
});

describe("validateWindow", () => {
  const policy = {
    clock: fixedClock("2026-07-08T12:00:00.000Z"),
    timeZone: "America/New_York",
    hours: weekdayHours("08:00", "18:00"),
  };

  // Thursday 2026-07-09, 14:00–16:00 local (EDT).
  const good = {
    startsAt: "2026-07-09T18:00:00.000Z",
    endsAt: "2026-07-09T20:00:00.000Z",
  };

  it("accepts a window inside business hours", () => {
    expect(validateWindow(good, policy).result.status).toBe("valid");
  });

  it("rejects a window in the past", () => {
    const v = validateWindow(
      { startsAt: "2026-07-07T18:00:00.000Z", endsAt: "2026-07-07T20:00:00.000Z" },
      policy,
    );
    expect(v.result.status === "invalid" && v.result.reason).toContain("in the past");
  });

  it("rejects a window that gives the crew no notice", () => {
    const v = validateWindow(
      { startsAt: "2026-07-08T12:30:00.000Z", endsAt: "2026-07-08T14:30:00.000Z" },
      policy,
    );
    expect(v.result.status === "invalid" && v.result.reason).toContain("notice");
  });

  it("rejects a window too far out to be real", () => {
    const v = validateWindow(
      { startsAt: "2027-07-09T18:00:00.000Z", endsAt: "2027-07-09T20:00:00.000Z" },
      policy,
    );
    expect(v.result.status === "invalid" && v.result.reason).toContain("days out");
  });

  it("rejects a window shorter than a service call", () => {
    const v = validateWindow(
      { startsAt: "2026-07-09T18:00:00.000Z", endsAt: "2026-07-09T18:10:00.000Z" },
      policy,
    );
    expect(v.result.status === "invalid" && v.result.reason).toContain("30 minutes");
  });

  it("rejects a window that ends before it starts", () => {
    const v = validateWindow(
      { startsAt: "2026-07-09T20:00:00.000Z", endsAt: "2026-07-09T18:00:00.000Z" },
      policy,
    );
    expect(v.result.status).toBe("invalid");
  });

  it("rejects an evening window when the shop closes at six", () => {
    // 23:00–01:00 UTC is 19:00–21:00 local: after hours.
    const v = validateWindow(
      { startsAt: "2026-07-09T23:00:00.000Z", endsAt: "2026-07-10T01:00:00.000Z" },
      policy,
    );
    expect(v.result.status).toBe("invalid");
  });

  it("rejects a Sunday window when the shop is closed weekends", () => {
    // Sunday 2026-07-12, 14:00 local.
    const v = validateWindow(
      { startsAt: "2026-07-12T18:00:00.000Z", endsAt: "2026-07-12T20:00:00.000Z" },
      policy,
    );
    expect(v.result.status === "invalid" && v.result.reason).toContain("closed");
  });

  it("allows an emergency outside business hours", () => {
    const v = validateWindow(
      { startsAt: "2026-07-12T18:00:00.000Z", endsAt: "2026-07-12T20:00:00.000Z" },
      { ...policy, allowAfterHours: true },
    );
    expect(v.result.status).toBe("valid");
  });

  it("rejects a window that crosses local midnight", () => {
    const v = validateWindow(
      { startsAt: "2026-07-10T03:00:00.000Z", endsAt: "2026-07-10T05:00:00.000Z" },
      { ...policy, hours: [{ dow: 4, open: "00:00", close: "23:59" }] },
    );
    // 23:00 Thu → 01:00 Fri local.
    expect(v.result.status === "invalid" && v.result.reason).toContain("midnight");
  });

  it("rejects a nonsense timestamp", () => {
    const v = validateWindow(
      { startsAt: "not-a-date", endsAt: "2026-07-09T20:00:00.000Z" },
      policy,
    );
    expect(v.result.status).toBe("invalid");
  });

  it("respects a tenant in another timezone for the very same instant", () => {
    // The window is 14:00 local in Miami but 11:00 local in Los Angeles; both
    // are open, so both accept. Shift the LA shop's hours and it declines.
    const la = { ...policy, timeZone: "America/Los_Angeles" };
    expect(validateWindow(good, la).result.status).toBe("valid");
    expect(
      validateWindow(good, { ...la, hours: weekdayHours("12:00", "18:00") }).result.status,
    ).toBe("invalid");
  });
});
