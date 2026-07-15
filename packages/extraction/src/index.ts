/**
 * @ledgerline/extraction — the only place a model reads a caller's words.
 *
 * One tool, one field, one turn (plan, §10.1). The tool schema is derived from
 * `SLOT_SPECS[key].extraction`, so the contract and the model's output space are
 * the same object, and a contract change breaks this package at build time.
 */
export * from "./extractor.js";
export * from "./fake.js";
export * from "./fixtures.js";
export * from "./tool.js";
export * from "./groq-extractor.js";
