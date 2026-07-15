/**
 * Who is asking, and which contractor's data they may see.
 *
 * ## The port, and why the Clerk binding is not here
 *
 * `plan.md` Step 7 says "Clerk auth". Clerk is not bound in this file, and the reason is
 * the same one that has governed every vendor in this repo since Step 1: **no credential
 * exists here, and a binding written against a wire format nobody has seen is a guess
 * wearing a green test.** `GoogleGeocoder`, the CRM adapters, and all three model call
 * sites are stubbed the same way, and each one names its gap rather than faking it.
 *
 * What *is* built is the thing that matters and that a vendor cannot give us: the seam.
 * `TenantResolver` answers exactly one question — *which tenant is this request for?* —
 * and every route funnels through it into `withTenant()`, which is where Postgres
 * row-level security takes over. The isolation guarantee lives in the database
 * (`packages/db/migrations/0002`, `rls.test.ts`), not in the identity provider, so
 * swapping Clerk for anything else changes this file and nothing below it.
 *
 * The Clerk binding is roughly:
 *
 * ```ts
 * import { auth } from "@clerk/nextjs/server";
 *
 * export const clerkTenantResolver: TenantResolver = {
 *   async resolve() {
 *     const { orgId } = await auth();          // one Clerk org == one tenant
 *     return orgId ? tenantIdForOrg(orgId) : null;
 *   },
 * };
 * ```
 *
 * — and it is task **7.6**, with a key. The mapping from a Clerk org to a `tenants.id` is
 * the only genuinely undecided part, and it is a row, not a design.
 */

/** What a resolver returns: a `tenants.id`, or `null` for "not signed in". */
export type TenantId = string;

export interface TenantResolver {
  /** `null` means unauthenticated. It never means "all tenants". */
  resolve(): Promise<TenantId | null>;
}

/**
 * The resolver until Clerk is bound: one tenant, named by the environment.
 *
 * Deliberately *not* a resolver that trusts a header or a query parameter. A
 * `?tenant=` a client could set is not a stub for auth — it is a hole, and holes have a
 * way of shipping. A single id in the server's own environment cannot be steered by a
 * request, so the worst case is that the dashboard shows the wrong contractor to a
 * developer, rather than any contractor to anyone.
 */
export function envTenantResolver(env: NodeJS.ProcessEnv = process.env): TenantResolver {
  return {
    async resolve() {
      return env.LEDGERLINE_TENANT_ID ?? null;
    },
  };
}

/** The one the app uses. Swap here when Clerk lands; nothing downstream changes. */
export const tenantResolver: TenantResolver = envTenantResolver();
