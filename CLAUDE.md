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
  contracts/     Zod schemas. The spine. Slots, states, effects, bookings, traces, ports, HTTP.
  conversation/  SlotBook + the state machine. Pure, no I/O.
  safety/        Deterministic emergency classifier. No LLM dependency.
  validators/    Phone, address (geocoder port + GoogleGeocoder), service area, business hours.
  extraction/    The Anthropic slot extractor. One tool, one field, one turn.
  utterance/     Everything the agent says. Committed catalog, decided before the call.
  crm/           CrmAdapter interface + Housecall Pro + Jobber. Writes and reads.
  runtime/       CallRuntime. The Effect[] binding: caller ASR → machine → VoiceSession.
  workflows/     Saga engine + post-call booking transaction + the outcome poller.
  telemetry/     Reliability metrics + latency/turn-taking budgets.
  db/            Drizzle schema + migrations. Schema only — no client, no pool.
  eval/          Simulated-caller harness. Scenarios run in CI, over the real SlotExtractor port.
apps/
  web/           Next.js contractor dashboard.
  agent/         Python LiveKit worker scaffold + generated Pydantic. No hardware yet (Step 4.2/4.6).
```

### Dependency direction

```
contracts ──► conversation ──► validators ──► eval
    │              │               ▲   │        ▲
    ├──► safety ───┼───────────────┘   │────────┘
    ├──► extraction ───────────────────┼─────────┘  (eval binds it as of Step 5.1; runtime binds it in tests)
    ├──► utterance ────────────────────┤            (runtime binds it in tests)
    ├──► crm ──► workflows ┄┄► telemetry            (┄ = test-only)
    ├──► runtime ┄┄► {extraction, utterance, telemetry}   (runtime deps: conversation, safety, validators)
    ├──► telemetry ──► web
    └──► db
```

`extraction` depends on `contracts` alone. The model SDK *implementation* lives there and stays
there — `runtime` binds a `SlotExtractor`, never `AnthropicExtractor` directly (it takes the
port; tests inject `FakeExtractor`). `utterance` also depends on `contracts` alone — `LlmUtterer`
reaches a model through a local `Phraser` port rather than importing the SDK.

`eval` depends on `extraction` **at runtime**, as of Step 5.1 — the dependency diagram always
anticipated it ("eval binds it as of Step 5.1"). `simulate.ts` drives the real `SlotExtractor`
port; `eval/src/extractors.ts` binds `FakeExtractor` (scripted from each scenario's fills, the PR
arm) and `AnthropicExtractor` (the nightly arm, `anthropicExtractor(client)`). `eval` therefore
also declares `@anthropic-ai/sdk`, but only to *type the client* it hands to `AnthropicExtractor`;
it never constructs one in shipping code, and the PR suite never calls a live model. The nightly
binding is proven offline through an injected `fetch` against a committed `tool_use` body, exactly
as `extraction`'s own replay suite works.

`runtime` is the Step 4 `Effect[]` binding. It depends on `contracts`, `conversation`, `safety`,
and `validators` at runtime, and on `extraction`, `utterance`, and `telemetry` **as
devDependencies only**: `CallRuntime` speaks to those three through ports (`SlotExtractor`,
`Utterer`) or emits their shapes (`CallTurn`), so the real implementations are needed only to
drive and score the tests. `runtime.test.ts` runs a whole call — real machine, real classifier,
real validators, real `Effect[]` binding — against `FakeVoiceSession` and `FakeExtractor`, then
scores it with the real `computeMetrics()` / `checkBudgets()`. Do not promote those three to
runtime dependencies. Nothing depends on `runtime`; the Python worker (`apps/agent`) is its
audio adapter across the language boundary, not a package importer.

`HttpTransport` and `FetchTransport` live in `contracts`, not `crm`. Two packages speak HTTP to
a vendor — `crm` (Housecall Pro, Jobber) and `validators` (Google Address Validation) — and a
port crossing a package boundary belongs in the spine, exactly as `Effect` does. `crm/src/http.ts`
was deleted in Step 4; the alternative (`validators` → `crm`) points the graph backwards.

`Effect` and `EscalationAction` live in `contracts`, not `conversation`. Two things need them
across a boundary: the `Utterer` port (which `contracts` owns), and the Python worker, whose
Pydantic is generated from the Zod here (task 4.1: `contracts/src/codegen.ts` emits the JSON
Schema, `apps/agent` turns it into `contracts.py`). `machine.ts` re-exports them because it is
where they are produced.

`VoiceSession` and `BookingSink` are the two Step 4 ports the runtime performs against. The
`VoiceSession` **speaks and returns a `SpeechOutcome`** (`say`/`transfer`/`hangUp`); it does
**not** emit `MachineEvent`, because a `SLOT_FILLED` carries a geocoder- and validator-checked
value that only `CallRuntime` can construct (principle #3). Effects go down, raw speech comes up.

`db` depends on `contracts` alone, and nothing depends on `db`. Every `pgEnum` is spread
from a Zod schema rather than retyped, so the tables cannot drift from the domain.

`workflows ┄┄► telemetry` is a **devDependency**, and the only test-only edge in the tree.
`outcomes.test.ts` drives a hand-edited job body through the real adapter, the real poller,
and the real `computeMetrics()` — the one place the whole wedge is exercised end to end.
Do not promote it to a runtime dependency.

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

It returns `Effect[]` — `GREET`, `ASK_FOR`, `READ_BACK`, `ESCALATE`,
`CREATE_PENDING_BOOKING` — which the voice runtime performs. The machine decides;
the audio layer is dumb. This is what makes the entire graph testable without a
phone.

A call opens with **no event at all**, so `nextPrompt(ctx)` is exported: the worker
asks the machine what to say first and is told to `GREET`. Delete that and
`greeting_delivered` blocks the call forever, waiting on a milestone nobody was
asked to reach — and no caller ever hears the AI disclosure.

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

**No model speaks a sentence whose content is load-bearing.** `packages/utterance`
holds a committed catalog, and `LlmUtterer` — a development drafting tool, never
what ships — may paraphrase `ASK_FOR` and nothing else. The other four effects
each carry content, not wording:

- `GREET` carries the AI disclosure. Legal text. Pinned character-for-character.
- `READ_BACK` **is** the verification step. A model that "naturally" renders
  `1247 Calle Ocho` as `1247 SW 8th St` earns a cheerful yes to an address the
  caller never gave, and books a truck to it. Interpolating a value is
  templating, not generation — `fill()` does it, and it is nine lines.
- `ESCALATE` carries life-safety guidance, read to someone who may be standing in
  a room filling with gas.
- `CREATE_PENDING_BOOKING` promises an SMS to one specific number.

Widening that check in `llm.ts` fails three tests. `plan.md` §10.2 originally said
the opposite; it was wrong, and Step 3 surprise #3 says why.

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
publishes it. `packages/workflows/src/outcomes.ts` computes it, and four rules
keep it honest:

- **Polled, never webhooked.** Webhook delivery is at-most-once, and a missed
  webhook reports a 0% correction rate — exactly the number a dishonest vendor
  would report. A metric whose failure mode is *looks perfect* must not depend on
  lossy delivery. `CRM_WEBHOOK` was removed from `OutcomeSourceSchema` for this
  reason; do not add it back.
- **A failed poll emits nothing.** `readJob` throws on a `429`/`5xx`/dead socket,
  and `observeOutcome` lets it. Swallowing an outage and recording "no
  corrections" is the missed webhook again, wearing a different hat.
- **Absence is never a correction.** Every field on `CrmJobSnapshot` is nullable.
  A vendor that stops returning `description` has told us nothing about whether
  the contractor edited it.
- **Half of `diffBooking` is refusing to report corrections that never
  happened.** `+13055551234` vs `(305) 555-1234`, `Z` vs `-04:00`, `33135` vs
  `33135-2841`, a CRM title-casing a name — each of these is a *false* failure
  that makes our published number worse than the truth. Each has a test. And
  `CrmJobSnapshot.address` is an `AddressInput` precisely so the geocoder's
  `formatted` cannot reach the comparison and mark every booking wrong.

The poller reads and never writes: `OutcomeDeps.crm` is
`Pick<CrmAdapter, "readJob">`, so a metric that repairs the thing it measures
does not compile.

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

616 tests, 99.19% line coverage, thresholds enforced in `vitest.config.ts`.

| Layer | Where | What it proves |
|---|---|---|
| Schema invariants | `contracts` | The graph is connected, terminal states have no successor, every slot has both a spec and an extraction schema, every `Effect` parses. And the worker JSON Schema is byte-current with the Zod — the codegen drift guard |
| Unit | `conversation`, `safety`, `validators` | Slot mechanics, hazard precision/recall, phone/address/window rules, and `GoogleGeocoder`'s status→outcome mapping against transcribed wire shapes |
| Review surface | `utterance` | The catalog is data, not template functions; every slot has an ask and a read-back; the AI disclosure is byte-for-byte what it was; `LlmUtterer` refuses to reword anything but `ASK_FOR` |
| Replay | `extraction` | Committed model responses driven through the **real** `SLOT_SPECS`. **Zero live model calls** — the SDK's `fetch` is injected. A suite whose green depends on a third party's uptime teaches the team to ignore red |
| Contract | `crm` | **One suite, both adapters.** If it passes for Housecall Pro and Jobber, the interface is not a rename of one vendor's endpoints. `readJob` is asserted in our vocabulary against each vendor's |
| Runtime | `runtime` | A whole call driven through the **real** machine, classifier, validators, and `Effect[]` binding against `FakeVoiceSession` — greeting/disclosure first, out-of-order-safe read-backs, correction revokes confirmation, extraction outage retries then escalates as `AGENT_ERROR`, hazard on an ASR partial short-circuits before the extractor, and every turn traced so `checkBudgets()` scores it (silence breaches `turnTakeRate`) |
| Drift | `db` | Every `pgEnum` equals its Zod source. No database is touched; that needs Neon |
| Integration | `workflows` | The booking saga, including the forced `create_job` failure and its compensating rollback. And the outcome poller — a hand-edited job body through the real adapter, the real diff, and the real `computeMetrics()` |
| End-to-end | `eval` | Simulated callers through the real machine, classifier, validators, **and `SlotExtractor` port** — a fill scripts `FakeExtractor`, and the value flows text → port → validators → machine; the nightly `AnthropicExtractor` binding is driven offline through an injected `fetch` |

### Rules

- **Assert on behaviour, not implementation.** The eval harness records
  `readBacks` precisely because asserting the final *value* would also pass a
  system that silently kept a stale confirmation.
- **Mutation-test the invariants that matter.** Break the thing, confirm the
  suite screams, revert. Eighteen are verified: revoking confirmation on
  correction (caught in 3 places); in-phrase fuzzy matching (drops recall to
  0.974); in `extraction`, dropping `thinking: {type:"disabled"}`, skipping the
  Zod re-validation of the model's output, interpolating a per-call value into
  the cached prompt prefix, and widening `UrgencySchema` in `contracts`; in
  the outcome pipeline, swallowing a `503` in `readJob`, treating an unreported
  field as a correction, counting outcome rows instead of bookings (caught in 2
  places), reading Jobber's truncated `title` instead of `instructions`,
  comparing `postalCode` exactly, comparing phone numbers as strings, and
  restoring `CRM_WEBHOOK` to the contract; and, in `utterance`, letting
  `LlmUtterer` paraphrase anything beyond `ASK_FOR` (caught in 3 places),
  rewording `AI_DISCLOSURE`, reading back the caller's raw address instead of the
  geocoder's `formatted`, dropping the tenant timezone from `speakWindow`, and
  removing `GREET` from `nextPrompt`.
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
  *silently*). See `plan.md` Step 1, surprises #4 and #5, and Step 5.5 — the
  nightly arm that would settle both is bound (`eval/src/extractors.ts`) but has
  never called a live model, because no credential exists here.
- **`eval` now binds the real `SlotExtractor` port** (Step 5.1), but only the fake
  side runs. The PR suite drives `FakeExtractor` scripted from each scenario's
  fills; the nightly `AnthropicExtractor` binding is proven offline through an
  injected `fetch`, never against a live model. So the eval's critical-slot
  accuracy proves the port, the validators, and the machine carry values through
  intact — **not** that `claude-sonnet-5` heard them right. That, and re-recording
  the fixtures, is task 5.5. The LLM-driven caller personas (5.2) and the real-SIP
  barge-in/turn-take arm (5.3) are the other two credential/hardware-gated tails.
- **`readJob` has never spoken to a live CRM.** `observeOutcome()` now produces
  the `BookingOutcome[]` that `computeMetrics()` consumes, and the whole path is
  exercised end to end — but through `FakeTransport`, against a job body edited by
  hand. No Housecall Pro sandbox credential exists. The vendor status
  vocabularies (`work_status`, `jobStatus`) and the deleted-job responses (`404`,
  `data.job: null`) are transcribed from documentation, not observed. Task 4.10
  verifies them, and Step 2's exit criterion, where the credential first exists.
- **Nothing schedules the poller.** `pollSchedule()` and `nextDuePoll()` say when
  a booking is due; no cron calls them, and `bookings.completed_polls` is a column
  nobody increments. That needs the database and Vercel WDK — Step 7.
- **The `Effect[]` binding is built and tested, but only against fakes.**
  `packages/runtime`'s `CallRuntime` drives a whole call — greeting through
  booking — through the real machine, classifier, and validators, and it is the
  seam the voice runtime binds to. What it has never had is a real microphone.
  **No telephony, no LiveKit room, no SIP trunk, no realtime model.** `apps/agent`
  is an honest Python scaffold: a README, a `pyproject.toml`, and the Effect
  dispatch worker, with a `FakeVoiceSession` standing in for audio. Tasks 4.2 (Twilio
  → SIP → LiveKit) and 4.6 (GPT-Realtime behind `apps/agent/voice/`) wire it to
  hardware. The 20-live-call exit gate is **not met and cannot be** without a
  vendor credential.
- **`GoogleGeocoder` has never spoken to a live Google endpoint.** It is real code
  behind the `Geocoder` port, driven in tests through an injected `HttpTransport`
  against response bodies transcribed from Google's docs — the same precedent as
  the extractor's hand-authored fixtures. What its status→outcome mapping does with
  a *real* Google response is unverified; that is a 4.10-class gap.
- **The Pydantic half of the worker codegen has never run.** `contracts/src/codegen.ts`
  emits the JSON Schema from the Zod and a test fails the build if the committed
  `apps/agent/contracts.schema.json` drifts — that half is offline and guarded.
  Turning it into `contracts.py` needs `datamodel-code-generator`, a Python tool
  this environment cannot install (PEP 668). `contracts.py` is `.gitignore`d because
  it is a generated artifact.
- **Nothing has ever spoken an utterance out loud.** `packages/utterance` renders
  strings; no TTS engine has read one, so the prosody of "305 555 1234" is a
  guess. And **no lawyer has read `AI_DISCLOSURE`** — it is committed and pinned,
  which is not the same as reviewed. That signature is Step 8's.
- **`LlmUtterer` has no bound `Phraser`.** Nothing in the tree implements one;
  it is a drafting tool waiting for a credential, and `CachedUtterer` is what
  every code path actually uses.
- **No database, only its schema.** `packages/db` is Drizzle tables and a
  generated migration — no client, no pool, no query helpers, because
  `drizzle-kit generate` needs no database and nothing else in the tree has one.
  The migration has never been applied. `apps/web/lib/demo-data.ts` still seeds
  the dashboard and is typed against the real contracts, so the UI cannot drift.
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
- `utterance`'s `speakWindow` and `workflows`' `formatWindow` are **not**
  duplicates to be merged. The SMS reads `2:00 PM – 6:00 PM`; spoken aloud, an en
  dash is a silence and `2:00` is "two oh oh". Same input, two audiences. Both
  defer DST to `Intl`, so there is no logic to keep in sync.
- `packages/utterance/src/catalog.ts` is **data**. A test walks it and fails on any
  leaf that is not a string, or any `{placeholder}` outside `PLACEHOLDERS`. Adding
  a template function there is how the human review in Step 3.3 stops being a
  review — a reader of functions has to simulate them to know what a caller hears.
- `packages/db` enums are spread from Zod with a `variants()` helper, because
  `z.enum(...).options` is a *readonly* tuple and `pgEnum` wants a mutable one.
  Widen `Object.values(schema)` to `unknown[]` before drizzle's `is(v, PgTable)`
  can narrow it — the module's exact table types are not assignable to the
  generic `PgTable`.
- `drizzle-kit generate` reads the schema and needs no `DATABASE_URL`. Regenerate
  the migration in the same commit as a schema change; `migrate` and `push` are
  the ones that want Neon.
- Adding a variant to a contract enum without regenerating the migration is
  caught by `db/src/schema.test.ts`, not by `tsc`.
- `CallRuntime` arms **exactly one slot per turn** — the machine's focus slot.
  Out-of-order fills and multi-state advances live in `SlotBook`/`machine.ts`, but
  the extractor is only ever asked the one focused slot. Do not "optimise" it into
  extracting several fields per utterance: that is the sequential-tool-call task
  VoiceAgentBench shows models failing, and principle #1 is enforced at this layer
  too, not just in the tool schema.
- `runtime`'s `validateSlot` and `eval/src/simulate.ts`'s `toEvent` both dispatch a
  raw extraction to the three validators. **Not duplicates to merge:** `toEvent`
  also builds a `MachineEvent` for a text-driven harness, and the two pull apart the
  moment either changes. The validator *set* is the contract; a new one is a compile
  error in both. As of Step 5.1 the **outage-retry policy** is a third deliberate
  twin: `eval`'s `extractAndBuild` retries an `unavailable` once and then drives
  `AGENT_ERROR`, exactly as `CallRuntime.extractAndApply` does. Same contract, two
  sides of the port — do not let one drift, or the eval misreports the runtime.
- Regenerate `apps/agent/contracts.schema.json` with `npm run gen:contracts` in the
  same commit as any change to `Effect` or `PendingBooking`; `contracts/src/codegen.test.ts`
  fails the build otherwise. `contracts.py` is a generated, `.gitignore`d artifact —
  never hand-edit it (plan, §10.4).

---

## Change log

- **Step 5 (core) — the eval binds the real `SlotExtractor` port.** *(616 tests, 99.19% coverage,
  typecheck clean, `apps/web` builds.)* `packages/eval/src/simulate.ts` no longer bakes the
  extracted value into the scenario: a fill now *declares* which slot a turn states and *scripts
  the fake*, and the caller's utterance text flows text → `SlotExtractor` → validators → machine —
  the same path `CallRuntime` performs. `SimulationDeps` gains `makeExtractor: (scenario) =>
  SlotExtractor`; `evalDeps()` binds `FakeExtractor` scripted from each scenario (`extractors.ts`,
  `scriptFromScenario`), and the nightly arm binds `AnthropicExtractor` over the same seam
  (`anthropicExtractor(client)`), proven offline through an injected `fetch` against a committed
  `tool_use` body — zero live model calls. The outage-retry-then-`AGENT_ERROR` policy now mirrors
  `CallRuntime.extractAndApply` on both sides of the port; the two are the same contract, and a
  suite that let one drift would misreport what the runtime does.

  **One boundary moved:** `eval` now depends on `@ledgerline/extraction` **at runtime** (and
  declares `@anthropic-ai/sdk`, used only to type the client it hands to `AnthropicExtractor`).
  The dependency diagram always anticipated this — "eval binds it as of Step 5.1."

  **What is deferred, and named** — the same precedent as Steps 1–4's live halves: the nightly
  `AnthropicExtractor` arm has never called a live model, so re-recording the fixtures and the live
  prompt-cache assertion is task 5.5; the LLM-driven caller personas (5.2, `claude-opus-4-8`) and
  the real-SIP barge-in/turn-take arm (5.3) need a credential and a SIP trunk this environment does
  not have. 5.4's turn-take gate already lives in `runtime.test.ts`, over real traced turns; the
  text-driven eval has no latency model, so its turn-take number is the SIP arm's.

- **Step 4 (core) — `packages/runtime` + `apps/agent` scaffold + codegen.** *(611 tests, 99.18%
  coverage, typecheck clean, `apps/web` builds.)* The `Effect[]` binding, made real and testable
  without a phone. `CallRuntime` drives a whole call — greeting and the AI disclosure first, then
  extract-one-slot-per-turn, read-back-and-confirm, correction that revokes a confirmation, an
  outage that retries once and then escalates as `AGENT_ERROR`, a hazard on an ASR partial that
  short-circuits the turn before the extractor is asked — and posts a `PendingBooking` to a
  `BookingSink` on hangup. Every spoken and heard turn is a `CallTurn`, so `checkBudgets()` scores
  the runtime's own output and a scripted silent turn breaches `turnTakeRate`. `GoogleGeocoder`
  (task 4.7) ships behind the `Geocoder` port, tested against transcribed wire shapes. Task 4.1's
  codegen emits the worker JSON Schema from the Zod with a PR-suite drift guard.

  **Four boundaries moved, and every one is a principle.** *(1)* The `VoiceSession` port **speaks
  and returns `SpeechOutcome`** rather than emitting `MachineEvent`: a validated `SLOT_FILLED` is
  something only `CallRuntime` can build, because the geocoder decides what an address is, not the
  audio layer (principle #3). *(2)* `HttpTransport`/`FetchTransport` moved from `crm` into
  `contracts`, because `validators` now speaks HTTP too and `validators → crm` points the graph
  backwards — a port crossing a package boundary belongs in the spine, exactly as `Effect` did.
  *(3)* The `AGENT_ERROR` machine event was added: `EscalationReason.AGENT_ERROR` and its catalog
  line existed with no event that could reach them, and the extractor's `unavailable` outcome now
  does. *(4)* `runtime` depends on `extraction`, `utterance`, and `telemetry` as **devDependencies
  only** — it takes their ports and emits their shapes, so the real implementations are needed only
  to drive and score the tests.

  **What is deliberately deferred, and named:** no telephony, no LiveKit, no realtime model, no
  live Google, no live Housecall Pro. `apps/agent` is a documented scaffold; the 20-live-call exit
  gate cannot be met without a vendor credential. The Pydantic half of the codegen needs a Python
  tool this environment forbids (PEP 668); the JSON Schema it consumes is committed and guarded.
  Tasks 4.2, 4.6, and 4.10 are the credentialed live work — same precedent as Steps 1–3.

- **Step 3 — `packages/utterance`.** *(575 tests, 99.08% coverage, typecheck clean,
  `apps/web` builds.)* Everything the agent says, decided before the call: a committed
  catalog of ~40 strings behind the new `Utterer` port, `CachedUtterer` (ships, no I/O),
  `LlmUtterer` (a drafting tool), and `TemplateUtterer` / `FakePhraser`.

  **Two boundaries moved.** `Effect` and `EscalationAction` left `conversation` for
  `contracts/src/effects.ts`, as Zod: `Utterer.say(effect, ctx)` needs them and `contracts`
  cannot import `conversation`. That turned out to be their right home anyway — task 4.1
  generates the worker's Pydantic from them. And the `Effect` union gained a fifth variant,
  `GREET`, because GREETING requires no slots, so the machine emitted nothing there and **the
  AI disclosure had nowhere to be spoken.** `nextPrompt(ctx)` is exported for the same reason:
  a call opens with no event, and the worker has to be able to ask what to say first.

  **The surprise was that `plan.md` §10.2 was wrong, and wrong in the direction of
  principle #3.** It said `LlmUtterer` exists "for read-back phrasings that interpolate a
  value." Interpolating a value is templating; asking a model to do it is how `1247 Calle
  Ocho` becomes `1247 SW 8th St` and the caller confirms an address they never gave. The
  read-back *is* the verification step. `LlmUtterer` now paraphrases `ASK_FOR` and nothing
  else — the disclosure is legal text, `ESCALATE` is read to someone standing in gas, and the
  closing promises an SMS to one number.

  **The catalog is pure data, and that is the point.** No template functions, no
  concatenation; `fill()` resolves `{business}`, `{value}`, `{phone}`. `git diff catalog.ts`
  is the change-control surface for what a stranger hears when they phone a plumber at
  midnight, and a reviewer of template *functions* would have to simulate them.

  **Unverified, and named:** no TTS has spoken any of it, and no lawyer has read
  `AI_DISCLOSURE`. Committed and pinned is not reviewed. Step 8.

- **Step 2 — `CrmAdapter.readJob` + the outcome pipeline.** *(526 tests, 98.99% coverage,
  typecheck clean, `apps/web` builds.)* The wedge, made computable. `readJob` on both
  adapters behind one shared contract suite; `packages/workflows/src/outcomes.ts` with
  `diffBooking`, the 24h/72h/7d schedule, and a `SnapshotStore` port; `packages/db` with
  the §7 tables and a generated migration. `CRM_WEBHOOK` retired from
  `OutcomeSourceSchema` in favour of `CRM_POLL`.

  **Three boundaries moved.** First, `CrmJobSnapshot` deliberately omits `urgency` and
  `jobTypeId`: Housecall Pro tags urgency, Jobber has no field for it, and a field only
  one adapter can report biases the correction rate *by provider*. That is
  "never add a method only one adapter can implement" applied to a field. Second,
  `OutcomeDeps.crm` is `Pick<CrmAdapter, "readJob">` — the poller observes and must never
  write, and now cannot. Third, `workflows` gained a **devDependency** on `telemetry`, the
  tree's only test-only edge, so the wedge is exercised end to end in one place.

  **The surprise was that most of the work is refusing to report corrections that never
  happened.** A naive diff flags a corrected address on every booking (`formatted` is the
  geocoder's, not the CRM's), a corrected phone on every booking, a reschedule whenever a
  vendor returns `-04:00` instead of `Z`, and a corrected ZIP on every ZIP+4 enrichment.
  The mirror-image bug — an unparsed field read as unchanged rather than unobserved —
  flatters us instead. Both directions have tests.

  **And `computeMetrics()` had a latent bug that only real outcomes could expose.** Three
  polls per booking meant `countCorrected()` counted rows, so `correctionRate` could
  exceed `1.0` — a value `ReliabilityMetricsSchema` rejects. It now counts distinct
  bookings, latest `observedAt` wins. The metric had never met its own data; that is what
  Step 2 was for.

  **Unverified, and named:** `readJob` has never spoken to a live CRM. The vendor status
  vocabularies are transcribed from docs. Task 4.10.

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
