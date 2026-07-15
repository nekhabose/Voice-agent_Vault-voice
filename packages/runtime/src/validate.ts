import type { SlotKey, TimeWindow } from "@ledgerline/contracts";
import { VALID } from "@ledgerline/contracts";
import {
  validateAddress,
  validatePhone,
  validateWindow,
  type AddressInput,
  type Geocoder,
  type Validation,
  type WindowPolicy,
} from "@ledgerline/validators";

/**
 * The collaborators the runtime needs to turn a raw extraction into a stored
 * fact. Ports with real fakes, exactly as everywhere else in the tree.
 */
export interface ValidationDeps {
  readonly geocoder: Geocoder;
  readonly windowPolicy: WindowPolicy;
}

/**
 * Run one slot's raw extraction through the same validators production uses.
 *
 * Three slots have a validator, three do not: `callback_phone` becomes E.164,
 * `service_address` is checked against the geocoder (never trusted from the
 * transcript — principle #3), and `appointment_window` is bounded to real
 * business hours. `caller_name`, `problem_description`, and `urgency` are stored
 * as heard, so they are `VALID` by construction.
 *
 * This is the same dispatch `packages/eval/src/simulate.ts` performs, kept here
 * rather than shared because that one also builds a `MachineEvent`, and the two
 * jobs pull apart the moment either changes. The validator set is the contract;
 * a new one shows up as a compile error in both places.
 */
export async function validateSlot(
  key: SlotKey,
  raw: unknown,
  deps: ValidationDeps,
): Promise<Validation<unknown>> {
  switch (key) {
    case "callback_phone":
      return validatePhone(String(raw));
    case "service_address":
      return validateAddress(raw as AddressInput, deps.geocoder);
    case "appointment_window":
      return validateWindow(raw as TimeWindow, deps.windowPolicy);
    default:
      return { result: VALID, value: raw };
  }
}
