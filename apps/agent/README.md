# apps/agent — the LiveKit voice worker

The call runtime, wearing a microphone. This is the Python process that owns the
audio loop (LiveKit Agents: VAD, barge-in, turn detection) and performs the
`Effect[]` the machine produces. **The brain is TypeScript** — `packages/runtime`'s
`CallRuntime` runs the state machine, the extractor, the classifier, and the
validators, and is exhaustively tested without a phone. This worker is the thin
audio binding around it (plan.md, Step 4.2/4.6 and §10.4).

## The seam

The machine decides; the audio layer is dumb (principle #1). Everything crossing
the TypeScript → Python boundary is a Zod contract, and the Pydantic the worker
performs is **generated from that Zod, never hand-written** — the worker's idea
of a booking cannot drift from the backend's (plan.md, §12 "Codegen drift").

| Effect | What the worker does (plan.md, §10.4) |
|---|---|
| `GREET` | Speak the opening + the AI disclosure **verbatim** + the invitation. This is the *first* thing a call does. |
| `ASK_FOR` | Speak the question. Arm the extractor for `key` on the next final transcript. |
| `READ_BACK` | Speak the value. Await yes/no. |
| `ESCALATE` | `WARM_TRANSFER` / `DIAL_911_GUIDANCE` → SIP REFER; `DECLINE` → courteous hang-up. |
| `CREATE_PENDING_BOOKING` | POST the `PendingBooking` to the control plane. Do **not** wait on the CRM. |

The emergency classifier runs on **every ASR partial**, in-process, before the
transcript reaches any model. `HAZARD_DETECTED` short-circuits the turn — a gas
leak does not wait on the extractor (principle #4).

## Codegen

`contracts.schema.json` is generated from the Zod contracts at the repo root:

```bash
npm run gen:contracts        # writes apps/agent/contracts.schema.json from the Zod
```

`packages/contracts/src/codegen.test.ts` fails the build if that file drifts from
the contracts, so it is regenerated in the same commit as any change to `Effect`
or `PendingBooking`. The Pydantic models are then generated from it:

```bash
cd apps/agent && npm run gen:pydantic   # datamodel-codegen → agent/contracts.py
```

`agent/contracts.py` is a build artifact. **Never hand-edit it** (plan.md, §10.4).

## What is NOT built here

Stated plainly, because a README that implies otherwise is marketing — the same
discipline the rest of this repo holds itself to.

- **No telephony.** No Twilio number, no SIP trunk, no LiveKit room. Task 4.2.
- **No realtime model.** GPT-Realtime sits behind `voice/` with a provider
  boundary its response format must not leak past. Task 4.6. `worker.py` performs
  effects against a `VoiceSession` protocol with a fake, exactly as the tested
  TypeScript `FakeVoiceSession` does.
- **Nothing here has run against a live call.** The tested seam is
  `packages/runtime`; this is its audio adapter, waiting for hardware.
- **No `Recorder`.** Step 8 added a second port beside `VoiceSession`, and the
  worker will have to implement it: `begin()` / `stop()`, and **nothing else may
  start a recording**. Which brings the one rule this repo cannot enforce for you:

  > **The carrier's own recording switch must be off.** Twilio will record from the
  > moment a call is answered if you ask it to (`record=true` on the TwiML `<Dial>`
  > or the SIP domain), and those seconds happen before the AI disclosure has been
  > spoken. `packages/compliance` decides *whether* we may record and `CallRuntime`
  > decides *when* — and both are worth nothing if the vendor started the tape first.
  > See `docs/COMPLIANCE.md` §2. This is a deployment fact, not a code guarantee, and
  > it is the only compliance rule in Step 8 with no test behind it.
- **The `contracts.py` is not committed** until the generator has run in an
  environment with `datamodel-code-generator` installed; the JSON Schema it is
  generated from *is* committed and drift-guarded.
