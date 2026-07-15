/**
 * @ledgerline/utterance — everything the agent says, decided before the call.
 *
 * The catalog is generated offline, reviewed by a human, and committed
 * (plan, §10.2). `CachedUtterer` ships and performs no I/O; `LlmUtterer` is a
 * drafting tool. The AI disclosure is a verbatim string, never a runtime
 * paraphrase — a compliance requirement, not a preference.
 */
export * from "./cached.js";
export * from "./catalog.js";
export * from "./fake.js";
export * from "./llm.js";
export * from "./render.js";
