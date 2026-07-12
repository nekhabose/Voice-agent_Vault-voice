/**
 * The per-tenant data processing addendum (plan, Step 8).
 *
 * The contractor is the controller of their callers' personal data; we are the
 * processor. The DPA is the instrument that says so, and `docs/DPA.md` is its text.
 *
 * It is a *version*, not a boolean, because the thing a contractor consented to is a
 * document with contents. "Accepted" against a version that has since changed is not
 * acceptance of what we now do — and what changed, in practice, is the subprocessor
 * list and the retention schedule, which are exactly the two clauses a caller would
 * care about. So {@link dpaStatus} treats a stale acceptance as no acceptance, and
 * `recordingDecision()` stops recording until it is renewed.
 *
 * That is a deliberately expensive default: bumping this constant turns recording off
 * for every tenant until each re-accepts. It should be. A version bump that cost
 * nothing would be a version bump nobody read.
 */
export const DPA_VERSION = "2026-07-11";

export type DpaStatus =
  | { readonly kind: "current"; readonly version: string }
  | { readonly kind: "stale"; readonly accepted: string; readonly current: string }
  | { readonly kind: "none"; readonly current: string };

export interface TenantDpa {
  readonly dpaVersion: string | null;
}

export function dpaStatus(tenant: TenantDpa): DpaStatus {
  if (tenant.dpaVersion === null) return { kind: "none", current: DPA_VERSION };
  if (tenant.dpaVersion !== DPA_VERSION) {
    return { kind: "stale", accepted: tenant.dpaVersion, current: DPA_VERSION };
  }
  return { kind: "current", version: DPA_VERSION };
}
