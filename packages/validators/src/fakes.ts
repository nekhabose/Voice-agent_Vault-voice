import type { Address } from "@ledgerline/contracts";
import {
  formatAddress,
  type AddressInput,
  type GeocodeOutcome,
  type Geocoder,
} from "./address.js";

/**
 * In-memory geocoder. Keyed on the street line, because that is the field the
 * caller says out loud and the one ASR gets wrong.
 */
export class FakeGeocoder implements Geocoder {
  private readonly known = new Map<string, Address>();
  public calls = 0;

  constructor(private readonly mode: "normal" | "unavailable" | "throws" = "normal") {}

  /** Register an address the geocoder will resolve, with coordinates. */
  register(input: AddressInput, lat: number, lng: number): this {
    this.known.set(key(input.line1), {
      ...input,
      lat,
      lng,
      formatted: formatAddress(input),
    });
    return this;
  }

  async geocode(input: AddressInput): Promise<GeocodeOutcome> {
    this.calls += 1;

    if (this.mode === "throws") throw new Error("ECONNRESET");
    if (this.mode === "unavailable") {
      return { kind: "unavailable", reason: "geocoder returned 503" };
    }

    const found = this.known.get(key(input.line1));
    if (!found) return { kind: "not_found", reason: `no such address: ${input.line1}` };

    // A real geocoder normalises the street but carries the unit through. Losing
    // it would send the truck to the right building and the wrong door.
    if (input.line2 === undefined) return { kind: "resolved", address: found };

    const withUnit = { ...found, line2: input.line2 };
    return {
      kind: "resolved",
      address: { ...withUnit, formatted: formatAddress(withUnit) },
    };
  }
}

const key = (line1: string) => line1.trim().toLowerCase();
