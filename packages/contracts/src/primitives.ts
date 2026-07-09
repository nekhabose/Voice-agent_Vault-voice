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

export const TimeWindowSchema = z
  .object({
    startsAt: IsoTimestampSchema,
    endsAt: IsoTimestampSchema,
  })
  .refine((w) => Date.parse(w.endsAt) > Date.parse(w.startsAt), {
    message: "endsAt must be after startsAt",
  });
export type TimeWindow = z.infer<typeof TimeWindowSchema>;
