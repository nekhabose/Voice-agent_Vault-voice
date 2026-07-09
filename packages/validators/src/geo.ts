import type { Address } from "@ledgerline/contracts";
import { PASS, type GuardFn } from "@ledgerline/conversation";

/** `[longitude, latitude]`, matching GeoJSON's axis order. */
export type Position = readonly [number, number];

/**
 * A simple, non-self-intersecting ring. Planar point-in-polygon is accurate to
 * well under a metre across a metro-sized service area, so we do not pay for
 * geodesic math.
 */
export type Polygon = readonly Position[];

/**
 * Ray casting: count crossings of a ray heading east from the point. Odd means
 * inside.
 *
 * Vertices and edges are, by convention here, *inside* the polygon — a
 * contractor who drew their boundary down the middle of a street should serve
 * the houses on it rather than the agent turning them away.
 */
export function pointInPolygon(point: Position, polygon: Polygon): boolean {
  if (polygon.length < 3) return false;

  const [x, y] = point;
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;

    if (onSegment(point, polygon[i]!, polygon[j]!)) return true;

    const straddles = yi > y !== yj > y;
    if (straddles && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

const EPSILON = 1e-12;

function onSegment(p: Position, a: Position, b: Position): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (Math.abs(cross) > EPSILON) return false;
  return (
    Math.min(a[0], b[0]) - EPSILON <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) + EPSILON &&
    Math.min(a[1], b[1]) - EPSILON <= p[1] &&
    p[1] <= Math.max(a[1], b[1]) + EPSILON
  );
}

/**
 * The `address_in_service_area` guard, bound to one tenant's polygon.
 *
 * Escalates rather than blocks: an address outside the service area is not a
 * state we can wait our way out of, and leaving the caller stalled in QUALIFY
 * forever is the worst possible answer.
 *
 * When the geocoder was unreachable the address carries no coordinates. We let
 * the call proceed: the caller has confirmed the address out loud, and refusing
 * to book during a geocoder outage would cost the contractor every job that
 * hour. The booking is still reviewable before dispatch.
 */
export function serviceAreaGuard(polygon: Polygon): GuardFn {
  return (ctx) => {
    const entry = ctx.slots.get("service_address");
    if (!entry) return PASS;

    const address = entry.value as Address;
    if (address.lat === undefined || address.lng === undefined) return PASS;

    return pointInPolygon([address.lng, address.lat], polygon)
      ? PASS
      : { kind: "escalate", reason: "OUT_OF_SERVICE_AREA" };
  };
}
