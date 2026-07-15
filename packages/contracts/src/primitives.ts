import { z } from "zod";

/**
 * Shared scalar shapes. Everything downstream — the agent worker, the booking
 * saga, the dashboard — parses through these rather than re-deriving them.
 */

/** E.164: leading `+`, country digit 1-9, up to 14 more digits. */
export const E164Schema = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, "must be E.164, e.g. +14155552671");

export const IsoTimestampSchema = z.string().datetime({ offset: true });

/**
 * Model-reported confidence for an extracted slot value.
 *
 * Slots below {@link LOW_CONFIDENCE_THRESHOLD} require caller read-back even
 * when their spec does not otherwise demand it (plan, principle #3).
 */
export const ConfidenceSchema = z.number().min(0).max(1);

export const LOW_CONFIDENCE_THRESHOLD = 0.85;

/**
 * Languages the agent commits to holding through a call. Order is the Phase 3
 * rollout order from the plan; `en` and `es` are the only ones wired today.
 */
export const LocaleSchema = z.enum(["en", "es", "hi", "tl", "vi"]);
export type Locale = z.infer<typeof LocaleSchema>;

export const UrgencySchema = z.enum([
  "ROUTINE",
  "SOON",
  "SAME_DAY",
  "EMERGENCY",
]);
export type Urgency = z.infer<typeof UrgencySchema>;

export const AddressSchema = z.object({
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().min(1),
  /** USPS two-letter state code. */
  state: z.string().length(2),
  postalCode: z.string().regex(/^\d{5}(-\d{4})?$/),
  /** Present only once the geocoder has resolved the address. */
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  /** Geocoder-normalised single-line form, used for caller read-back. */
  formatted: z.string().min(1),
});
export type Address = z.infer<typeof AddressSchema>;

/**
 * An address as the caller said it, before the geocoder has seen it.
 *
 * `lat`, `lng`, and `formatted` are absent by construction: they are the
 * geocoder's output, and principle #3 says an address is validated against a
 * geocoder rather than trusted from the transcript. A model that can emit
 * `formatted` is a model that can hallucinate a normalised address which never
 * existed, and every downstream read-back would quote it back to the caller.
 */
/**
 * **Every `.describe()` below is load-bearing, and each one is a constraint the
 * model would otherwise never see.**
 *
 * `strict` tool use cannot express `pattern`, `minLength`, or `length`, so
 * `strictify()` deletes them before the schema goes on the wire. The comment there
 * says that is not a loss, because the contract re-validates the model's output on
 * the way back in — and for *safety* that is exactly right: a ZIP of `ABCDE` is
 * rejected and never reaches the geocoder.
 *
 * For *yield* it is dead wrong, and a live model is the only thing that could have
 * shown us. `state: z.string().length(2)` reaches `claude`/`llama` as
 * `{"type": "string"}`. Asked for the address in "1247 Calle Ocho, Miami Florida,
 * 33135", the model answers `"Florida"` — which is *correct*, and which the
 * contract then rejects. The outcome is `absent`, so the agent asks for the address
 * again, and again, and escalates a caller who said it perfectly the first time.
 * The slot could **never** fill. It went unnoticed through nine Steps because the
 * fake extractor was scripted with `"FL"`.
 *
 * So the rule: **a semantic constraint that `strictify()` strips must be restated
 * in a `description`, which strict mode does carry.** Zod still has the last word;
 * the description is what gives the model a chance to earn it.
 */
export const AddressInputSchema = z.object({
  line1: z.string().min(1).describe("Street number and name, as the caller said it."),
  line2: z
    .string()
    .optional()
    .describe("Apartment, suite, or unit number. Null if the caller did not give one."),
  city: z.string().min(1).describe("City name."),
  state: z
    .string()
    .length(2)
    .describe(
      "The two-letter USPS state code, such as FL or NY. Never the full state name: a caller who says 'Miami Florida' means FL.",
    ),
  postalCode: z
    .string()
    .regex(/^\d{5}(-\d{4})?$/)
    .describe("The five-digit US ZIP code, e.g. 33135. Do not invent one the caller did not say."),
});
export type AddressInput = z.infer<typeof AddressInputSchema>;

/**
 * The other slot a live model proved could not be filled — and this one could not
 * be filled *in principle*, not merely in practice.
 *
 * An appointment window is two absolute instants. A caller says "tomorrow
 * afternoon". Nothing in `ExtractionContext` used to tell the model **what day it
 * is**, so the only honest answers were `null` (a decline, and the slot never
 * fills) or a hallucinated date (a truck on the wrong day — principle #3's exact
 * nightmare). `llama-3.3-70b` chose honesty and emitted
 * `{"startsAt": null, "endsAt": null}`, which is not even in the schema, and Groq
 * turned that into a `400 tool_use_failed`.
 *
 * `ExtractionContext` now carries `now` and `timeZone`, and the extractors render
 * them into the **user message** — never the cached prefix, which is why they were
 * not simply appended to the system prompt.
 */
export const TimeWindowSchema = z
  .object({
    startsAt: IsoTimestampSchema.describe(
      "When the window starts, as an ISO 8601 timestamp with a UTC offset, e.g. 2026-07-09T18:00:00.000Z. Resolve relative words like 'tomorrow afternoon' against the current time you were given.",
    ),
    endsAt: IsoTimestampSchema.describe(
      "When the window ends, as an ISO 8601 timestamp with a UTC offset. Must be after startsAt.",
    ),
  })
  .refine((w) => Date.parse(w.endsAt) > Date.parse(w.startsAt), {
    message: "endsAt must be after startsAt",
  });
export type TimeWindow = z.infer<typeof TimeWindowSchema>;
