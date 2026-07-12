/**
 * @ledgerline/billing — per booked job, not per minute (plan, Step 7).
 *
 * Depends on `contracts` alone, and on `isAgentError` in particular: the invoice and the
 * published correction rate must not be able to disagree about whose fault a booking was.
 */
export * from "./invoice.js";
