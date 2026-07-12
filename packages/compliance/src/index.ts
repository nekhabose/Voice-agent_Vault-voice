/**
 * @ledgerline/compliance — the rules a lawyer reads, as code that cannot be violated.
 *
 * Step 8 of `plan.md` is described there as gating *launch* rather than code, and every
 * line of it could have been a policy document. It is not one, because a policy
 * document is a thing you are found to have breached, and this repo's whole argument —
 * RLS over a `WHERE` clause, `Pick<CrmAdapter, "readJob">` over a code review, an
 * unclassified correction counting against us — is that a rule worth having is a rule
 * the system cannot break.
 *
 * So:
 *
 * - The AI disclosure is a **versioned string** here, quoted by the catalog, and
 *   `auditDisclosure()` scores whether real callers really heard it, verbatim.
 * - The consent regime is a **map with a conservative default**, and no branch through
 *   it turns ignorance into a recording.
 * - `TransactionalSms` is a **branded type**, so an outbound campaign does not compile.
 * - `redactPan()` runs **before the extractor**, so "we never take payment" survives a
 *   caller who reads out their card anyway.
 * - The retention windows are **constants the deletion cron reads**, and the deletion
 *   cron holds no privilege that could reach the published number's evidence.
 *
 * Depends on `contracts` alone. Nothing here knows about a database, a phone, or a
 * model — this package is a set of rules, and the packages that must obey them are the
 * ones that import it (`runtime`, `utterance`, `workflows`, `web`).
 */
export * from "./archive.js";
export * from "./consent.js";
export * from "./disclosure.js";
export * from "./dpa.js";
export * from "./pci.js";
export * from "./recording.js";
export * from "./tcpa.js";
