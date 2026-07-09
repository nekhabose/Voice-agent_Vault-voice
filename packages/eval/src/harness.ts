import { fixedClock } from "@ledgerline/contracts";
import {
  FakeGeocoder,
  serviceAreaGuard,
  weekdayHours,
  type Polygon,
} from "@ledgerline/validators";
import type { SimulationDeps } from "./simulate.js";

/** Little Havana and the surrounding blocks, in GeoJSON `[lng, lat]` order. */
export const MIAMI_SERVICE_AREA: Polygon = [
  [-80.3, 25.7],
  [-80.1, 25.7],
  [-80.1, 25.9],
  [-80.3, 25.9],
];

/** Wednesday noon UTC — the calls are scored against a fixed "now". */
export const EVAL_NOW = "2026-07-08T12:00:00.000Z";

/**
 * A tenant with one service area, weekday hours, and a geocoder that knows two
 * addresses: one inside the polygon, one in Broward County.
 */
export function evalDeps(): SimulationDeps {
  const geocoder = new FakeGeocoder()
    .register(
      { line1: "1247 Calle Ocho", city: "Miami", state: "FL", postalCode: "33135" },
      25.7651,
      -80.2197,
    )
    .register(
      {
        line1: "1500 E Las Olas Blvd",
        city: "Fort Lauderdale",
        state: "FL",
        postalCode: "33301",
      },
      26.1195,
      -80.131,
    );

  return {
    geocoder,
    serviceArea: serviceAreaGuard(MIAMI_SERVICE_AREA),
    windowPolicy: {
      clock: fixedClock(EVAL_NOW),
      timeZone: "America/New_York",
      hours: weekdayHours("08:00", "18:00"),
    },
  };
}
