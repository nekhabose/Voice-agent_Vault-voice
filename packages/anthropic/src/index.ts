/**
 * @ledgerline/anthropic — the vendor boundary, shared by the three call sites
 * that cross it.
 *
 * `extraction` (call site #2), `faq` (#3), and `triage` (#5) each own their own
 * prompt, tool, and outcome type. What they must **not** each own is an opinion
 * about what a `429` means, or a private way of proving their binding without a
 * credential. Both of those are properties of the API rather than of any one
 * call site, and a port that crosses a package boundary belongs somewhere both
 * sides can see it — the same argument that moved `HttpTransport` into
 * `contracts` in Step 4.
 *
 * This package holds no prompts, no tools, and no domain types. It depends on
 * the SDK and on nothing else in the tree.
 */
export * from "./errors.js";
export * from "./testing.js";
