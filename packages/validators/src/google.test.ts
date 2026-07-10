import { describe, expect, it } from "vitest";
import { FakeTransport, type HttpResponse } from "@ledgerline/contracts";
import { GoogleGeocoder } from "./google.js";
import type { AddressInput } from "./address.js";

/**
 * `GoogleGeocoder` has never spoken to a live Google endpoint (plan, Step 4.7,
 * verified for real at task 4.10). These bodies are transcribed from Google's
 * Address Validation documentation and driven through an injected transport, so
 * they prove the status→outcome mapping — the one bug this adapter exists to
 * avoid — rather than Google's uptime.
 */

const INPUT: AddressInput = {
  line1: "1600 Amphitheatre Pkwy",
  city: "Mountain View",
  state: "CA",
  postalCode: "94043",
};

/** A well-formed `validateAddress` response, tweakable per case. */
function body(overrides: {
  granularity?: string;
  complete?: boolean;
  formatted?: string | null;
  location?: { latitude?: number; longitude?: number } | null;
}): unknown {
  const verdict: Record<string, unknown> = {
    validationGranularity: overrides.granularity ?? "PREMISE",
    addressComplete: overrides.complete ?? true,
  };
  const address: Record<string, unknown> = {};
  if (overrides.formatted !== null) {
    address.formattedAddress = overrides.formatted ?? "1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA";
  }
  const geocode: Record<string, unknown> = {};
  if (overrides.location !== null) geocode.location = overrides.location ?? { latitude: 37.42, longitude: -122.08 };
  return { result: { verdict, address, geocode } };
}

const ok = (b: unknown): HttpResponse => ({ status: 200, body: b });

function geocoder(response: HttpResponse | (() => HttpResponse | Promise<HttpResponse>)) {
  const transport = new FakeTransport(async () =>
    typeof response === "function" ? response() : response,
  );
  return { transport, geo: new GoogleGeocoder({ transport, apiKey: "test-key" }) };
}

describe("GoogleGeocoder", () => {
  it("resolves a building-granular, complete address with coordinates", async () => {
    const { geo } = geocoder(ok(body({})));
    const outcome = await geo.geocode(INPUT);

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") throw new Error("unreachable");
    expect(outcome.address.formatted).toContain("Amphitheatre");
    expect(outcome.address.lat).toBeCloseTo(37.42);
    expect(outcome.address.lng).toBeCloseTo(-122.08);
    // The caller's own parts survive; only formatted/coords are Google's.
    expect(outcome.address.line1).toBe(INPUT.line1);
  });

  it("resolves without coordinates rather than failing — the service-area guard treats it as inside", async () => {
    const { geo } = geocoder(ok(body({ location: null })));
    const outcome = await geo.geocode(INPUT);

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") throw new Error("unreachable");
    expect(outcome.address.lat).toBeUndefined();
    expect(outcome.address.lng).toBeUndefined();
  });

  it("treats a street-level (coarser than PREMISE) resolution as not_found", async () => {
    const { geo } = geocoder(ok(body({ granularity: "ROUTE" })));
    const outcome = await geo.geocode(INPUT);
    expect(outcome.kind).toBe("not_found");
  });

  it("treats an incomplete address as not_found", async () => {
    const { geo } = geocoder(ok(body({ complete: false })));
    const outcome = await geo.geocode(INPUT);
    expect(outcome.kind).toBe("not_found");
  });

  it("is unavailable, not resolved, when there is nothing to read back", async () => {
    // Granular enough to book, but no formatted line: we have no sentence to say
    // the caller, and principle #3 forbids improvising one.
    const { geo } = geocoder(ok(body({ formatted: null })));
    const outcome = await geo.geocode(INPUT);
    expect(outcome.kind).toBe("unavailable");
  });

  it("honours a stricter minGranularity", async () => {
    const transport = new FakeTransport(async () => ok(body({ granularity: "PREMISE" })));
    const geo = new GoogleGeocoder({ transport, apiKey: "k", minGranularity: "SUB_PREMISE" });
    const outcome = await geo.geocode(INPUT);
    // PREMISE is below SUB_PREMISE, so a stricter tenant rejects it.
    expect(outcome.kind).toBe("not_found");
  });

  it("maps a 429 and a 500 to unavailable — an outage is not a verdict", async () => {
    for (const status of [429, 500, 503]) {
      const { geo } = geocoder({ status, body: null });
      const outcome = await geo.geocode(INPUT);
      expect(outcome.kind).toBe("unavailable");
    }
  });

  it("throws on a 400 or a 403 — a malformed request or a bad key is our bug", async () => {
    for (const status of [400, 403]) {
      const { geo } = geocoder({ status, body: { error: "nope" } });
      await expect(geo.geocode(INPUT)).rejects.toThrow(String(status));
    }
  });

  it("maps a dead socket to unavailable", async () => {
    const transport = new FakeTransport(async () => {
      throw new Error("ECONNRESET");
    });
    const geo = new GoogleGeocoder({ transport, apiKey: "k" });
    const outcome = await geo.geocode(INPUT);
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toContain("ECONNRESET");
  });

  it("sends US region, the address lines, and the key in the request", async () => {
    const withUnit: AddressInput = { ...INPUT, line2: "Building 40" };
    const { transport, geo } = geocoder(ok(body({})));
    await geo.geocode(withUnit);

    const request = transport.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.path).toContain("validateAddress");
    expect(request.path).toContain("key=test-key");
    const sent = request.body as { address: { regionCode: string; addressLines: string[] } };
    expect(sent.address.regionCode).toBe("US");
    // line2 rides along, or the truck finds the right building and the wrong door.
    expect(sent.address.addressLines).toEqual([withUnit.line1, "Building 40"]);
  });
});
