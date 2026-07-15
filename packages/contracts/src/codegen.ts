import { zodToJsonSchema } from "zod-to-json-schema";
import { PendingBookingPayloadSchema } from "./booking.js";
import { EffectSchema } from "./effects.js";

/**
 * The two contracts that cross the TypeScript → Python language boundary, as one
 * JSON Schema document.
 *
 * `plan.md` §10.4 chooses codegen over a localhost sidecar: the Python LiveKit
 * worker performs `Effect[]` and posts a `PendingBooking`, and the Pydantic it
 * uses for both is generated from *these* Zod schemas — never hand-written, so
 * the worker's idea of a booking cannot drift from the backend's. `datamodel-
 * code-generator` reads this document and emits `apps/agent/agent/contracts.py`
 * (see that package's README).
 *
 * **Not re-exported from `index.ts` on purpose.** `zod-to-json-schema` is a
 * build-time dependency; keeping this module off the barrel keeps it out of
 * every runtime consumer's import graph. `scripts/gen-worker-contracts.ts`
 * writes the artifact, and `codegen.test.ts` fails the build if the committed
 * copy has drifted from the live contracts — which is the whole point of
 * generating rather than transcribing (plan, §12, "Codegen drift").
 */
export function workerContractSchema(): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "LedgerlineWorkerContracts",
    // `datamodel-code-generator` emits one model per entry here. `$refStrategy:
    // "none"` inlines every shared sub-schema so each root is self-contained and
    // the generated Pydantic has no dangling references.
    definitions: {
      Effect: inline(EffectSchema),
      PendingBooking: inline(PendingBookingPayloadSchema),
    },
  };
}

/** JSON Schema for one Zod type, minus the per-document `$schema` header. */
function inline(schema: Parameters<typeof zodToJsonSchema>[0]): Record<string, unknown> {
  const node = zodToJsonSchema(schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  // Belongs on the document, not on a nested definition.
  delete node.$schema;
  return node;
}
