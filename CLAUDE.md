# CLAUDE.md

Working notes for agents and humans in this repo. Read this before changing code.

> **Keep this file current.** Every change that adds a package, moves a boundary,
> or alters an architectural principle updates this file in the same commit. A
> stale CLAUDE.md is worse than none — it teaches the next reader something false.

---

## What this is

**Ledgerline** — an inbound-call voice agent for US home-services contractors,
Spanish-first. A missed call at a plumbing shop is a lost job worth hundreds of
dollars; the conversation needed to capture it is bounded.

The source of truth for *why* is [`plan.md`](./plan.md), which derives from the
research in [`idea.md`](./idea.md). This file describes *what exists* and *how to
work on it*.

---

## The one idea

Benchmarks say the best ASR→LLM pipeline fills tool-call parameters correctly
~60.6% of the time, and sequential multi-step workflows collapse to 5–15%
(VoiceAgentBench). So **we never ask a model to do the thing it fails at.**

- The conversation is a **state machine**. Our code advances it, on validated
  slots. The model never plans a sequence and never decides it is time to move on.
- Per turn, the model extracts **one field**.
- The booking — `lookup → create customer → create job → notify` — runs **after
  the call**, as a deterministic transaction with retries and compensating
  rollback.

A 14.8%-reliable agentic task becomes a 5-field extraction task plus a database
transaction. That reframing is the whole product.

---

## Commands

```bash
npm install
npm test            # vitest, all packages
npm run typecheck   # tsc across all packages — vitest strips types, so run both
npm run test:coverage
npm run check       # typecheck + test

cd apps/web && npm run dev     # dashboard on :3000
cd apps/web && npm run build   # also typechecks the app
```

`npm test` passing does **not** mean the code typechecks. Always run
`npm run check` before you claim a change is done.

---

## Layout

```
packages/
  contracts/     Zod schemas. The spine. Slots, states, bookings, traces, ports.
  conversation/  SlotBook + the state machine. Pure, no I/O.
  safety/        Deterministic emergency classifier. No LLM dependency.
  validators/    Phone, address (geocoder port), service area, business hours.
  crm/           CrmAdapter interface + Housecall Pro + Jobber.
  workflows/     Saga engine + post-call booking transaction.
  telemetry/     Reliability metrics + latency/turn-taking budgets.
  eval/          Simulated-caller harness. Scenarios run in CI.
apps/
  web/           Next.js contractor dashboard.
```

### Dependency direction

```
contracts ──► conversation ──► validators ──► eval
    │              │               ▲            ▲
    ├──► safety ───┼───────────────┘────────────┘
    ├──► crm ──► workflows
    └──► telemetry ──► web
```

`contracts` depends on nothing. Nothing depends on `web`. There are no cycles —
keep it that way.

---

## Architectural principles

Each one answers a specific finding in `idea.md`. Violating one is a design
change, not a refactor.

### 1. The model never chains tool calls

`packages/conversation/machine.ts`. States advance when a **required set** of
slots is present and validated, and guards pass. `transition()` is a pure
function: same context and event in, same result out.

It returns `Effect[]` — `ASK_FOR`, `READ_BACK`, `ESCALATE`,
`CREATE_PENDING_BOOKING` — which the voice runtime performs. The machine decides;
the audio layer is dumb. This is what makes the entire graph testable without a
phone.

### 2. Out-of-order fills and backtracking are day-one requirements

Real people volunteer the address before you ask, and change the appointment
three turns later. `SlotBook` accepts any slot from any turn, and the advance
loop can cross four states on one utterance.

**Supplying a different value for a confirmed slot silently revokes the
confirmation.** The call cannot close until the caller hears the new value read
back. If you touch `SlotBook.fill`, three tests will catch you — one unit, one
machine-level, one end-to-end in `eval`. That redundancy is deliberate; the
mutation that keeps a stale confirmation is the one that sends a truck to the
wrong door.

### 3. Every consequential action is verified before it commits

- `service_address`, `callback_phone`, `appointment_window` are **always** read
  back. `caller_name` and `problem_description` are read back only when the
  extractor's confidence is below `LOW_CONFIDENCE_THRESHOLD` (0.85).
- Addresses are validated against a geocoder, never trusted from the transcript.
- **Nothing is written to the CRM during the call.** The call emits a
  `PendingBooking`; `packages/workflows` commits it afterwards.

A geocoder outage yields `unavailable`, not `invalid`. Unverified is not wrong,
and an outage at Google must not take the contractor's phone line down. The
`always`-confirm policy is what protects us in that window.

### 4. The emergency classifier does not ask an LLM for permission

`packages/safety`. Deterministic keyword + bounded-edit-distance matching over a
bilingual lexicon, running on every ASR partial, independent of the model.

- **Recall is a hard constraint; precision is a cost we measure.** A false
  positive costs one annoyed dispatcher. A false negative costs a house.
- **No negation or tense suppression.** "There's no gas leak, right?" transfers.
  Suppressing on "no" is how you miss "no, I mean there IS a gas leak."
  `KNOWN_FALSE_POSITIVES` in `corpus.ts` pins this so a future "fix" is a
  conscious decision with a failing test attached.
- Fuzzy matching: standalone terms need ≥5 characters, terms inside a multi-word
  phrase need ≥4 (the neighbours disambiguate). That is why `gas leek` fires and
  `he has leaks` does not.
- `FUZZY_EXCLUSIONS` holds *measured* collisions only (`flooring`/`flooding`),
  never guesses.

### 5. Measure in production, from day one

`idea.md`'s biggest open question is that no field reliability numbers exist.
`packages/telemetry` computes them, and barge-in / turn-take are defined the way
Full-Duplex-Bench-v3 defines them so our figures are comparable to the
literature.

`checkBudgets()` blocks a merge on: p95 first word > 1.2s, p95 turn > 2.0s,
turn-take < 96%, barge-in > 13.5%. **You cannot buy latency with silence** — the
fastest model in the benchmark had the worst turn-take rate.

Ground truth is `outcomes.correctedFields`: every booking the contractor edits or
cancels is a labeled failure. It is the only number that matters and nobody
publishes it.

---

## Conventions

- **`packages/contracts` is load-bearing.** Slot keys, the state graph, and the
  `PendingBooking` shape are defined exactly once. Adding a slot key widens the
  surface the model must be correct on — that is a product decision, not a
  refactor.
- **Ports, not mocks.** `Geocoder`, `HttpTransport`, `SmsSender`, `Journal`,
  `Clock`, `Sleep` are interfaces with real fakes (`FakeGeocoder`,
  `FakeTransport`, `FakeSms`, `InMemoryJournal`, `fixedClock`, `recordingSleep`).
  Tests assert on what the collaborator *saw*, never on a mocking framework.
- **Nothing reads the wall clock or sleeps for real.** Inject `Clock` and `Sleep`.
- **Immutability in the conversation core.** `SlotBook` and `transition` return
  new values. A call's history is a list of snapshots, not a blob to reconstruct
  from logs.
- **Result types over exceptions** for expected failures (`FillResult`,
  `Validation<T>`). Exceptions are for genuinely exceptional things.
- Comments explain *why*, and cite the constraint. If a comment restates the
  code, delete it.

---

## Testing

384 tests, 98.8% line coverage, thresholds enforced in `vitest.config.ts`.

| Layer | Where | What it proves |
|---|---|---|
| Schema invariants | `contracts` | The graph is connected, terminal states have no successor, every slot has a spec |
| Unit | `conversation`, `safety`, `validators` | Slot mechanics, hazard precision/recall, phone/address/window rules |
| Contract | `crm` | **One suite, both adapters.** If it passes for Housecall Pro and Jobber, the interface is not a rename of one vendor's endpoints |
| Integration | `workflows` | The booking saga, including the forced `create_job` failure and its compensating rollback |
| End-to-end | `eval` | Simulated callers through the real machine, classifier, and validators |

### Rules

- **Assert on behaviour, not implementation.** The eval harness records
  `readBacks` precisely because asserting the final *value* would also pass a
  system that silently kept a stale confirmation.
- **Mutation-test the invariants that matter.** Break the thing, confirm the
  suite screams, revert. Two are verified: revoking confirmation on correction
  (caught in 3 places), and in-phrase fuzzy matching (drops recall to 0.974).
- The emergency classifier reports precision **and** recall over a labeled
  bilingual corpus every run (38 hazards, 28 routine calls). `recall === 1.0` is
  asserted. Precision is currently 1.0, with 3 documented deliberate false
  positives held separately in `KNOWN_FALSE_POSITIVES`.

---

## What is NOT built

Stated plainly, because a README that implies otherwise is marketing.

- **Phase 0 is not done.** It needs ~150 real code-switched audio samples and
  live GPT-Realtime / Gemini Live keys. `plan.md` says do not write product code
  until the wedge survives it. The domain core here is wedge-agnostic — if Phase 0
  kills multilingual, the same machine serves an English-only trade wedge.
- **No telephony, no LiveKit, no realtime model.** The `Effect[]` type is the seam
  the voice runtime binds to. The plan puts the agent worker in Python; the core
  is TypeScript and pure, so it can drive either through a typed boundary.
- **No database.** The data model in `plan.md` is not yet Drizzle schema.
  `apps/web/lib/demo-data.ts` seeds the dashboard and is typed against the real
  contracts, so the UI cannot drift.
- **No auth, no multi-tenancy, no billing.** Phase 4.
- **`eval` does not run over real SIP.** It answers "given what the caller said,
  does the system do the right thing?" The latency and barge-in numbers that are
  comparable to the literature require the SIP path.
- **No compliance work.** Phase 5 gates revenue, not code.

---

## Gotchas

- `next.config.mjs` sets `resolve.extensionAlias` so webpack maps the ESM-correct
  `./slots.js` specifiers onto `./slots.ts`. Node and `tsc` understand these;
  webpack does not, without telling.
- Workspace packages ship TypeScript source (`main` → `src/index.ts`) and are
  listed in `transpilePackages`. No build step, and the dashboard always reflects
  the real domain types.
- `RollbackFailure.cause` needs `override` — it shadows `Error.cause`. Vitest
  strips types and will not catch this; `npm run typecheck` will.
- Confirming the *last* outstanding slot closes the call. There is no reopening a
  closed call, by design. To exercise backtracking, correct a slot while another
  confirmation is still outstanding.
- `zonedParts` uses `Intl` rather than a date library. DST and offset history are
  already in the platform, and a bad appointment window is a truck on the wrong
  day.

---

## Change log

- **Initial build.** Monorepo scaffold; `contracts`; `SlotBook` with confidence,
  confirmation, and backtracking; the seven-state machine with guard verdicts
  (`pass` / `block` / `escalate`); deterministic bilingual emergency classifier
  with a labeled corpus; phone / address / service-area / business-hours
  validators; `CrmAdapter` designed against Housecall Pro *and* Jobber, with one
  shared contract suite; the saga engine and post-call booking transaction with
  journaled crash-safe resume and compensating rollback; `telemetry` with
  Full-Duplex-Bench-comparable definitions and CI budgets; the simulated-caller
  `eval` harness; and the contractor dashboard. 384 tests, 98.8% coverage.
