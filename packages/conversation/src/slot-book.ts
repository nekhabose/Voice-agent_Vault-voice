import {
  LOW_CONFIDENCE_THRESHOLD,
  SLOT_KEYS,
  SLOT_SPECS,
  type SlotKey,
  type SlotRecord,
  type SlotValueMap,
  type ValidatorResult,
} from "@ledgerline/contracts";
import { deepEqual } from "./equality.js";

export interface SlotEntry<K extends SlotKey = SlotKey> {
  readonly key: K;
  readonly value: SlotValueMap[K];
  readonly confidence: number;
  readonly confirmedByCaller: boolean;
  readonly validatorResult: ValidatorResult;
  /** Incremented each time the caller supplies a *different* value. */
  readonly revision: number;
}

export type FillOutcome =
  /** First time this slot was filled. */
  | "filled"
  /** Same value again — treated as corroboration, not a change. */
  | "reaffirmed"
  /** A different value replaced the old one; any confirmation was revoked. */
  | "corrected";

export type FillResult =
  | { readonly ok: true; readonly book: SlotBook; readonly outcome: FillOutcome }
  | { readonly ok: false; readonly error: SlotError };

export type ConfirmResult =
  | { readonly ok: true; readonly book: SlotBook }
  | { readonly ok: false; readonly error: SlotError };

export interface SlotError {
  readonly code:
    | "SCHEMA_INVALID"
    | "SLOT_EMPTY"
    | "VALUE_KNOWN_INVALID";
  readonly key: SlotKey;
  readonly message: string;
}

export interface FillInput {
  readonly confidence: number;
  readonly validatorResult: ValidatorResult;
}

/**
 * The set of facts established so far in a call.
 *
 * Immutable: every mutation returns a new book, so a call's slot history is a
 * list of snapshots rather than a mutable blob whose past we have to
 * reconstruct from logs.
 *
 * Two behaviours here exist because the plan names them as the difference
 * between a product and a phone tree:
 *
 *   - **Out-of-order fills.** Any slot may be filled from any turn. Real people
 *     volunteer their address before you ask for it.
 *   - **Backtracking.** Supplying a different value for an already-confirmed
 *     slot silently revokes that confirmation. A caller who changes the
 *     appointment time three turns later must re-confirm it, and the booking
 *     gate will hold the call in CONFIRM until they do.
 */
export class SlotBook {
  private constructor(
    private readonly entries: ReadonlyMap<SlotKey, SlotEntry>,
  ) {}

  static empty(): SlotBook {
    return new SlotBook(new Map());
  }

  get<K extends SlotKey>(key: K): SlotEntry<K> | undefined {
    return this.entries.get(key) as SlotEntry<K> | undefined;
  }

  has(key: SlotKey): boolean {
    return this.entries.has(key);
  }

  /** Slot keys with a value, in the canonical order declared by contracts. */
  filled(): SlotKey[] {
    return SLOT_KEYS.filter((k) => this.entries.has(k));
  }

  /**
   * Record a value for `key`, validating it against the slot's schema first so
   * a hallucinated shape never enters the book.
   */
  fill<K extends SlotKey>(key: K, value: unknown, input: FillInput): FillResult {
    const parsed = SLOT_SPECS[key].schema.safeParse(value);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "SCHEMA_INVALID",
          key,
          message: parsed.error.issues.map((i) => i.message).join("; "),
        },
      };
    }

    const clamped = Math.min(1, Math.max(0, input.confidence));
    const existing = this.entries.get(key);
    const next = new Map(this.entries);

    if (!existing) {
      next.set(key, {
        key,
        value: parsed.data,
        confidence: clamped,
        confirmedByCaller: false,
        validatorResult: input.validatorResult,
        revision: 0,
      });
      return { ok: true, book: new SlotBook(next), outcome: "filled" };
    }

    if (deepEqual(existing.value, parsed.data)) {
      // Hearing the same value twice is evidence, so confidence ratchets up
      // rather than being overwritten by a noisier second reading. An existing
      // confirmation survives — the caller did not change their mind.
      next.set(key, {
        ...existing,
        confidence: Math.max(existing.confidence, clamped),
        validatorResult: input.validatorResult,
      });
      return { ok: true, book: new SlotBook(next), outcome: "reaffirmed" };
    }

    next.set(key, {
      key,
      value: parsed.data,
      confidence: clamped,
      confirmedByCaller: false, // backtracking: the old confirmation is void
      validatorResult: input.validatorResult,
      revision: existing.revision + 1,
    });
    return { ok: true, book: new SlotBook(next), outcome: "corrected" };
  }

  /** The caller heard the value read back and agreed with it. */
  confirm(key: SlotKey): ConfirmResult {
    const existing = this.entries.get(key);
    if (!existing) {
      return {
        ok: false,
        error: { code: "SLOT_EMPTY", key, message: `${key} has no value to confirm` },
      };
    }
    if (existing.validatorResult.status === "invalid") {
      // A caller agreeing to an address the geocoder rejected does not make it
      // real. Re-ask instead.
      return {
        ok: false,
        error: {
          code: "VALUE_KNOWN_INVALID",
          key,
          message: `${key} failed validation: ${existing.validatorResult.reason}`,
        },
      };
    }
    const next = new Map(this.entries);
    next.set(key, { ...existing, confirmedByCaller: true });
    return { ok: true, book: new SlotBook(next) };
  }

  /**
   * The caller retracted a value without yet supplying a replacement
   * ("no, that's not right"). The value stays so the agent can reference it
   * while re-asking; the confirmation does not.
   */
  unconfirm(key: SlotKey): SlotBook {
    const existing = this.entries.get(key);
    if (!existing || !existing.confirmedByCaller) return this;
    const next = new Map(this.entries);
    next.set(key, { ...existing, confirmedByCaller: false });
    return new SlotBook(next);
  }

  /**
   * Present and not known-bad. This — not confirmation — is what lets the state
   * machine advance past a collection state; read-back happens later, in
   * CONFIRM.
   *
   * A slot whose validator was `unavailable` (geocoder down) counts as
   * satisfied. It is unverified, not wrong, and the `always`-confirm policy on
   * every such slot means it still gets read back before it can be committed.
   */
  isSatisfied(key: SlotKey): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && entry.validatorResult.status !== "invalid";
  }

  /** Whether this slot still owes the caller a read-back. */
  needsConfirmation(key: SlotKey): boolean {
    const entry = this.entries.get(key);
    if (!entry || entry.confirmedByCaller) return false;
    return SLOT_SPECS[key].confirmation === "always"
      ? true
      : entry.confidence < LOW_CONFIDENCE_THRESHOLD;
  }

  /** Filled slots still owing a read-back, in canonical order. */
  pendingConfirmations(): SlotKey[] {
    return this.filled().filter((k) => this.needsConfirmation(k));
  }

  /** The `all_confirmations_satisfied` guard on CONFIRM. */
  allConfirmationsSatisfied(): boolean {
    return this.pendingConfirmations().length === 0;
  }

  /**
   * Total caller corrections across the call. A high number means the agent is
   * mishearing, and it is the in-call leading indicator of the post-call
   * `outcomes.correctedFields` ground truth.
   */
  correctionCount(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.revision;
    return total;
  }

  toRecords(): SlotRecord[] {
    return this.filled().map((key) => {
      const e = this.entries.get(key)!;
      return {
        key: e.key,
        value: e.value,
        confidence: e.confidence,
        confirmedByCaller: e.confirmedByCaller,
        validatorResult: e.validatorResult,
        revision: e.revision,
      };
    });
  }
}

/** Re-exported so call-site code has one import for the slot vocabulary. */
export { VALID, invalid, unavailable } from "@ledgerline/contracts";
