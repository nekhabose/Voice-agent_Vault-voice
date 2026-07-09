import type { Address } from "@ledgerline/contracts";
import { accepted, rejected, unverified, type Validation } from "./types.js";

/** What the extractor heard, before anyone has checked it exists. */
export interface AddressInput {
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
}

export type GeocodeOutcome =
  | { readonly kind: "resolved"; readonly address: Address }
  | { readonly kind: "not_found"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Port for Google Address Validation, or whatever replaces it.
 *
 * Addresses are validated against a geocoder, never trusted from the
 * transcript: a hallucinated address books a truck roll to the wrong house
 * (plan, principle #3).
 */
export interface Geocoder {
  geocode(input: AddressInput): Promise<GeocodeOutcome>;
}

export function formatAddress(input: AddressInput): string {
  const street = input.line2 ? `${input.line1} ${input.line2}` : input.line1;
  return `${street}, ${input.city}, ${input.state} ${input.postalCode}`;
}

/**
 * A geocoder outage must not become an outage of the whole product, so an
 * unreachable geocoder yields `unavailable` rather than `invalid`. The address
 * slot is `always`-confirm, so the caller still hears it read back before it
 * can reach the contractor's CRM.
 */
export async function validateAddress(
  input: AddressInput,
  geocoder: Geocoder,
): Promise<Validation<Address>> {
  const fallback: Address = { ...input, formatted: formatAddress(input) };

  let outcome: GeocodeOutcome;
  try {
    outcome = await geocoder.geocode(input);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return unverified(fallback, `geocoder threw: ${reason}`);
  }

  switch (outcome.kind) {
    case "resolved":
      return accepted(outcome.address);
    case "not_found":
      return rejected(outcome.reason);
    case "unavailable":
      return unverified(fallback, outcome.reason);
  }
}
