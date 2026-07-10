import type {
  ExtractionContext,
  ExtractionOutcome,
  SlotExtractor,
  SlotKey,
} from "@ledgerline/contracts";

/** What the fake was asked, so tests assert on the collaborator's view. */
export interface ExtractionCall {
  readonly key: SlotKey;
  readonly utterance: string;
  readonly ctx: ExtractionContext;
}

export type Script = Partial<
  Record<SlotKey, ExtractionOutcome | readonly ExtractionOutcome[]>
>;

/**
 * Scripted per key, in order. A key scripted with a single outcome returns it
 * every time; a key scripted with a list consumes one per call and then falls
 * through to `absent` — which is what a real extractor does once the caller has
 * stopped saying anything new.
 *
 * `eval` binds to this rather than to `AnthropicExtractor`: a suite whose green
 * depends on a third party's uptime teaches the team to ignore red.
 */
export class FakeExtractor implements SlotExtractor {
  readonly calls: ExtractionCall[] = [];
  private readonly consumed = new Map<SlotKey, number>();

  constructor(private readonly script: Script = {}) {}

  async extract(
    key: SlotKey,
    utterance: string,
    ctx: ExtractionContext,
  ): Promise<ExtractionOutcome> {
    this.calls.push({ key, utterance, ctx });

    const scripted = this.script[key];
    if (scripted === undefined) return { kind: "absent" };
    if (!Array.isArray(scripted)) return scripted as ExtractionOutcome;

    const index = this.consumed.get(key) ?? 0;
    this.consumed.set(key, index + 1);
    return scripted[index] ?? { kind: "absent" };
  }

  /** Calls for one slot, in order, for readable assertions. */
  callsFor(key: SlotKey): ExtractionCall[] {
    return this.calls.filter((c) => c.key === key);
  }
}

export const filled = (raw: unknown, confidence = 0.95): ExtractionOutcome => ({
  kind: "filled",
  raw,
  confidence,
});

export const absent: ExtractionOutcome = { kind: "absent" };

export const unavailable = (reason: string): ExtractionOutcome => ({
  kind: "unavailable",
  reason,
});
