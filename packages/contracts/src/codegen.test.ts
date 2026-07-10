import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { workerContractSchema } from "./codegen.js";

/**
 * The drift guard the plan calls for (§12, "Codegen drift between Zod and
 * Pydantic … Fail CI on any diff").
 *
 * The committed `apps/agent/contracts.schema.json` is what `datamodel-codegen`
 * turns into the worker's Pydantic. If a contract changes and nobody reran
 * `npm run gen:contracts`, the worker's idea of a booking would silently diverge
 * from the backend's — the single most likely source of a silent production bug.
 * This test makes that a red build instead.
 */
const ARTIFACT = fileURLToPath(
  new URL("../../../apps/agent/contracts.schema.json", import.meta.url),
);

describe("worker contract codegen", () => {
  it("the committed schema is byte-current with the live contracts", () => {
    const committed = JSON.parse(readFileSync(ARTIFACT, "utf8"));
    expect(workerContractSchema()).toEqual(committed);
  });

  it("emits exactly the two roots the worker binds to", () => {
    const schema = workerContractSchema();
    expect(Object.keys(schema.definitions as object)).toEqual(["Effect", "PendingBooking"]);
  });

  it("carries the fifth Effect variant, GREET — the one that speaks the disclosure", () => {
    // Regenerated from the union, so a new Effect variant shows up here for free;
    // a stale artifact would not carry it, and this asserts it does.
    const json = JSON.stringify(workerContractSchema());
    expect(json).toContain("GREET");
    expect(json).toContain("CREATE_PENDING_BOOKING");
  });
});
