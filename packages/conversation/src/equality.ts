/**
 * Structural equality for slot values (strings, enums, and the plain objects
 * that `Address` / `TimeWindow` parse into).
 *
 * Written out rather than reached for via `JSON.stringify` comparison, which
 * reports two identical addresses as different when the geocoder happens to
 * emit their keys in a different order.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  const ae = a as Record<string, unknown>;
  const be = b as Record<string, unknown>;

  // `undefined`-valued keys are treated as absent, so a geocoder result with an
  // explicit `line2: undefined` equals one that simply omits it.
  const keys = (o: Record<string, unknown>): string[] =>
    Object.keys(o).filter((k) => o[k] !== undefined);

  const ak = keys(ae);
  const bk = keys(be);
  if (ak.length !== bk.length) return false;

  return ak.every(
    (k) => Object.prototype.hasOwnProperty.call(be, k) && deepEqual(ae[k], be[k]),
  );
}
