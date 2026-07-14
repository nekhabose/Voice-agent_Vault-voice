/**
 * @ledgerline/groq — the second vendor boundary, shaped exactly like the first.
 *
 * `@ledgerline/anthropic` exists because three call sites — `extraction` (#2),
 * `faq` (#3), and `triage` (#5) — must not each hold a private opinion about what
 * a `429` means, or a private way of proving their binding without a credential.
 * Those are properties of the *API*, not of any one call site. This package is the
 * same argument, for a second API, and it is the payment on the debt that boundary
 * was taken out against: swapping vendors touches this package and three thin
 * bindings, and nothing else in the tree changes.
 *
 * It holds three things the Anthropic boundary does not need, because the vendor
 * differs and the boundary is where a vendor difference is allowed to live:
 *
 * - a **third error category** (`errors.ts`), because on Groq a `400` can be the
 *   *model* failing to fill a schema rather than us building a bad request, and
 *   those must not share an outcome;
 * - **two structured-output modes** (`structured.ts`), because Groq's models each
 *   support exactly one and reject the other with a `400`;
 * - a **client factory** (`client.ts`), because the SDK appends `/openai/v1` to
 *   the base URL and the documented base URL already ends in it.
 *
 * It holds no prompts, no tools, and no domain types — the same rule, for the same
 * reason: the moment it knows about slots it stops being the vendor boundary and
 * becomes a second `contracts`.
 */
export * from "./client.js";
export * from "./errors.js";
export * from "./structured.js";
export * from "./testing.js";
