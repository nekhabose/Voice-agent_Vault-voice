/**
 * @ledgerline/contracts — the spine.
 *
 * Slot schemas, the state-machine definition, and the PendingBooking shape are
 * defined here exactly once. Drift between the agent's idea of a booking and
 * the backend's idea of a booking is the most likely source of silent
 * production bugs; defining them in one place eliminates it structurally.
 */
export * from "./effects.js";
export * from "./http.js";
export * from "./ports.js";
export * from "./primitives.js";
export * from "./slots.js";
export * from "./states.js";
export * from "./emergency.js";
export * from "./booking.js";
export * from "./call.js";
export * from "./faq.js";
