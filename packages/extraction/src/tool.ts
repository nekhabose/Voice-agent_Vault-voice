import { SLOT_SPECS, type SlotKey } from "@ledgerline/contracts";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * The tool the model is handed is *derived from the contract*, never written by
 * hand. Change `SLOT_SPECS[key].extraction` and the model's output space moves
 * with it, at build time, with a failing test if it cannot.
 */

/** A JSON Schema node, as far as we manipulate it. */
type Node = Record<string, unknown>;

/**
 * Keywords `strict` tool use does not implement. They are not *ignored* — a
 * schema carrying them is rejected — so they must come out before the request
 * goes anywhere.
 *
 * This is not a loss. Every one of them is a semantic constraint, and semantic
 * constraints are validated by the Zod schema on the way back in, where a
 * violation is data rather than a 400. `strict` guarantees the *shape*; the
 * contract guarantees the *meaning*.
 */
const UNSUPPORTED_KEYWORDS = [
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "$schema",
] as const;

/**
 * Rewrite a JSON Schema into the subset `strict: true` accepts:
 *
 * - every object gets `additionalProperties: false`;
 * - every property is `required`, because strict mode has no notion of an
 *   optional key. An optional property becomes nullable instead, and
 *   {@link stripNulls} removes the nulls before Zod ever sees them;
 * - unsupported constraint keywords are dropped.
 */
export function strictify(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictify);
  if (typeof schema !== "object" || schema === null) return schema;

  const node: Node = { ...(schema as Node) };
  for (const keyword of UNSUPPORTED_KEYWORDS) delete node[keyword];

  for (const branch of ["anyOf", "allOf", "oneOf"] as const) {
    if (Array.isArray(node[branch])) {
      node[branch] = (node[branch] as unknown[]).map(strictify);
    }
  }

  if (node["type"] !== "object" || typeof node["properties"] !== "object") {
    return node;
  }

  const properties = node["properties"] as Record<string, unknown>;
  const alreadyRequired = new Set(
    Array.isArray(node["required"]) ? (node["required"] as string[]) : [],
  );

  const rewritten: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    const strict = strictify(property);
    rewritten[name] = alreadyRequired.has(name) ? strict : nullable(strict);
  }

  node["properties"] = rewritten;
  node["required"] = Object.keys(rewritten);
  node["additionalProperties"] = false;
  return node;
}

/** `T | null`, preserving the description so the model still sees it. */
function nullable(schema: unknown): Node {
  const node = (typeof schema === "object" && schema !== null ? schema : {}) as Node;
  const { description, ...rest } = node;
  const union: Node = { anyOf: [rest, { type: "null" }] };
  if (typeof description === "string") union["description"] = description;
  return union;
}

/**
 * Delete `null`-valued keys, recursively.
 *
 * The round trip through nullable-and-required is lossy in exactly one way: an
 * absent optional field comes back as `null`, and Zod's `.optional()` rejects
 * `null`. Undo it here rather than loosening the contract.
 */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (typeof value !== "object" || value === null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Node)) {
    if (entry === null) continue;
    out[key] = stripNulls(entry);
  }
  return out;
}

export const toolNameFor = (key: SlotKey): string => `record_${key}`;

/** The one tool the model gets in the turn that fills `key`. */
export interface SlotTool {
  readonly name: string;
  readonly description: string;
  readonly strict: true;
  readonly input_schema: {
    readonly type: "object";
    readonly properties: Record<string, unknown>;
    /** Mutable so this stays assignable to the SDK's `Tool.InputSchema`. */
    readonly required: string[];
    readonly additionalProperties: false;
  };
}

/**
 * `null` is the model's only way to say "not in this utterance". A forced
 * `tool_choice` means it must call the tool; without a null escape it would
 * have to invent a name for a caller who never gave one.
 *
 * **The null must be all-or-nothing, and saying so out loud is load-bearing.** A
 * slot whose value is an object — `service_address`, `appointment_window` — has a
 * third move the model will reach for unprompted: fill the parts it heard and null
 * the parts it did not. That move is not in the schema (`city` is a `string`, not a
 * `string | null`), so a live `llama-3.3-70b` handed "1247 Calle Ocho." — a real
 * caller, giving a real street, in the `answers-in-fragments` scenario — tried to
 * emit `{line1: "1247 Calle Ocho", city: null, state: null, postalCode: null}` and
 * Groq rejected the whole generation with `tool_use_failed`.
 *
 * Which our own taxonomy then turned into `unavailable` → retry → **escalate to a
 * human**. So before this line existed, *every caller who gave a street without a
 * city was handed to a person*, and the fake extractor could never have told us,
 * because it was scripted with the complete address the caller never said.
 *
 * The fix is not to loosen the schema — a half-filled address is exactly what
 * principle #3 forbids reaching the geocoder. It is to tell the model that a
 * partial answer is a `null` answer, so the outcome is `absent`, so the machine
 * **asks the caller for the rest**, which is what a person would do.
 */
export function toolFor(key: SlotKey): SlotTool {
  const spec = SLOT_SPECS[key];
  const value = strictify(
    zodToJsonSchema(spec.extraction, { $refStrategy: "none" }),
  );

  return {
    name: toolNameFor(key),
    description: `Record the caller's ${spec.label} exactly as stated in this one utterance. Use null if this utterance does not state it, or states it ambiguously.`,
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        value: {
          ...nullable(value),
          description:
            `The caller's ${spec.label}, or null. ` +
            `Give a value only if this utterance states every part of it. ` +
            `If the caller stated only some of it, the whole value is null — ` +
            `never fill in a part they did not say, and never leave a part empty. ` +
            `A null costs one more question; a guess costs a truck at the wrong house.`,
        },
        confidence: {
          type: "number",
          description:
            "How confident you are, from 0 to 1, that this is what the caller said.",
        },
      },
      required: ["value", "confidence"],
      additionalProperties: false,
    },
  };
}
