/**
 * @ledgerline/faq — call site #3 (plan, §6).
 *
 * The one place a model speaks to the caller *about the business*, and the one
 * place it is forbidden from writing the sentence it speaks. Retrieval finds
 * candidate entries the contractor wrote; the model picks which one answers the
 * question, or picks none; `CallRuntime` speaks the chosen entry verbatim.
 *
 * Never in the audio path: the runtime says a filler first, and this package is
 * allowed to take as long as its own deadline permits (plan, §6 — "behind a
 * filler utterance").
 */
export * from "./answerer.js";
export * from "./fake.js";
export * from "./fixtures.js";
export * from "./index-memory.js";
export * from "./types.js";
