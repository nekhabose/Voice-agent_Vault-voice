# CLAUDE.md

Working notes for agents and humans in this repo. Read this before changing code.

> **Keep this file current.** Every change that adds a package, moves a boundary,
> or alters an architectural principle updates this file in the same commit. A
> stale CLAUDE.md is worse than none — it teaches the next reader something false.

## Before you start work

**The work is `plan.md` §9, a numbered list of Steps 0–9. Read the progress board at
the top of `plan.md` to see where the build actually is.** Do not infer it from the
code, and do not trust a step's prose over the board.

**When you finish a Step, you are not done until `plan.md` says so.** In the same
commit as the code:

1. Flip that Step's row on the **progress board** to `✅ Done — <date>`, and move the
   `← next` marker to the following Step.
2. Mark the Step's **own heading** `✅ Done`, tick its sub-tasks, and write down what
   came out *different* from what the Step predicted — the surprises are the part worth
   reading later.
3. Update the **status table** if the test count, coverage, or build changed.
4. If you found something that belongs to a later Step, record it there explicitly
   rather than leaving it in a commit message.
5. If you moved a boundary or a principle, update this file too, and add a change-log
   entry at the bottom.

This is not bookkeeping. Someone opens a fresh session, says "continue with Step 2,"
and the only thing standing between them and repeating your work is whether you did
the above.

---

## What this is

**Ledgerline** — an English-language inbound-call voice agent for US home-services
contractors. A missed call at a plumbing shop is a lost job worth hundreds of
dollars; the conversation needed to capture it is bounded.

The wedge is **reliability, measured and published**: nobody in this industry
reports how often their agent gets the address right, and we will, per tenant,
from call one. That makes `outcomes.correctedFields` the product rather than a
metric — see `plan.md`, principle #5.

- [`idea.md`](./idea.md) — the upstream research. Deliberately *not* revised to
  match later decisions; it is the evidence record.
- [`plan.md`](./plan.md) — the single source of truth for *why*, *what*, and
  *how*: principles, the LLM surface, the step-by-step build order, and the
  implementation reference (§10) the steps point at.
- This file — *what exists* and *how to work on it*.

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
  extraction/    The Anthropic slot extractor. One tool, one field, one turn.
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
    ├──► extraction ─────────────────────────────┘  (eval binds it at Step 5.1)
    ├──► crm ──► workflows
    └──► telemetry ──► web
```

`extraction` depends on `contracts` alone, and nothing depends on `extraction` yet. The only
model SDK in the tree lives there, and it stays there.

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

`packages/extraction` enforces the other half in the tool schema rather than in a
prompt: one tool, forced `tool_choice`, `disable_parallel_tool_use`. The model's
entire decision space per turn is *what is the value of this one field, or
nothing* — and `null` is the "or nothing", because a forced `tool_choice` leaves
it no other way to decline.

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
`ExtractionOutcome` mirrors this exactly: an Anthropic outage is `unavailable`,
never `absent`, because "the model is down" and "the caller said nothing" must
not produce the same behaviour.

**The model's output space is the contract, narrowed.** `SLOT_SPECS[key]` carries
*two* schemas. `.schema` is the stored fact; `.extraction` is what the model may
report, and `packages/extraction` derives its strict tool schema from the latter.
They differ for exactly two slots, and both differences are this principle:

- `service_address` — `.extraction` is `AddressInputSchema`, with no `formatted`,
  `lat`, or `lng`. Those are the *geocoder's output*. A model that can emit
  `formatted` can hallucinate a normalised address that never existed, and the
  read-back then reads it confidently back to the caller.
- `callback_phone` — `.extraction` is spoken digits. `E164Schema` would make the
  model invent a country code, which is `validatePhone`'s job.

Merging them looks like a cleanup (four of six slots have identical schemas) and
is a principle violation. Two tests in `contracts.test.ts` fail if you try.

And `strict: true` guarantees the *shape*, never the *meaning* — it cannot carry
`pattern` or `minLength`, so a ZIP of `ABCDE` comes straight back. Re-validating
the model's output with the Zod schema on the way in is the only thing standing
between the model and the geocoder.

### 4. The emergency classifier does not ask an LLM for permission

`packages/safety`. Deterministic keyword + bounded-edit-distance matching over a
bilingual lexicon, running on every ASR partial, independent of the model.

- **Recall is a hard constraint; precision is a cost we measure.** A false
  positive costs one annoyed dispatcher. A false negative costs a house.
- **The lexicon stays bilingual even though the product is English-only.**
  `SMELL_VERBS` carries `huele`/`olor`; `GAS_NOUNS` carries `propano`. A
  Spanish-speaking homeowner can dial an English-only shop, and panic reverts
  people to their first language. `huele a gas` must transfer. These phrases look
  like dead code after the English-only pivot. Deleting them is the one edit in
  this repo that could kill someone.
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
  `Validation<T>`, `ExtractionOutcome`). Exceptions are for genuinely exceptional
  things — in `extraction`, a `429`/`5xx`/dead socket is `unavailable`, while a
  `400` or `401` **throws**, because a malformed request or a missing key is our
  bug and must crash loudly in staging rather than degrade into a caller being
  asked their name four times.
- **Nothing in the cached prompt prefix may vary per call.** `tools` and `system`
  render before `messages`. One interpolated byte in the prefix multiplies
  extraction cost roughly tenfold with no error. Per-call data goes in
  `ExtractionContext`, which the request builder never reads.
- Comments explain *why*, and cite the constraint. If a comment restates the
  code, delete it.

---

## Testing

439 tests, 98.8% line coverage, thresholds enforced in `vitest.config.ts`.

| Layer | Where | What it proves |
|---|---|---|
| Schema invariants | `contracts` | The graph is connected, terminal states have no successor, every slot has both a spec and an extraction schema |
| Unit | `conversation`, `safety`, `validators` | Slot mechanics, hazard precision/recall, phone/address/window rules |
| Replay | `extraction` | Committed model responses driven through the **real** `SLOT_SPECS`. **Zero live model calls** — the SDK's `fetch` is injected. A suite whose green depends on a third party's uptime teaches the team to ignore red |
| Contract | `crm` | **One suite, both adapters.** If it passes for Housecall Pro and Jobber, the interface is not a rename of one vendor's endpoints |
| Integration | `workflows` | The booking saga, including the forced `create_job` failure and its compensating rollback |
| End-to-end | `eval` | Simulated callers through the real machine, classifier, and validators |

### Rules

- **Assert on behaviour, not implementation.** The eval harness records
  `readBacks` precisely because asserting the final *value* would also pass a
  system that silently kept a stale confirmation.
- **Mutation-test the invariants that matter.** Break the thing, confirm the
  suite screams, revert. Six are verified: revoking confirmation on correction
  (caught in 3 places); in-phrase fuzzy matching (drops recall to 0.974); and, in
  `extraction`, dropping `thinking: {type:"disabled"}`, skipping the Zod
  re-validation of the model's output, interpolating a per-call value into the
  cached prompt prefix, and widening `UrgencySchema` in `contracts`.
- The emergency classifier reports precision **and** recall over a labeled
  bilingual corpus every run (38 hazards, 28 routine calls). `recall === 1.0` is
  asserted. Precision is currently 1.0, with 3 documented deliberate false
  positives held separately in `KNOWN_FALSE_POSITIVES`.

---

## What is NOT built

Stated plainly, because a README that implies otherwise is marketing.

- **The extractor has never spoken to a live model.** `packages/extraction` is
  real code against the real `@anthropic-ai/sdk`, but every test drives it through
  an injected `fetch` and committed fixtures, and **those fixtures were
  hand-authored, not recorded** — no credential existed when it was built
  (`fixtures.ts` says so at the top). Re-record them at the start of Step 5.
  Two things nobody has verified: what `claude-sonnet-5` actually emits, and
  whether the prompt-cache prefix is even large enough to cache (it is a few
  hundred tokens against a Sonnet-tier minimum near 2k, and a short prefix caches
  *silently*). See `plan.md` Step 1, surprises #4 and #5.
- **`eval` still uses its own inline extractor stub.** `FakeExtractor` exists and
  nothing binds it yet; that is task 5.1, left undone rather than half-done.
- **Nothing produces `BookingOutcome[]`.** `computeMetrics()` (`metrics.ts:41`)
  accepts the contractor's later edits and cancellations as ground truth, and no
  code emits them. Since that number *is* the wedge, `CrmAdapter.readJob` plus a
  polling outcome pipeline is Step 2 in `plan.md` §9 — before telephony, not after.
- **No telephony, no LiveKit, no realtime model.** The `Effect[]` type is the seam
  the voice runtime binds to. The plan puts the agent worker in Python; the core
  is TypeScript and pure, so it can drive either through a typed boundary.
- **No database.** The data model in `plan.md` is not yet Drizzle schema.
  `apps/web/lib/demo-data.ts` seeds the dashboard and is typed against the real
  contracts, so the UI cannot drift.
- **No auth, no multi-tenancy, no billing.** Step 7.
- **`eval` does not run over real SIP.** It answers "given what the caller said,
  does the system do the right thing?" The latency and barge-in numbers that are
  comparable to the literature require the SIP path.
- **No compliance work.** Step 8 gates revenue, not code.
- **Locale is recorded, never acted on.** `LocaleSchema` (`primitives.ts:29`) and
  `PendingBookingPayload.locale` stay — one field, and keeping the core
  wedge-agnostic is what made the English-only pivot free. `customer.locale` rides
  the booking to the CRM so a human knows what language to call back in. Nothing
  branches on it: the SMS is English, the utterances are English, the extractor
  will be English. The **safety classifier is the deliberate exception** — see
  principle #4 and `safety/english-only-pivot.test.ts`.

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

- **Step 1 — `packages/extraction`.** *(439 tests, 98.84% coverage, typecheck clean,
  `apps/web` builds.)* The Anthropic slot extractor, behind the new `SlotExtractor`
  port: one tool per slot, forced `tool_choice`, `thinking: {type:"disabled"}`,
  `max_tokens: 256`, prompt-cache pre-warm across all six prefixes. The tool schema
  is derived from the contract at build time, and a `strictify()` pass rewrites it
  into the subset `strict: true` accepts.

  **Two boundaries moved, and both are principle #3.** First, `SlotSpec` gained an
  `extraction` schema beside `schema`, because deriving the model's tool from the
  *storage* schema would ask it for `formatted`/`lat`/`lng` (the geocoder's output)
  and for E.164 (the validator's output). `AddressInputSchema` moved into
  `contracts` from `validators`, where it had been duplicated. Second, `strict` mode
  cannot express `pattern` or `minLength`, so the contract's semantic constraints
  are enforced by Zod on the way *in* rather than by the model on the way out — a
  ZIP of `ABCDE` satisfies the tool schema and is rejected by `AddressInputSchema`,
  and the `SERVICE_ADDRESS_MALFORMED` fixture exists to keep that pass alive.

  **The exit criterion changed, on purpose.** `plan.md` asked for
  `cache_read_input_tokens > 0` in CI *and* zero live model calls in `npm test`;
  those contradict. The suite instead asserts the rendered `tools` and `system`
  bytes are identical across calls with different call ids, turn indices, and
  utterances — which is the property a `Date.now()` in the prefix actually breaks,
  and it fails offline in milliseconds. The live check is now task 5.5. Underneath
  it sits an unverified assumption: our prefix may be too short to cache at all.

- **Step 0 — pivot cleanup.** *(391 tests, 98.82% coverage, `apps/web` builds.)*
  `confirmationBody()` and `formatWindow()` no longer take a `Locale`: the
  confirmation SMS is English whatever locale the caller was tagged with, because
  we do not send a message no contractor can proofread. `customer.locale` still
  rides the `PendingBooking` to the CRM, so a human knows what language to call
  back in. Replaced the code-switched *booking* eval scenario with
  `english/answers-in-fragments`; renamed the two Spanish hazard scenarios to
  `hazard/*` and kept them, because the booking flow is English-only and the
  classifier is not — that boundary is the pivot, and it is now asserted rather
  than implied. Added `safety/english-only-pivot.test.ts`, a named tripwire
  carrying the rationale. Dashboard demo data is English, except the one emergency
  caller who reverts to Spanish when she smells gas.
- **English-only pivot; reliability becomes the wedge.** *(docs only — no code
  changed; 384 tests, 98.78% coverage, typecheck and `apps/web` build all verified
  green at the time of writing.)* Dropped the Spanish-first wedge and with it
  the Phase 0 code-switching audio gate and the multilingual phase. The domain
  core needed no changes, which is exactly what "wedge-agnostic" was for.
  Replaced the multilingual moat with **measured, published reliability**, which
  promotes `outcomes.correctedFields` from a late metrics chore to Step 2 of the
  build — before telephony — and adds `CrmAdapter.readJob` plus a polling outcome
  pipeline (webhooks are lossy, and a missed webhook silently reports a 0%
  correction rate). Kept the bilingual hazard lexicon — see principle #4.
  Rewrote `plan.md` as the single source of truth: principles, the LLM surface,
  the new ports (`SlotExtractor`, `Utterer`, `VoiceSession`), build-time utterance
  generation, a Step 0–9 build order, an implementation reference (§10), and the
  experiment that would falsify principle #1.
- **Initial build.** Monorepo scaffold; `contracts`; `SlotBook` with confidence,
  confirmation, and backtracking; the seven-state machine with guard verdicts
  (`pass` / `block` / `escalate`); deterministic bilingual emergency classifier
  with a labeled corpus; phone / address / service-area / business-hours
  validators; `CrmAdapter` designed against Housecall Pro *and* Jobber, with one
  shared contract suite; the saga engine and post-call booking transaction with
  journaled crash-safe resume and compensating rollback; `telemetry` with
  Full-Duplex-Bench-comparable definitions and CI budgets; the simulated-caller
  `eval` harness; and the contractor dashboard. 384 tests, 98.8% coverage.
