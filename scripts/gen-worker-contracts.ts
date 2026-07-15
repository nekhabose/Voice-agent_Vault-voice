/**
 * Write the worker's JSON Schema from the live Zod contracts.
 *
 *   npm run gen:contracts
 *
 * The output is committed. `packages/contracts/src/codegen.test.ts` fails the
 * build if it drifts from the contracts, so this is regenerated in the same
 * commit as any change to `Effect` or `PendingBooking` (plan, §12). The Pydantic
 * step (`datamodel-codegen`) reads the file this writes — see apps/agent/README.md.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { workerContractSchema } from "../packages/contracts/src/codegen.js";

const OUT = fileURLToPath(new URL("../apps/agent/contracts.schema.json", import.meta.url));

writeFileSync(OUT, `${JSON.stringify(workerContractSchema(), null, 2)}\n`);
console.log(`wrote ${OUT}`);
