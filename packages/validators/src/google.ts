import type { Address, AddressInput, HttpTransport } from "@ledgerline/contracts";
import type { GeocodeOutcome, Geocoder } from "./address.js";

/**
 * Google Address Validation, behind the `Geocoder` port (plan, task 4.7).
 *
 * **Never spoken to a live Google endpoint.** Like `AnthropicExtractor` before
 * it, this is real code against the real request and response shapes, driven in
 * tests through an injected `HttpTransport`. The bodies below are transcribed
 * from Google's documentation, not observed. See `plan.md`, Step 4.
 *
 * The port's three outcomes are not interchangeable, and mapping a status onto
 * the wrong one is the bug this file exists to avoid:
 *
 * - `resolved`     — Google placed the address on a building.
 * - `not_found`    — Google looked and there is no such address. The caller
 *                    hears the re-ask, and no truck is dispatched.
 * - `unavailable`  — we could not ask. Principle #3: an outage at Google must
 *                    not take the contractor's phone line down, and an address
 *                    we failed to *check* is unverified, not wrong. The slot is
 *                    `always`-confirm, so the caller still hears it read back.
 */

/** `https://addressvalidation.googleapis.com` in production. */
export interface GoogleGeocoderOptions {
  readonly transport: HttpTransport;
  readonly apiKey: string;
  /**
   * Google resolves to a granularity. Anything coarser than a building is a
   * street or a city, and we cannot send a van to a street.
   */
  readonly minGranularity?: GoogleGranularity;
}

/** Ordered coarse → fine, which is what makes the `>=` comparison meaningful. */
const GRANULARITY_ORDER = [
  "GRANULARITY_UNSPECIFIED",
  "OTHER",
  "BLOCK",
  "ROUTE",
  "PREMISE_PROXIMITY",
  "PREMISE",
  "SUB_PREMISE",
] as const;

export type GoogleGranularity = (typeof GRANULARITY_ORDER)[number];

const rank = (g: string): number => {
  const index = GRANULARITY_ORDER.indexOf(g as GoogleGranularity);
  return index === -1 ? 0 : index;
};

/** Retryable on Google's side, and therefore an outage rather than a verdict. */
const isOutage = (status: number): boolean => status === 429 || status >= 500;

export class GoogleGeocoder implements Geocoder {
  private readonly minGranularity: GoogleGranularity;

  constructor(private readonly options: GoogleGeocoderOptions) {
    this.minGranularity = options.minGranularity ?? "PREMISE";
  }

  async geocode(input: AddressInput): Promise<GeocodeOutcome> {
    let response;
    try {
      response = await this.options.transport.send({
        method: "POST",
        path: `/v1:validateAddress?key=${encodeURIComponent(this.options.apiKey)}`,
        body: { address: toPostalAddress(input) },
      });
    } catch (error) {
      // A dead socket is an outage. `validateAddress` catches this too, but
      // returning it here keeps the port's contract honest for direct callers.
      const reason = error instanceof Error ? error.message : String(error);
      return { kind: "unavailable", reason: `geocoder threw: ${reason}` };
    }

    if (isOutage(response.status)) {
      return { kind: "unavailable", reason: `geocoder returned ${response.status}` };
    }
    if (response.status !== 200) {
      // A 400 is a malformed request and a 403 is a bad key. Both are our bug,
      // and both must crash loudly in staging rather than degrade into a caller
      // being asked their address four times. Same rule as `packages/extraction`.
      throw new Error(`Google Address Validation rejected the request: ${response.status}`);
    }

    return parse(input, response.body, this.minGranularity);
  }
}

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                 */
/* -------------------------------------------------------------------------- */

function toPostalAddress(input: AddressInput): Record<string, unknown> {
  const lines = input.line2 ? [input.line1, input.line2] : [input.line1];
  return {
    regionCode: "US",
    addressLines: lines,
    locality: input.city,
    administrativeArea: input.state,
    postalCode: input.postalCode,
  };
}

function parse(
  input: AddressInput,
  body: unknown,
  minGranularity: GoogleGranularity,
): GeocodeOutcome {
  const result = asRecord(asRecord(body).result);
  const verdict = asRecord(result.verdict);
  const address = asRecord(result.address);

  const granularity = String(verdict.validationGranularity ?? "GRANULARITY_UNSPECIFIED");
  if (rank(granularity) < rank(minGranularity)) {
    return {
      kind: "not_found",
      reason: `Google resolved only to ${granularity}: ${input.line1}`,
    };
  }
  if (verdict.addressComplete !== true) {
    return { kind: "not_found", reason: `incomplete address: ${input.line1}` };
  }

  const formatted = address.formattedAddress;
  if (typeof formatted !== "string" || formatted === "") {
    // Granular enough to book, yet nothing to read back. We have no sentence to
    // say to the caller, and improvising one is what principle #3 forbids.
    return { kind: "unavailable", reason: "geocoder returned no formatted address" };
  }

  const location = asRecord(asRecord(result.geocode).location);
  const lat = location.latitude;
  const lng = location.longitude;

  const resolved: Address = {
    ...input,
    formatted,
    ...(typeof lat === "number" ? { lat } : {}),
    ...(typeof lng === "number" ? { lng } : {}),
  };

  // A missing coordinate is not an error: `serviceAreaGuard` treats an address
  // with no lat/lng as inside the polygon rather than turning the caller away.
  return { kind: "resolved", address: resolved };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
