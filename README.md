<div align="center">

# Ledgerline

**Every call answered. Every job booked.**

An inbound-call voice agent for US home-services contractors — Spanish-first,
built to work on models that fail the benchmark.

[![tests](https://img.shields.io/badge/tests-384_passing-1a7a47)](#verification)
[![coverage](https://img.shields.io/badge/coverage-98.8%25-1a7a47)](#verification)
[![typecheck](https://img.shields.io/badge/typecheck-strict-0f6d68)](#verification)
[![emergency recall](https://img.shields.io/badge/emergency_recall-1.00-b3261e)](#the-emergency-classifier-does-not-ask-a-model-for-permission)

</div>

---

## The problem

A missed call at a plumbing shop is a lost job worth hundreds of dollars. The
obvious fix — put a voice AI on the phone — runs straight into a wall that the
research is blunt about:

> The best ASR→LLM pipeline fills tool-call parameters correctly **~60.6%** of the
> time in English. Sequential, multi-step workflows collapse to **5–15%**.
> Multilingual drops that 60.6% to **~39.2%**.
> — [VoiceAgentBench](https://arxiv.org/pdf/2510.07978)

Meanwhile latency and turn-taking trade against each other badly: the *fastest*
model in [Full-Duplex-Bench-v3](https://arxiv.org/pdf/2604.04847) had the *worst*
turn-take rate, giving no response at all in 22 of 100 scenarios.

Anyone building an open-ended conversational agent walks into that wall.

## The idea

**A missed call is expensive, and the conversation needed to capture it is
bounded.** Name, address, problem, urgency, time window. That is a form with five
fields and a decision tree — not an open-ended dialogue.

So we never ask the model to do the thing it fails at:

|                          | Typical agent                          | Ledgerline                                             |
| ------------------------ | -------------------------------------- | ------------------------------------------------------ |
| Who drives the conversation | The model plans and chains tool calls | A **state machine**; our code advances it on validated slots |
| Per turn                 | Pick a tool from a menu                | Extract **one field**                                  |
| Booking the job          | Model orchestrates 4 API calls         | A **deterministic transaction**, after the call, with rollback |
| Emergencies              | Ask the model if it sounds urgent      | A **deterministic classifier** that never consults a model |
| Reliability claims       | Asserted                               | **Measured** — including the bookings you had to fix    |

A 14.8%-reliable agentic task becomes a five-field extraction task plus a database
transaction. That reframing is the entire product.

The wedge is **multilingual US metro trades**: Spanish-first, for the
immigrant-owned and immigrant-serving contractor market that incumbents skip.
Code-switching mid-call — *"Hola, uh, my water heater está leaking"* — is the
normal case, not the edge case.

---

## Quickstart

```bash
npm install
npm run check          # typecheck + 384 tests
```

Run the contractor dashboard:

```bash
cd apps/web && npm run dev   # http://localhost:3000
```

No API keys, no database, no telephony account. The domain core is pure and the
dashboard is seeded from data typed against the real contracts.

---

## The dashboard

A dispatcher glances at this between calls and needs exactly one answer: **does
anything need me?** So the page is ordered by that question, and colour is spent
almost entirely on state rather than decoration.

```
  10 of 13 calls booked themselves today. 1 needs you.
  ┌──────────────────────────────────────────────────────────┐
  │ ● GAS LEAK   Unknown caller                       2:38 PM│  ← the only thing
  │              Emergency — transferred to a human          │     that shouts
  └──────────────────────────────────────────────────────────┘

  In progress                                        ● Spanish
  Rosa Delgado · Water heater leaking into the garage
  ●───────●───────●───────●───────◉ ─ ─ ─ ○ ─ ─ ─ ○
  GREETING IDENTIFY TRIAGE QUALIFY SCHEDULE CONFIRM CLOSE

  ┌──────────────┬──────────────┬──────────────┬──────────────┐
  │ Booked w/o   │ Bookings you │ Time to first│ Answered when│
  │ a human      │ had to fix   │ word (p95)   │ spoken to    │
  │     77%      │     10%      │    1.00s     │     98%      │
  └──────────────┴──────────────┴──────────────┴──────────────┘
```

A live call renders as the **actual state graph**, walked from the machine
definition — the clearest available explanation of how the product works, and a
dispatcher can see exactly where a call has got to.

Every number is computed by `@ledgerline/telemetry` from call records. None is
typed into the page. *"Bookings you had to fix"* is red whenever it is above zero,
because a correction is a real failure.

Open a call and you see the transcript beside what was captured: per-slot
confidence, a checkmark when the caller heard it read back, and any value the
caller corrected shown struck through.

---

## How it works

```
   Twilio ──► LiveKit ──► agent worker              ┌─ not built yet ─┐
                              │                      └────────────────┘
                              ▼
                     ┌─────────────────┐
   ASR partials ────►│ safety          │  deterministic. no LLM. every partial.
                     │ classifier      │──► hazard? ─► warm transfer, one turn
                     └─────────────────┘
                              │
                              ▼
   ┌──────────────────────────────────────────────────────────┐
   │  conversation                                            │
   │                                                          │
   │  GREETING → IDENTIFY → TRIAGE → QUALIFY → SCHEDULE →     │
   │                 │                          CONFIRM → CLOSE│
   │                 └─► EMERGENCY → HANDOFF                  │
   │                                                          │
   │  SlotBook: out-of-order fills · confidence · read-back   │
   │  transition(): pure. emits Effect[] for the audio layer. │
   └──────────────────────────────────────────────────────────┘
                              │
                              ▼  PendingBooking (nothing written during the call)
   ┌──────────────────────────────────────────────────────────┐
   │  workflows — durable saga, journaled, retries            │
   │                                                          │
   │  create_customer ──► ensure_location ──► create_job      │
   │        ▲                                     │           │
   │        └───────── compensate ◄───────────────┘  on failure│
   │                                                          │
   │  send_sms  ← outside the transaction. you cannot unsend. │
   └──────────────────────────────────────────────────────────┘
                              │
                              ▼
                   Housecall Pro │ Jobber
```

### Packages

| Package | What it owns |
| --- | --- |
| `contracts` | Zod schemas. Slot keys, the state graph, `PendingBooking`, call traces. **Defined once.** |
| `conversation` | `SlotBook` and the state machine. Pure — no I/O, no clock, no network. |
| `safety` | Deterministic bilingual emergency classifier + its labeled corpus. |
| `validators` | Phone (E.164 + NANP), address (geocoder port), service area, business hours. |
| `crm` | `CrmAdapter` + Housecall Pro (REST) + Jobber (GraphQL). |
| `workflows` | Saga engine, post-call booking transaction, compensating rollback. |
| `telemetry` | Containment, correction rate, barge-in, turn-take, latency budgets. |
| `eval` | Simulated callers. Personas run against the real machine in CI. |
| `apps/web` | The contractor dashboard. |

---

## Four decisions worth explaining

### The model never chains tool calls

Sequential tool-calling collapses to single digits, so the agent never plans a
sequence. In each state it is handed exactly one tool, which records one fact.
**Our code** advances the state, on a validated slot.

`transition()` is a pure function returning `Effect[]` — `ASK_FOR`, `READ_BACK`,
`ESCALATE`, `CREATE_PENDING_BOOKING`. The machine decides; the audio layer
performs. That is what lets the entire conversation graph be tested without a
phone.

### The state machine must not feel like a phone tree

Real callers volunteer the address before you ask, and change the appointment
three turns later. This is the highest-risk design detail in the plan, so it was
built on day one rather than retrofitted:

```ts
// "Hi, it's Rosa at 1247 Calle Ocho, my heater's dead, can someone come Thursday?"
const r = transition(ctx, fill("callback_phone", "+13055557781"), opts);
r.transitions; // ["TRIAGE", "QUALIFY", "SCHEDULE", "CONFIRM"] — four states at once
```

And supplying a different value for an already-confirmed slot **silently revokes
that confirmation**. The call cannot close until the caller hears the new value
read back. A truck going to the wrong door with a confirmation on file that was
never given is the failure this prevents.

### The emergency classifier does not ask a model for permission

Gas, carbon monoxide, fire, arcing, flooding, sewage, no-heat-in-a-freeze, and
any hazard co-occurring with a child or an elderly resident bypass the state
machine and warm-transfer within one turn.

It is deterministic keyword and bounded-edit-distance matching over a bilingual
lexicon, running on every ASR partial, in parallel with and independent of the
LLM — because it must work when the model is down, rate-limited, or confidently
wrong.

- **Recall is a hard constraint. Precision is a cost we measure.** A false
  positive costs one annoyed dispatcher; a false negative costs a house.
  `recall === 1.0` is asserted on every run over a 66-sample bilingual corpus
  (38 hazards, 28 routine calls).
- **No negation suppression.** *"There's no gas leak, right?"* transfers to a
  human. Suppressing a hazard on the word "no" is how you miss *"no, I mean there
  IS a gas leak."* The deliberate false positives are pinned in their own test, so
  that "fixing" them has to be a decision rather than a silent regression.
- It knows the weather. *"The furnace is out"* is a routine job in July and a
  life-safety call at 18°F — the caller never has to say "freezing."

### Nothing reaches the CRM during the call

The call produces a `PendingBooking`. A durable, journaled saga commits it
afterwards, with retries on transient failures only, and compensating rollback:

```ts
const result = await commitBooking(id, payload, deps);
// → { status: "COMMITTED",  booking, smsDelivered }
// → { status: "ROLLED_BACK", reason }        the CRM is clean
// → { status: "FAILED", needsHumanReview }   compensation itself failed
```

Three details that are easy to get wrong, and are tested:

- **A customer who existed before the call is never deleted on rollback.** That
  would turn a failed booking into data loss.
- **The SMS sits outside the transaction.** You cannot unsend a text, and
  cancelling a correctly-booked job because a carrier hiccuped would turn a
  notification problem into a lost customer.
- **A crashed workflow can be re-run.** Completed steps are journaled, so the
  customer created before the crash is not created twice.

---

## Verification

Reliability claims in this space are mostly unfalsifiable marketing. These are not.

```
 ✓ contracts/contracts.test.ts   (30)   graph connectivity, slot registry invariants
 ✓ conversation/slot-book.test.ts (36)  fills, confidence, confirmation, backtracking
 ✓ conversation/machine.test.ts   (33)  transitions, guards, emergency interrupts
 ✓ safety/classifier.test.ts      (83)  precision AND recall over a labeled corpus
 ✓ validators/validators.test.ts  (64)  E.164, geocoding, polygons, timezones, DST
 ✓ crm/crm.test.ts                (53)  ONE contract suite, run against BOTH adapters
 ✓ workflows/booking.test.ts      (28)  saga, rollback, crash-resume, retry backoff
 ✓ telemetry/metrics.test.ts      (25)  percentiles, budgets, the latency/silence trade
 ✓ eval/eval.test.ts              (32)  simulated callers, end to end

 Tests  384 passed        Coverage  98.8% lines / 95.3% branches
```

A few of these are load-bearing:

**The CRM contract suite runs against both adapters.** `plan.md` warns that an
adapter interface designed against one CRM "will just be a rename of Housecall
Pro's endpoints." Jobber forced three corrections: a Job needs a `Property` node
(so `ensureServiceLocation` exists as a concept), GraphQL returns `200 OK` with
the failure in the body (so HTTP status cannot drive retry alone), and Jobber
cannot delete a job (so compensation is `revokeJob`, not `deleteJob`).

**The rollback test is the one the plan names.** Force a failure at `create_job`
after `create_customer` succeeds; assert the compensating step runs and no
customer is orphaned.

**The suite is mutation-tested.** Break an invariant, confirm it screams:

| Mutation | Result |
| --- | --- |
| Correction no longer revokes confirmation | **3 tests fail** — unit, machine, and end-to-end |
| Remove in-phrase fuzzy matching (`gas leek`) | **5 tests fail** — emergency recall drops to 0.974 |

That first one is why `eval` records which slots were *read back* rather than only
which values came out right. Asserting the final value would also pass a system
that silently kept a stale confirmation and never let the caller hear the
correction.

---

## Status

Built and tested: the domain core, both CRM adapters, the booking transaction,
the metrics, the eval harness, and the dashboard. **5.3k lines of source, 3.3k
lines of tests, 13 simulated-caller scenarios.**

Not built, and deliberately not faked:

- **Phase 0 — the wedge gate.** `plan.md` says do not write product code until
  ~150 real code-switched audio samples show critical-slot accuracy above ~85%.
  That needs audio and live model keys. If Phase 0 kills the multilingual wedge,
  the same machine serves an English-only trade wedge — nothing here is
  Spanish-specific except the lexicon and the prompts.
- **Telephony.** No Twilio, no LiveKit, no realtime model. `Effect[]` is the seam
  the voice runtime binds to.
- **Persistence, auth, multi-tenancy, billing.** Phase 4.
- **`eval` over real SIP.** The harness answers *"given what the caller said, does
  the system do the right thing?"* The latency and barge-in numbers that are
  comparable to the literature need the SIP path.
- **Compliance.** AI disclosure, two-party consent, recording retention. Phase 5
  gates revenue, not code.

See [`CLAUDE.md`](./CLAUDE.md) for conventions and gotchas,
[`plan.md`](./plan.md) for the delivery plan, and [`idea.md`](./idea.md) for the
research it derives from.

---

## The number that matters

Every booking the contractor edits or cancels is written back as
`outcomes.correctedFields` — a labeled failure. It is the metric the dashboard
leads with, the loop that `idea.md` says nobody in this field has closed, and the
one we intend to publish.

Not "our agent is 95% accurate." **"Of the ten jobs we booked you yesterday, you
had to fix one."**
