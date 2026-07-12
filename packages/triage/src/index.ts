/**
 * @ledgerline/triage — call site #5 (plan, §6), the nightly pass that asks
 * whether a contractor's edit was our mistake.
 *
 * It is bound through the `CorrectionTriager` port, and `packages/workflows` runs
 * it: the batch, the store, and the rule that an unclassified correction still
 * counts against us live there, because they are the parts that must be true
 * whether or not a model is available.
 */
export * from "./fake.js";
export * from "./fixtures.js";
export * from "./triager.js";
