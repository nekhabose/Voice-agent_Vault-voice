import type {
  CorrectionTriager,
  OutcomeClassification,
  TriageCase,
  TriageVerdict,
} from "@ledgerline/contracts";

/** What the fake was asked, so tests assert on the collaborator's view. */
export class FakeTriager implements CorrectionTriager {
  readonly cases: TriageCase[] = [];
  private consumed = 0;

  /** Scripted in order; then declines, which is the conservative default. */
  constructor(private readonly script: readonly TriageVerdict[] = []) {}

  async classify(triageCase: TriageCase): Promise<TriageVerdict> {
    this.cases.push(triageCase);
    return this.script[this.consumed++] ?? { kind: "declined", reason: "unscripted" };
  }
}

export const classified = (
  classification: OutcomeClassification,
  rationale = "because",
): TriageVerdict => ({ kind: "classified", classification, rationale });

export const declined = (reason = "not enough evidence"): TriageVerdict => ({
  kind: "declined",
  reason,
});

export const triageUnavailable = (reason = "529 overloaded"): TriageVerdict => ({
  kind: "unavailable",
  reason,
});
