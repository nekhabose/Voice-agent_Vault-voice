import type {
  BookingSink,
  EscalationReason,
  PendingBookingPayload,
  Recorder,
  SpeechOutcome,
  VoiceSession,
} from "@ledgerline/contracts";

/**
 * An audio layer that records what it was told to do instead of making noise.
 *
 * The repo's convention is ports with real fakes, never mocking frameworks:
 * tests assert on what the collaborator *saw*. `FakeVoiceSession.spoken` is the
 * transcript the caller would have heard, in order, and `transfers` / `hungUp`
 * are the two irreversible things the audio layer can do that our own code
 * cannot.
 *
 * `SpeechOutcome` is scriptable because principle #5's budgets are computed from
 * exactly those numbers, and the failure mode Full-Duplex-Bench-v3 found in the
 * *fastest* model — silence — is `{ spoke: false }`. A test that cannot script a
 * silent turn cannot prove `checkBudgets()` catches it.
 */
export class FakeVoiceSession implements VoiceSession {
  readonly spoken: string[] = [];
  readonly transfers: EscalationReason[] = [];
  hungUp = false;

  private readonly scripted: readonly SpeechOutcome[];
  private consumed = 0;

  constructor(
    private readonly options: {
      /** Returned once each, in order, before falling through to `default`. */
      readonly outcomes?: readonly SpeechOutcome[];
      readonly default?: SpeechOutcome;
    } = {},
  ) {
    this.scripted = options.outcomes ?? [];
  }

  async say(text: string): Promise<SpeechOutcome> {
    this.spoken.push(text);
    const scripted = this.scripted[this.consumed];
    if (scripted) {
      this.consumed += 1;
      return scripted;
    }
    return this.options.default ?? DEFAULT_SPEECH_OUTCOME;
  }

  async transfer(reason: EscalationReason): Promise<void> {
    this.transfers.push(reason);
  }

  async hangUp(): Promise<void> {
    this.hungUp = true;
  }
}

/**
 * A comfortable, in-budget turn: the agent spoke, did not talk over the caller,
 * first word in 300ms, whole turn in 700ms. Well under the 1.2s / 2.0s budgets,
 * so a suite that does not care about latency does not accidentally breach one.
 */
export const DEFAULT_SPEECH_OUTCOME: SpeechOutcome = {
  spoke: true,
  bargeIn: false,
  firstWordLatencyMs: 300,
  turnLatencyMs: 700,
};

/** The silence that fails turn-take: no audio, no latency to report. */
export const SILENT_SPEECH_OUTCOME: SpeechOutcome = {
  spoke: false,
  bargeIn: false,
  firstWordLatencyMs: null,
  turnLatencyMs: null,
};

/**
 * A recorder that records *when* it was told to start, rather than any audio.
 *
 * The assertion this exists to make is not "did we record" — a boolean cannot fail the
 * way this can go wrong. It is **"what had the caller heard by the time we started
 * recording them?"**, which is the compliance question stated exactly as a regulator
 * would put it. So `begin()` snapshots the transcript as it stood at that instant:
 *
 * - `[]` — the tape was rolling before we said a word. Lawful only where both ends of
 *   the call are known one-party states.
 * - `[greeting]` — the caller heard the AI disclosure, and *then* we began. The normal
 *   case, and the only one available when we cannot place the caller.
 * - `null` — `begin()` was never called. No recording exists.
 *
 * A `boolean started` would pass every one of those.
 */
export class FakeRecorder implements Recorder {
  /** The transcript as it stood when recording began. `null` = never began. */
  heardBeforeRecording: readonly string[] | null = null;
  stopped = false;

  constructor(private readonly transcript: () => readonly string[]) {}

  async begin(): Promise<void> {
    this.heardBeforeRecording = [...this.transcript()];
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

/**
 * Where a finished call posts its `PendingBooking`. Records the payloads;
 * `failWith` lets a test prove the runtime surfaces a control-plane outage
 * rather than dropping the booking on the floor.
 */
export class FakeBookingSink implements BookingSink {
  readonly submitted: PendingBookingPayload[] = [];

  constructor(private readonly failWith?: Error) {}

  async submit(payload: PendingBookingPayload): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.submitted.push(payload);
  }
}
