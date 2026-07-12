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
  contracts/     Zod schemas. The spine. Slots, states, effects, bookings, traces, ports, HTTP, FAQ.
  conversation/  SlotBook + the state machine. Pure, no I/O.
  safety/        Deterministic emergency classifier. No LLM dependency.
  validators/    Phone, address (geocoder port + GoogleGeocoder), service area, business hours.
  anthropic/     The vendor boundary: the outage taxonomy + the wire-level test transport. No prompts.
  extraction/    The Anthropic slot extractor. One tool, one field, one turn.        (call site #2)
  faq/           Retrieval + selection. The model picks a committed answer, never writes one. (#3)
  triage/        The correction classifier. Was the contractor's edit our mistake?    (#5)
  utterance/     Everything the agent says. Committed catalog, decided before the call.
  crm/           CrmAdapter interface + Housecall Pro + Jobber. Writes and reads.
  runtime/       CallRuntime. The Effect[] binding: caller ASR → machine → VoiceSession.
  workflows/     Saga engine + post-call booking transaction + the outcome poller + triage batch.
  billing/       Per booked job — and never for a booking we got wrong.
  telemetry/     Reliability metrics + latency/turn-taking budgets + the publication rule.
  db/            Drizzle schema + migrations + RLS + the tenant-scoped client + the Postgres stores.
  eval/          Simulated-caller harness. Scenarios run in CI, over the real SlotExtractor port.
apps/
  web/           Next.js dashboard, the reliability page, and the two crons.
  agent/         Python LiveKit worker scaffold + generated Pydantic. No hardware yet (Step 4.2/4.6).
```

### Dependency direction

```
contracts ──► conversation ──► validators ──► eval
    │              │               ▲   │        ▲
    ├──► safety ───┼───────────────┘   │────────┘
    ├──► extraction ───────────────────┼─────────┘  (eval binds it as of Step 5.1; runtime binds it in tests)
    ├──► faq ─────────────────────────────┄┄─────►  (runtime binds it in tests)
    ├──► triage ──────────────────────────┄┄─────►  (workflows binds it in tests)
    ├──► utterance ────────────────────┤            (runtime binds it in tests)
    ├──► crm ──► workflows ┄┄► {telemetry, triage}  (┄ = test-only)
    ├──► runtime ┄┄► {extraction, faq, utterance, telemetry}  (runtime deps: conversation, safety, validators)
    ├──► billing ──► web
    ├──► telemetry ──► web
    └──► db ──► web        (db ┄┄► faq: test-only, to prove both FaqIndex impls rank alike)

anthropic ──► {extraction, faq, triage}    (the SDK; depends on nothing of ours)
```

**Three packages speak to a model, and each depends on `contracts` alone (plus the SDK).**
`extraction` (call site #2), `faq` (#3), and `triage` (#5) each own their prompt, their tool, and
their outcome type. Nothing else in the tree imports `@anthropic-ai/sdk`: `runtime` binds a
`SlotExtractor` and an `FaqAnswerer`, `workflows` binds a `CorrectionTriager`, and `utterance`'s
`LlmUtterer` reaches a model through a local `Phraser` port. Ports down, implementations at the
edge.

`packages/anthropic` is the **vendor** boundary, not a call site: `isOutage`/`outageReasonOrThrow`
(what a `429` means, versus a `400` that must crash) and `RecordingTransport`/`testClient`/`replay`
(how a binding is proven with no credential). Both are properties of the API rather than of any one
call site, and three private copies would drift silently — the same argument that moved
`HttpTransport` into `contracts` in Step 4. It holds no prompts, no tools, and no domain types.

`eval` depends on `extraction` **at runtime**, as of Step 5.1 — the dependency diagram always
anticipated it ("eval binds it as of Step 5.1"). `simulate.ts` drives the real `SlotExtractor`
port; `eval/src/extractors.ts` binds `FakeExtractor` (scripted from each scenario's fills, the PR
arm) and `AnthropicExtractor` (the nightly arm, `anthropicExtractor(client)`). `eval` therefore
also declares `@anthropic-ai/sdk`, but only to *type the client* it hands to `AnthropicExtractor`;
it never constructs one in shipping code, and the PR suite never calls a live model. The nightly
binding is proven offline through an injected `fetch` against a committed `tool_use` body, exactly
as `extraction`'s own replay suite works.

`runtime` is the Step 4 `Effect[]` binding. It depends on `contracts`, `conversation`, `safety`,
and `validators` at runtime, and on `extraction`, `faq`, `utterance`, and `telemetry` **as
devDependencies only**: `CallRuntime` speaks to those through ports (`SlotExtractor`, `FaqAnswerer`,
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

**`db` depends on `contracts` alone (plus its drivers), and only `apps/web` depends on `db`.**
Every `pgEnum` is spread from a Zod schema rather than retyped, so the tables cannot drift from
the domain. As of Step 7 it also holds the tenant-scoped client (`withTenant`), the RLS
migration, and the Postgres stores — `PgSnapshotStore`, `PgOutcomeStore`, `PgBookingStore`,
`PgTriageStore`/`PgAuditStore`, `PgVectorFaqIndex`. It carries a **devDependency on `faq`**, used
in one test to prove `PgVectorFaqIndex` and `InMemoryFaqIndex` rank identically; do not promote
it.

**The store ports live in `contracts`, not in the packages that consume them.** `SnapshotStore`,
`OutcomeStore`, `BookingStore`, `TriageStore`, `AuditStore`, `FaqIndex`, and `Embedder` are all
in `contracts/src/stores.ts`. They used to live in `workflows` and `faq`, which was right while
the only implementations were in-memory doubles beside them — but `db` cannot implement a port it
would have to depend on `workflows` to see, and `db → workflows → crm` points the graph
backwards. Same rule as `Effect` (Step 3) and `HttpTransport` (Step 4): **a port that crosses a
package boundary belongs in the spine.** `workflows` and `faq` re-export them from where they are
used, exactly as `machine.ts` re-exports `Effect`. The in-memory doubles stay put; they are test
doubles, not contracts.

`isAgentError` and `latestPerBooking` are in `contracts` for the same class of reason
`isCorrected` is: **three packages now ask "was this booking our fault"** — `telemetry` publishes
the number, `workflows` decides what to send the model, and `billing` decides whether to *charge*.
A disagreement between them invoices a contractor for a booking we publicly called our own error.

`workflows ┄┄► {telemetry, triage}` are **devDependencies**. `outcomes.test.ts` drives a
hand-edited job body through the real adapter, the real poller, and the real `computeMetrics()` —
the one place the whole wedge is exercised end to end. `triage.test.ts` drives the real
`runTriage()` against `FakeTriager`; the *real* `AnthropicTriager` is bound by the cron in Step 7,
never by `workflows` itself. Do not promote either to a runtime dependency.

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
what ships — may paraphrase `ASK_FOR` and nothing else. The other six effects
each carry content, not wording:

- `GREET` carries the AI disclosure. Legal text. Pinned character-for-character.
- `READ_BACK` **is** the verification step. A model that "naturally" renders
  `1247 Calle Ocho` as `1247 SW 8th St` earns a cheerful yes to an address the
  caller never gave, and books a truck to it. Interpolating a value is
  templating, not generation — `fill()` does it, and it is nine lines.
- `ESCALATE` carries life-safety guidance, read to someone who may be standing in
  a room filling with gas.
- `CREATE_PENDING_BOOKING` promises an SMS to one specific number.
- `SAY_FILLER` is spoken *before* we know whether the FAQ has an answer, so it must
  promise nothing.
- `ANSWER_FAQ` carries the contractor's own committed sentence about price, policy,
  or hours — retrieved verbatim.

Widening that check in `llm.ts` fails five tests. `plan.md` §10.2 originally said
the opposite; it was wrong, and Step 3 surprise #3 says why.

**And the FAQ model *selects* a sentence; it never writes one.** `packages/faq` hands
`claude-sonnet-5` the retrieved candidates and a forced tool whose only field is an
`entry_id`. The caller then hears `faq_entries.answer` byte for byte. Generating an
answer from retrieved context — the obvious design, and what §6 originally implied —
is a model quoting a price on a recorded line that the contractor never approved, and
it fails exactly the way a paraphrased `READ_BACK` fails: fluently, plausibly, and
wrongly. An `entry_id` we never sent comes back `unknown`, because a hallucinated id is
a sentence nobody wrote.

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

**Step 6 asks *why* a booking was corrected, and every safeguard exists because the
model answering is an interested party.** `packages/triage` classifies each diff
`agent_error | business_change | enrichment`; `packages/workflows/src/triage.ts` runs
the batch; `packages/telemetry` decides what may be said out loud. Five rules:

- **`correctionRate` stays raw.** Triage produces `agentErrorRate` *beside* it and
  never subtracts from it. Redefining the headline metric because a classifier says
  most failures "weren't really ours" is the behaviour that makes every competitor's
  reliability claim worthless.
- **An unclassified correction is an agent error.** `null` is guilt, not innocence. A
  declined verdict, an Anthropic outage, a cron nobody wired up — each leaves the
  correction counting against us, so *every failure mode of the triage pipeline pushes
  the published number up*. The inverse is the missed webhook wearing a third hat: a
  metric whose failure mode is "looks perfect".
- **The raw diff is never written, and that is a type.** `TriageStore.classify` takes
  the derived columns and cannot express an edit to `correctedFields` — the same move
  as `Pick<CrmAdapter, "readJob">`.
- **A verdict without a rationale is `declined`.** An unauditable exoneration is
  precisely what this call site must not be able to produce.
- **The classifier is licensed, not trusted.** `publishedCorrectionRate()` quotes
  `agentErrorRate` only while ≥20 corrections carry a human label
  (`MIN_AUDITED_OUTCOMES`) *and* the model agrees with the auditor ≥95% of the time
  (`AUDIT_AGREEMENT_FLOOR`). Otherwise it quotes the raw rate and says why. The audit
  sample is chosen by hashing the booking id — stable, so a disliked week cannot be
  re-rolled, and assigned before the outcome existed, so it cannot be steered.

### 6. Tenant isolation is a property of the database, not of our queries

`packages/db/migrations/0002`, and `rls.test.ts` is the evidence. Every tenant-scoped table
has row-level security `ENABLE`d **and** `FORCE`d, with a policy on
`current_setting('app.tenant_id')`. The stores also pass a tenant id explicitly. That is
deliberate redundancy: the `WHERE` clause is a habit, and habits lapse — a missing one is a
distracted afternoon away, and its consequence is a plumber reading another plumber's calls.

- **The application must not connect as the table owner.** Postgres exempts a table's owner
  from RLS unless the table is FORCEd, and exempts a **superuser even then**. Neon's default
  connection string is the owner. Connect as it and every policy in `0002` does exactly
  nothing — no error, no warning, and every test written against that connection passes with
  the policies deleted. `DATABASE_URL` names `ledgerline_app` (`APP_ROLE`), which owns nothing.
  There is a **passing test asserting the owner sees both tenants' rows**. It reads like a bug.
  It is the documentation, and deleting it is how the next person concludes the policies alone
  are the guarantee.
- **The tenant is set per *transaction*, never per session.** `withTenant()` uses
  `set_config(..., is_local => true)`. A session-level `SET` on a pooled connection hands the
  next request the previous tenant's id — a cross-tenant read with no bug in any query. This is
  also why the driver is `drizzle-orm/neon-serverless` and **not** `neon-http`: the HTTP driver
  has no transactions, so it cannot scope anything.
- **Denormalized `tenant_id` cannot disagree with its parent, and that is a foreign key.** RLS
  needs `tenant_id` on `call_turns`, `slots`, `escalations`, `bookings`, `job_snapshots`, and
  `outcomes` — a per-row `USING` clause cannot afford a three-level join. Each carries a
  **composite FK** on `(parent_id, tenant_id)`. A row filed under the wrong tenant fails the
  database, not a code review.
- **`TENANT_SCOPED_TABLES` is the specification, and the test reads the database back against
  it.** Add a table with a `tenant_id` and forget its policy: the suite fails.
- **The raw diff is append-only by *privilege*, as well as by type.** `ledgerline_app` holds
  `UPDATE` on `outcomes`' seven derived columns and nothing else, and no `DELETE` on `outcomes`
  or `job_snapshots`. `TriageStore.classify` already could not express that edit (principle #5);
  this holds for a raw `db.execute()` that never went near the port.

### 7. We do not bill for a booking we got wrong

`packages/billing`. Per booked job rather than per minute — but that only fixes the obvious
perversion (per-minute pricing pays us to keep a homeowner on the phone). The worse one is that
if we bill for every job that reaches the CRM, **our own error rate becomes an income stream**,
and we are the company that publishes its error rate. Those two facts cannot both be true of one
business.

So `billable = !cancelled && !isAgentError(outcome)`, with `isAgentError` imported from
`contracts` — the same predicate `telemetry` computes the published number from. And because
an *unclassified* correction counts as our fault (principle #5), a triage backlog, a declined
verdict, an Anthropic outage, or a cron nobody wired up each cost us **money**, not merely a
worse published number. `Invoice.staleTriage` reports how much, because the first symptom of a
broken cron must never be a quiet drop in revenue.

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

774 tests, 99.31% line coverage, thresholds enforced in `vitest.config.ts`.

| Layer | Where | What it proves |
|---|---|---|
| Schema invariants | `contracts` | The graph is connected, terminal states have no successor, every slot has both a spec and an extraction schema, every `Effect` parses. And the worker JSON Schema is byte-current with the Zod — the codegen drift guard |
| Unit | `conversation`, `safety`, `validators` | Slot mechanics, hazard precision/recall, phone/address/window rules, and `GoogleGeocoder`'s status→outcome mapping against transcribed wire shapes |
| Review surface | `utterance` | The catalog is data, not template functions; every slot has an ask and a read-back; the AI disclosure is byte-for-byte what it was; `LlmUtterer` refuses to reword anything but `ASK_FOR` — including the FAQ answer |
| Replay | `extraction`, `faq`, `triage` | Committed model responses driven through the **real** tool schemas and the real contracts. **Zero live model calls** anywhere — the SDK's `fetch` is injected (`@ledgerline/anthropic`). A suite whose green depends on a third party's uptime teaches the team to ignore red. Each asserts its cached prefix is byte-identical across two different inputs, and that a `400` throws while a `429` degrades |
| Selection, not generation | `faq` | The caller hears the contractor's committed answer verbatim; an `entry_id` the model invented comes back `unknown`; nothing above the floor means **no model call at all**; one tenant's answers never reach another's caller |
| The interested party | `triage` + `workflows` | The classifier declines without a rationale, declines a label outside the enum, and cannot write to `correctedFields` (a type error). An outage and a decline both leave the correction counting against us, and neither aborts the batch |
| Contract | `crm` | **One suite, both adapters.** If it passes for Housecall Pro and Jobber, the interface is not a rename of one vendor's endpoints. `readJob` is asserted in our vocabulary against each vendor's |
| Runtime | `runtime` | A whole call driven through the **real** machine, classifier, validators, and `Effect[]` binding against `FakeVoiceSession` — greeting/disclosure first, out-of-order-safe read-backs, correction revokes confirmation, extraction outage retries then escalates as `AGENT_ERROR`, hazard on an ASR partial short-circuits before the extractor, a caller's question detours through the FAQ (filler first, then the answer, then the same slot re-asked) without counting as an extraction failure, and every turn traced so `checkBudgets()` scores it (silence breaches `turnTakeRate`) |
| Drift | `db` | Every `pgEnum` equals its Zod source, and the `pgvector` column is the width `contracts` declares |
| **Tenancy** | `db` | **A real Postgres**, in-process (PGlite), with the **real committed migrations** applied and connected as the **real app role**. One tenant cannot read another's rows, write into another's tenant, or reach another's FAQ answers through the retrieval index; an unscoped connection sees *nothing*; a session-level GUC leaks and is caught; a call turn filed under the wrong tenant fails the FK; the app role cannot `UPDATE corrected_fields` or `DELETE` an outcome. And a passing test asserts **the owner bypasses RLS entirely** — the fact a deployment gets wrong silently |
| Store contract | `db` | The Postgres stores against the same expectations as the in-memory doubles, `PgVectorFaqIndex` ranking identically to `InMemoryFaqIndex`, and the SQL `WHERE` for "corrected" agreeing with `contracts`' `isCorrected()` over the same rows |
| Integration | `workflows` | The booking saga, including the forced `create_job` failure and its compensating rollback. The outcome poller — a hand-edited job body through the real adapter, the real diff, and the real `computeMetrics()`. The nightly triage batch. And the cron: a CRM outage records nothing, consumes no poll, does not abort the batch, and the poll it owed is picked up by the next run |
| The published number | `telemetry` | `agentErrorRate ≤ correctionRate`, always; an untriaged correction counts as our fault; the human overrules the model; and `publishedCorrectionRate()` refuses the classifier below 20 audited labels or 95% agreement |
| The invoice | `billing` | We do not bill for a cancelled booking, an agent error, or **a correction nobody has classified**. The human auditor can move money in either direction. And an identity: every booking `telemetry` counts as an agent error is a booking `billing` waived — they import the same predicate, and this asserts they cannot drift |
| End-to-end | `eval` | Simulated callers through the real machine, classifier, validators, **and `SlotExtractor` port** — a fill scripts `FakeExtractor`, and the value flows text → port → validators → machine; the nightly `AnthropicExtractor` binding is driven offline through an injected `fetch` |

### Rules

- **Assert on behaviour, not implementation.** The eval harness records
  `readBacks` precisely because asserting the final *value* would also pass a
  system that silently kept a stale confirmation.
- **Mutation-test the invariants that matter.** Break the thing, confirm the
  suite screams, revert. Twenty-four are verified: revoking confirmation on
  correction (caught in 3 places); in-phrase fuzzy matching (drops recall to
  0.974); in `extraction`, dropping `thinking: {type:"disabled"}`, skipping the
  Zod re-validation of the model's output, interpolating a per-call value into
  the cached prompt prefix, and widening `UrgencySchema` in `contracts`; in
  the outcome pipeline, swallowing a `503` in `readJob`, treating an unreported
  field as a correction, counting outcome rows instead of bookings (caught in 2
  places), reading Jobber's truncated `title` instead of `instructions`,
  comparing `postalCode` exactly, comparing phone numbers as strings, and
  restoring `CRM_WEBHOOK` to the contract; in `utterance`, letting
  `LlmUtterer` paraphrase anything beyond `ASK_FOR` (caught in 5 places, now
  including `ANSWER_FAQ`), rewording `AI_DISCLOSURE`, reading back the caller's raw
  address instead of the geocoder's `formatted`, dropping the tenant timezone from
  `speakWindow`, and removing `GREET` from `nextPrompt`; and, added in Step 6:
  treating an **unclassified correction as not-our-fault** in `telemetry`,
  publishing the triaged rate without the human audit's licence (fails 5 tests),
  running the **FAQ detour before extraction** so a filled slot is spent on a
  question (fails 2), speaking an FAQ `entry_id` the model invented, and sampling
  the weekly audit with `Math.random()` instead of hashing the booking id; and,
  added in Step 7: making `withTenant`'s `set_config` **session-level instead of
  transaction-local** (the tenant leaks to the next request on a pooled connection —
  exactly one test catches it), **billing an unclassified correction**, and letting a
  **failed poll consume the poll it still owes** (fails 2).
  **`TriageStore.classify` writing `correctedFields` is not on this list because it
  is a type error, not a test failure** — which is the stronger guarantee. As of Step 7
  it is *also* a Postgres permission error, which holds for a raw `db.execute()`.
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
- **The crons exist, and have never run.** `apps/web/app/api/cron/{poll-outcomes,triage}`
  call `runOutcomePolls()` and `runTriage()`, and `vercel.json` schedules them (hourly,
  and 02:00 nightly). `bookings.completed_polls` is now a column somebody increments.
  What they have never had is a deployment: no Neon, no `CRON_SECRET`, no Vercel project.
  Their bodies are tested (`poller.test.ts`, `triage.test.ts`, `stores.test.ts`); the
  routes themselves are eight lines of wiring apiece and are not.
- **The correction triager has never spoken to a live model, and no human has ever
  audited a label.** `packages/triage` is real code against the real SDK, proven
  offline through an injected `fetch` against **hand-authored** fixtures — the same
  honesty as `extraction`'s. So we know the binding works, the enum holds, and a
  rationale-less verdict is refused. We do **not** know whether `claude-opus-4-8`
  labels a real correction the way a human would, and that number — the agreement
  rate — is the licence to use the classifier at all. `publishedCorrectionRate()`
  already assumes the answer is "not yet" and quotes the raw rate (task 6.5).
- **The FAQ has an index now, and still has no real embedder.** `PgVectorFaqIndex` ships
  and is tested against a real Postgres: it ranks identically to `InMemoryFaqIndex`, and it
  cannot be made to speak one contractor's prices to another's caller even when handed the
  wrong tenant id. But **`HashingEmbedder` is still the only `Embedder` bound** — a
  deterministic bag-of-words stand-in with **no semantics**: "how much do you charge" and
  "what does it cost" score zero against each other. So `SIMILARITY_FLOOR` (0.15) is still
  calibrated against the fake, which is to say against nothing, and `faq_entries` has never
  held a production row. **Task 6.6 needs an embedding credential, not a database** — which
  is exactly why Step 7 could ship the index half and not this one.
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
- **A real database, and no Neon.** This is the one entry that improved in kind rather
  than degree. `packages/db` now has a client, RLS, and the Postgres stores, and all three
  migrations are **applied to an actual Postgres in the PR suite** — PGlite, in-process, no
  credential — so tenant isolation, the composite FKs, the column grants, and `pgvector`'s
  cosine ranking are *proven* rather than asserted. What is unproven is one `Pool` and a
  URL: `neonDatabase()` has never connected to a live Neon (task 7.7), and it is the only
  thing in `packages/db` that has not met a real Postgres. `apps/web/lib/demo-data.ts` still
  seeds the dashboard and is typed against the real contracts, so the UI cannot drift.
- **No auth provider.** The seam is built — `TenantResolver`, and every route funnels
  through it into `withTenant()` — but nothing binds Clerk, because no key exists (task
  7.6). `envTenantResolver` names one tenant from the server's own environment, and
  deliberately *not* from a header or a query parameter: a `?tenant=` a client could set is
  not a stub for auth, it is a hole, and holes ship. **Isolation does not depend on the
  identity provider**; it lives in the database, so binding Clerk changes one file.
- **No onboarding, and no per-tenant CRM credential.** Housecall Pro OAuth needs a developer
  account (task 7.5), so `tenants.crm_credentials_enc` holds a sentinel and the token comes
  from the environment — correct for exactly one tenant and a *lie* for two. So
  `crmForTenant()` **refuses** a stored credential rather than falling back to another
  tenant's token: a cross-tenant CRM write is the worst bug this system could have, and it
  must not be reachable by forgetting to finish a task.
- **Billing computes an invoice and charges nobody.** `packages/billing` is real and fully
  tested; there is no Stripe, no payment method, and no dunning.
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
- **The FAQ detour is gated on extraction having already returned `absent`, and the
  order is the safety property.** Move `shouldAnswerQuestion()` ahead of the extractor
  and a caller saying "what? oh, Rosa Peña" loses their name to a filler utterance. Two
  `runtime` tests fail if you do. The bound (`maxFaqAnswers`, 3) matters too: a caller
  who only ever asks questions must fall back into the ordinary extraction-failure path,
  which ends in a human.
- **`CREATE EXTENSION IF NOT EXISTS vector;` in `migrations/0001` is hand-added**, and it
  is the only hand-written line in any migration here. `drizzle-kit generate` emits the
  `vector(1024)` column and the HNSW index but never the extension, so a generated-only
  migration fails on its first statement against a fresh Neon. Migrations are
  append-only, so regenerating will not delete it — but a future migration that
  reintroduces `vector` on a database where `0001` never ran would need it again.
- `packages/db`'s `vector("embedding", { dimensions: FAQ_EMBEDDING_DIMENSIONS })` and
  `packages/faq`'s `Embedder` must agree on the width, which is why the constant lives in
  `contracts`. A disagreement is an insert that fails in production and nowhere else.
- **Extended thinking and a forced `tool_choice` cannot both be set** in the Messages API
  (thinking permits `auto`/`none` only). Every model binding here forces the tool and
  disables thinking. In `triage` that is a *deliberate* trade — a nightly batch could
  afford the latency, but a label parsed out of a paragraph is a label that silently
  mislabels whatever it fails to parse.
- `packages/anthropic` holds `isOutage`/`outageReasonOrThrow` and the test transport, and
  **nothing else**. Do not put a prompt, a tool, or a domain type in it: the moment it
  knows about slots, it stops being the vendor boundary and becomes a second `contracts`.
- **`DATABASE_URL` must name `ledgerline_app`, not Neon's default role.** The default is the
  table owner, and Postgres exempts an owner from RLS unless the table is FORCEd — and a
  *superuser* even then. Connect as it and every policy is decoration. See principle #6;
  `rls.test.ts` has a passing test proving the bypass exists, and it is not a bug.
- **`drizzle-orm/neon-http` cannot be used.** It has no transactions, so `withTenant()`
  cannot `set_config(..., is_local => true)`, so `app.tenant_id` is never set, so every RLS
  policy evaluates against NULL and every query returns nothing. It is the driver Vercel's
  docs reach for first. Use `neon-serverless` (the WebSocket pool).
- **PGlite is pinned to `0.4.x` and lives in the *root* devDependencies.** `0.5` dropped the
  `./vector` export, and `drizzle-orm` resolves `@electric-sql/pglite` from its own location,
  so a copy nested under `packages/db/node_modules` is invisible to it.
- **`packages/db/src/testing.ts` is not exported from `index.ts`,** and must not be:
  `apps/web` imports `@ledgerline/db` and has no business bundling a WebAssembly Postgres.
- **`drizzle-kit generate` emits composite foreign keys *before* the unique constraints they
  reference**, which Postgres rejects. Migration `0002` is hand-reordered, and its RLS section
  is hand-written (drizzle emits no `FORCE`, no roles, no column-level grants). Run the
  migrations after regenerating — `rls.test.ts` does, which is how we found this.
- **`bookings.completed_polls` is incremented relatively (`= completed_polls + 1`), in the
  database.** Reading it and writing `n + 1` means two overlapping cron runs both read 0 and
  both write 1 — the booking is polled twice at 24h and never at 72h.
- **A failed poll must not increment `completedPolls`.** The poll is still owed. That is the
  entire reason the column is a counter rather than a timestamp, and a booking never polled is
  a correction never counted — which reads as a *better* number than the truth.
- **Vercel Cron sends `GET`.** A route exporting only `POST` deploys, schedules, and never
  fires. A missing `CRON_SECRET` is a refusal, never a bypass — `if (!secret) return true`,
  so it "works in development", is how the check ships disabled.
- `packages/billing` must import `isAgentError` from `contracts` and never restate it.
  `telemetry` computes the number we publish from the same predicate, and a drift between them
  invoices a contractor for a booking we called our own error. `invoice.test.ts` asserts the
  identity.

---

## Change log

- **Step 7 (core) — tenancy, the crons, and billing that refuses our own money.** *(774 tests,
  99.31% coverage, typecheck clean, `apps/web` builds — 6 routes.)* Every step before this one
  ended with the same sentence: *real code, real port, never met the vendor.* Step 7 is the first
  where **the vendor came to us.** Postgres compiles to WebAssembly, so the schema, all three
  migrations, the RLS policies, the column grants, `pgvector`'s cosine ranking, and every store
  now run against an *actual* Postgres in the PR suite — in-process, no credential, no network.
  Tenant isolation is **proven**, not argued. `packages/db` gains a client (`withTenant`), the
  Postgres stores, and migration `0002`; `packages/billing` is new; `apps/web` gains the two crons
  that finally call the poller and the nightly triage pass, and a reliability page that leads with
  the number we would least like to write.

  **"Tenant isolation via Postgres RLS" is not what protects you — the connection role is.**
  Postgres exempts a table's **owner** from row-level security unless the table is FORCEd, and
  exempts a **superuser even then**. Neon's default connection string is the owner. So the
  obvious deployment — write the policies, take the URL Neon hands you, ship — produces a
  database with a complete set of RLS policies that **do nothing**, with no error and no warning,
  where every test written against that connection passes with the policies deleted. Hence
  `ledgerline_app`, which owns nothing; hence `FORCE` on all fourteen tables; and hence a
  **passing test asserting that the owner sees both tenants' rows.** It reads like a bug. It is
  the documentation, and it is there so nobody mistakes the policies for the guarantee.

  **Two more things the database enforces that a review cannot.** *(1)* RLS needs `tenant_id`
  denormalized onto six child tables, because a per-row `USING` clause cannot afford a
  three-level join up to the owning tenant — so each one carries a **composite foreign key** on
  `(parent_id, tenant_id)`, and a row filed under the wrong tenant fails the database rather than
  a code review. *(2)* `ledgerline_app` holds `UPDATE` on `outcomes`' seven derived columns and
  **nothing else**, and no `DELETE` at all: Step 6.2 made "the raw diff is never written" a type
  error, and it is now also a permission error, which holds for a raw `db.execute()` that never
  went near the port.

  **And the tenant is scoped per transaction, never per session.** `set_config(..., is_local =>
  true)`, because a pooled connection carries a session-level `SET` into the *next* request —
  a cross-tenant read with no bug in any query. That also rules out `drizzle-orm/neon-http`, the
  driver Vercel's docs reach for first: it has no transactions, so it cannot scope anything.

  **Three boundaries moved.** *(1)* The **store ports** — `SnapshotStore`, `TriageStore`,
  `AuditStore`, `FaqIndex`, `Embedder`, plus the new `OutcomeStore` and `BookingStore` — moved
  into `contracts`. `db` cannot implement a port it would need `workflows` to see, and
  `db → workflows → crm` points the graph backwards; same rule as `Effect` (Step 3) and
  `HttpTransport` (Step 4). *(2)* `isAgentError` and `latestPerBooking` moved into `contracts`,
  because three packages now ask "was this our fault." *(3)* `db` is no longer a leaf: `db → web`.

  **Billing per booked job is not the incentive alignment — refusing to bill for a booking we got
  wrong is.** Per-minute pricing pays us to keep a homeowner on the phone; per-booking pricing
  fixes that and leaves a worse perversion standing, because if we bill for every job that reaches
  the CRM then **our own error rate is an income stream**, and we are the company that publishes
  its error rate. So `billable = !cancelled && !isAgentError(outcome)`, sharing `telemetry`'s
  exact predicate. Which means an *unclassified* correction is unbilled: a triage backlog, an
  Anthropic outage, or a cron nobody wired up now costs us **money**, not merely a worse published
  number. `Invoice.staleTriage` reports how much, because the first symptom of a broken cron must
  not be a quiet drop in revenue.

  **What is deferred, and named:** no Clerk key (7.6 — the seam is built and isolation does not
  depend on it), no Housecall Pro OAuth (7.5 — so `crmForTenant()` *refuses* a stored credential
  rather than falling back to another tenant's token), no live Neon (7.7), no Stripe, and still
  no real `Embedder` (6.6 needs a credential, not a database).

- **Step 6 (core) — correction triage, the human audit, and the FAQ detour.** *(708 tests, 99.29%
  coverage, typecheck clean, `apps/web` builds.)* Step 2 made the wedge computable: *that* a booking
  was corrected. Step 6 asks *why*, and the entire step is an argument with itself about how a model
  grading our own homework could cheat. `packages/triage` (call site #5) classifies each diff behind
  the new `CorrectionTriager` port — one forced strict tool, a mandatory rationale, and a system
  prompt whose last paragraph tells the model to be *harder* on itself. `packages/workflows/src/triage.ts`
  runs the nightly batch and owns the stores. `packages/faq` (call site #3) answers a caller's
  question behind a filler utterance, and `CallRuntime` performs the two new effects that carry it.

  **The most dangerous sentence in `plan.md` was "only `agent_error` counts against
  `correctionRate`".** Read literally, triage becomes a machine for deleting our own failures: a
  classifier that declines, an outage, or a cron nobody wired up would each *silently improve* the
  published figure — the missed-webhook failure mode wearing a third hat. So `correctionRate` stays
  **raw**, `agentErrorRate` is computed beside it, **an unclassified correction counts as an agent
  error**, and `publishedCorrectionRate()` refuses to use the classifier below 20 audited labels or
  95% human agreement. Every failure mode of this pipeline now pushes the published number *up*.

  **Three boundaries moved.** *(1)* `packages/anthropic` is new: three packages now speak to the
  vendor, and what a `429` means — plus how a binding is proven with no credential — belongs in one
  place, not three. The old rule ("the SDK lives in `extraction` and stays there") is retired. *(2)*
  `Effect` gained `SAY_FILLER` and `ANSWER_FAQ`, the only two effects `transition()` never emits;
  they change no slot, state, or guard, and `RUNTIME_ONLY_EFFECT_TYPES` names them so nobody
  concludes they are dead. *(3)* `isCorrected` and `effectiveLabel` moved into `contracts`, because
  `telemetry` and `workflows` must not disagree about what "corrected" means or whose label wins
  (the human's).

  **The FAQ model selects an answer; it never writes one.** `plan.md` §6 said "tool use +
  `pgvector` retrieval", which reads like RAG — and RAG here is a model quoting a price on a
  recorded line that the contractor never approved. The tool returns an *id*; the caller hears
  `faq_entries.answer` verbatim; an id we never sent comes back `unknown`. That is principle #3
  arrived at from the other end, and it makes the FAQ table a review surface owned by the
  contractor exactly as `catalog.ts` is one owned by us.

  **What is deferred, and named:** no live model call (the triager's fixtures are hand-authored, as
  every binding's are), no human has ever audited a label, nothing schedules the nightly pass, and
  the FAQ runs on `HashingEmbedder` + `InMemoryFaqIndex` because `pgvector` has no database to live
  in. Tasks 6.5 and 6.6, both gated on Step 7 and a credential.

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
