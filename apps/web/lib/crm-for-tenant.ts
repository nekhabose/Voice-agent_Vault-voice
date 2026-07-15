import { FetchTransport } from "@ledgerline/contracts";
import { HousecallProAdapter, JobberAdapter, type CrmAdapter } from "@ledgerline/crm";
import { tenants, type Tx } from "@ledgerline/db";
import { eq } from "drizzle-orm";

/**
 * The contractor's CRM, for the tenant this transaction is scoped to.
 *
 * The *provider* is a column (`tenants.crm_provider`), so the poller works for a Jobber
 * shop and a Housecall Pro shop without a branch anywhere above this function — which is
 * the point of `CrmAdapter` having been designed against two vendors on paper before
 * either was implemented (Step 2.1).
 *
 * ## The credential is the gap, and it is named
 *
 * `tenants.crm_credentials_enc` is a column with an encrypted token in it. There is no
 * key, no KMS, and no OAuth flow to obtain the token in the first place — Housecall Pro's
 * OAuth is task **7.5** and needs a developer account this project does not have. So the
 * token comes from the environment, which is correct for exactly one tenant and is a
 * *lie* for two.
 *
 * It is written this way on purpose rather than faked: `crmCredentialsFor()` throws with
 * the reason if the row's encrypted credential is anything but the sentinel, so the day a
 * second tenant is onboarded, the poller stops rather than quietly polling their jobs with
 * the first tenant's token. A cross-tenant CRM write would be the worst bug this system
 * could have, and it must not be reachable by forgetting to finish a task.
 */

/** The one value `crm_credentials_enc` may hold until a real vault exists. */
export const ENV_CREDENTIAL = "env";

export async function crmForTenant(tx: Tx, tenantId: string): Promise<CrmAdapter> {
  const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) throw new Error(`no tenant ${tenantId}`);

  if (tenant.crmCredentials !== ENV_CREDENTIAL) {
    throw new Error(
      `tenant ${tenantId} carries a stored CRM credential, and nothing in this tree can decrypt one. ` +
        `Per-tenant credential storage is task 7.5 (Housecall Pro OAuth) — refusing rather than ` +
        `falling back to another tenant's token from the environment.`,
    );
  }

  switch (tenant.crmProvider) {
    case "housecall_pro":
      return new HousecallProAdapter(
        new FetchTransport("https://api.housecallpro.com", {
          authorization: `Token ${required("HOUSECALL_PRO_TOKEN")}`,
        }),
      );
    case "jobber":
      return new JobberAdapter(
        new FetchTransport("https://api.getjobber.com/api/graphql", {
          authorization: `Bearer ${required("JOBBER_TOKEN")}`,
          "X-JOBBER-GRAPHQL-VERSION": "2023-11-15",
        }),
      );
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
