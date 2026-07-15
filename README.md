<div align="center">

# Call Proof

**Every call answered. Every job booked. And the receipts to prove it.**

An English-language inbound-call voice agent for US home-services contractors —
built to work on the models that *fail* the benchmark, and to tell you, per shop
and from the first call, exactly how often it gets the booking right.

[![tests](https://img.shields.io/badge/tests-1047_passing-1a7a47)](#verification)
[![coverage](https://img.shields.io/badge/coverage-99.3%25-1a7a47)](#verification)
[![typecheck](https://img.shields.io/badge/typecheck-strict-0f6d68)](#verification)
[![emergency recall](https://img.shields.io/badge/emergency_recall-1.00-b3261e)](#the-emergency-classifier-never-asks-a-model-for-permission)

</div>

---

## What Call Proof is, in one paragraph

When a homeowner calls a plumber, an HVAC shop, or an electrician and nobody picks
up, that missed call is a lost job worth hundreds of dollars. Call Proof answers
that call. It talks to the homeowner, captures the five things needed to book the
work — who they are, where they are, what's wrong, how urgent it is, and when they
want someone — verifies each one, and then books the job into the contractor's
existing CRM (Housecall Pro or Jobber) after the call is over. If it hears a gas
leak, a fire, carbon monoxide, or anyone in danger, it stops everything and warm-
transfers to a human within a single turn. And it keeps score on itself: every
booking the contractor later has to correct is recorded as a labeled failure, so
the shop can see — and Call Proof can publish — how reliable it actually is.

The name is the promise. Every other voice-AI vendor *asserts* that their agent
works. Call Proof measures it, publishes it, and hands you the proof.

---

## The problem it solves

A missed call at a plumbing shop is a lost job. The obvious fix — put a voice AI on
the phone — runs straight into a wall the research is blunt about:

> The best ASR→LLM pipeline fills tool-call parameters correctly **~60.6%** of the
> time in English. Sequential, multi-step workflows collapse to **5–15%**.
> — [VoiceAgentBench](https://arxiv.org/pdf/2510.07978)

Latency and turn-taking trade against each other badly, too: the *fastest* model in
[Full-Duplex-Bench-v3](https://arxiv.org/pdf/2604.04847) had the *worst* turn-take
rate, giving no response at all in 22 of 100 scenarios.

Anyone who builds an open-ended conversational agent for the phone walks straight
into that wall. Call Proof is designed to never touch it.

## The one idea

**A missed call is expensive, and the conversation needed to capture it is
bounded.** Name, address, problem, urgency, time window. That is a form with five
fields and a decision tree — not an open-ended dialogue.

So Call Proof never asks the model to do the thing it fails at:

|                             | A typical voice agent                  | Call Proof                                                     |
| --------------------------- | -------------------------------------- | -------------------------------------------------------------- |
| Who drives the conversation | The model plans and chains tool calls  | A **state machine**; our code advances it on validated slots   |
| Per turn                    | Pick a tool from a menu                | Extract **one field**                                          |
| Booking the job             | Model orchestrates 4 API calls         | A **deterministic transaction** after the call, with rollback  |
| Emergencies                 | Ask the model if it sounds urgent      | A **deterministic classifier** that never consults a model     |
| Reliability claims          | Asserted                               | **Measured and published** — including the bookings you fixed  |

A 14.8%-reliable agentic task becomes a five-field extraction task plus a database
transaction. That reframing is the entire product.

---

## What it does — the functionalities

### 📞 Answers the call and runs the conversation
A pure, deterministic **state machine** walks every call through
`GREETING → IDENTIFY → TRIAGE → QUALIFY → SCHEDULE → CONFIRM → CLOSE`. Our code
decides what happens next; the model is only ever asked *"what is the value of this
one field?"* Callers can volunteer the address before they're asked and change the
appointment three turns later — the machine handles out-of-order answers and can
cross four states on a single sentence.

### 🎯 Extracts one field per turn, then verifies it
Each turn the model fills exactly one slot, behind a forced single-tool schema. The
address, callback phone, and appointment window are **always read back** to the
caller before the call can close; name and problem are read back when the model's
confidence is low. Addresses are checked against a geocoder rather than trusted from
the transcript, so a truck never gets sent to an address the caller never gave.

### 🚨 Catches emergencies without asking the model
A **deterministic** keyword and edit-distance classifier runs on every speech
fragment, in parallel with and independent of the LLM. Gas, carbon monoxide, fire,
arcing, flooding, sewage, no-heat-in-a-freeze, and any hazard near a child or an
elderly resident bypass the whole flow and warm-transfer to a human within one turn
— even when the model is down, rate-limited, or confidently wrong.

### 🧾 Books the job safely, *after* the call
Nothing is written to the CRM while the caller is on the line. The call produces a
`PendingBooking`, and a **durable, journaled saga** commits it afterwards —
`create_customer → ensure_location → create_job → send SMS` — with retries on
transient failures and **compensating rollback** if a step fails, so the CRM is
never left half-written and a customer who existed before the call is never deleted.

### 💬 Answers the caller's questions from the contractor's own words
When a caller asks about price, hours, or policy, Call Proof retrieves the
contractor's **committed answers** and the model *selects* one — it never writes a
new answer or quotes a price the contractor didn't approve.

### 📊 Measures its own reliability, per shop, from call one
Every booking the contractor edits or cancels is written back as a labeled failure
(`outcomes.correctedFields`). Call Proof computes the correction rate, latency
percentiles, turn-take and barge-in rates, and puts them on the dashboard **even
when they look bad** — then, once there's enough data, publishes a per-quarter
reliability number that it is structurally unable to suppress just because it's
embarrassing.

### 🔒 Treats compliance, tenancy, and billing as code, not promises
- **AI disclosure** is spoken verbatim before any recording begins.
- **Two-party consent** is decided conservatively — an unknown area code is treated
  as all-party, because an incomplete map must fail safe.
- **Card numbers** a caller reads aloud are redacted before they reach the model,
  the database, or the CRM.
- **Tenant isolation** is enforced by the database (Postgres row-level security),
  not by remembering to add a `WHERE` clause.
- **Billing** is per booked job — and *never* for a booking Call Proof got wrong.

---

## How it helps the people who use it

**For the contractor (the shop owner / dispatcher):**
- No missed call is a lost job anymore — the phone is answered 24/7.
- The dashboard answers one question at a glance: *does anything need me?* One line
  per call, colour spent almost entirely on the calls that need a human.
- For the first time, an honest number: not *"our agent is 95% accurate,"* but
  *"of the ten jobs we booked you yesterday, you had to fix one."*
- Billing that's aligned with them: they're never charged for a booking the agent
  got wrong.

**For the homeowner (the caller):**
- Someone answers, at 2 a.m., with a burst pipe.
- A real emergency reaches a human in one turn, not after a chatbot loops them.
- What they said is read back and confirmed, so the truck shows up at the right door
  on the right day.
- A Spanish-speaking caller who panics and shouts *"¡huele a gas!"* still gets
  transferred — the safety lexicon stays bilingual even though the product is
  English-only.

**For the industry:**
- The one number nobody publishes — how often the agent got the booking wrong — gets
  published, per tenant, with a methodology written *before* the number so it can't
  be bent to fit the result.

---

## Quickstart

```bash
npm install
npm run check          # typecheck + the full test suite
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
  │ ● GAS LEAK   Unknown caller                       2:38 PM │  ← the only thing
  │              Emergency — transferred to a human           │     that shouts
  └──────────────────────────────────────────────────────────┘

  In progress
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
definition — the clearest available explanation of how the product works. Every
number is computed from call records; none is typed into the page. *"Bookings you
had to fix"* is red whenever it is above zero, because a correction is a real
failure.

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
   │  conversation                                             │
   │                                                           │
   │  GREETING → IDENTIFY → TRIAGE → QUALIFY → SCHEDULE →      │
   │                 │                          CONFIRM → CLOSE│
   │                 └─► EMERGENCY → HANDOFF                   │
   │                                                           │
   │  SlotBook: out-of-order fills · confidence · read-back    │
   │  transition(): pure. emits Effect[] for the audio layer.  │
   └──────────────────────────────────────────────────────────┘
                              │
                              ▼  PendingBooking (nothing written during the call)
   ┌──────────────────────────────────────────────────────────┐
   │  workflows — durable saga, journaled, retries             │
   │                                                           │
   │  create_customer ──► ensure_location ──► create_job       │
   │        ▲                                     │            │
   │        └───────── compensate ◄───────────────┘  on failure│
   │                                                           │
   │  send_sms  ← outside the transaction. you cannot unsend.  │
   └──────────────────────────────────────────────────────────┘
                              │
                              ▼
                   Housecall Pro │ Jobber
```

### Packages

| Package        | What it owns |
| -------------- | --- |
| `contracts`    | Zod schemas. Slot keys, the state graph, `PendingBooking`, call traces. **Defined once.** |
| `conversation` | `SlotBook` and the state machine. Pure — no I/O, no clock, no network. |
| `safety`       | Deterministic bilingual emergency classifier + its labeled corpus. |
| `compliance`   | Consent, the AI disclosure, PAN redaction, retention, TCPA — the law, as code. |
| `validators`   | Phone (E.164 + NANP), address (geocoder port), service area, business hours. |
| `anthropic` / `groq` | The two model-vendor boundaries: outage taxonomy + wire-level test transport. |
| `extraction`   | The slot extractor. One tool, one field, one turn. Two vendor bindings. |
| `faq`          | Retrieval + selection. The model picks a committed answer, never writes one. |
| `triage`       | The correction classifier. Was the contractor's edit *our* mistake? |
| `utterance`    | Everything the agent says. A committed catalog, decided before the call. |
| `crm`          | `CrmAdapter` + Housecall Pro (REST) + Jobber (GraphQL). |
| `runtime`      | The `Effect[]` binding: caller ASR → machine → voice session. |
| `workflows`    | Saga engine, post-call booking transaction, the outcome poller, triage batch. |
| `billing`      | Per booked job — and never for a booking we got wrong. |
| `telemetry`    | Correction rate, barge-in, turn-take, latency budgets, the publication rule. |
| `db`           | Drizzle schema + migrations + row-level security + the tenant-scoped client. |
| `eval`         | Simulated callers. Personas run against the real machine in CI. |
| `apps/web`     | The contractor dashboard, the public reliability page, and the crons. |
| `apps/agent`   | The Python LiveKit worker scaffold (no hardware yet). |

---

## Five decisions worth explaining

### The model never chains tool calls
Sequential tool-calling collapses to single digits, so the agent never plans a
sequence. In each state it is handed exactly one tool, which records one fact. **Our
code** advances the state, on a validated slot. `transition()` is a pure function
returning `Effect[]` — `GREET`, `ASK_FOR`, `READ_BACK`, `ESCALATE`,
`CREATE_PENDING_BOOKING`. The machine decides; the audio layer performs.

### The state machine must not feel like a phone tree
Real callers volunteer the address before you ask, and change the appointment three
turns later:

```ts
// "Hi, it's Rosa at 1247 Calle Ocho, my heater's dead, can someone come Thursday?"
const r = transition(ctx, fill("callback_phone", "+13055557781"), opts);
r.transitions; // ["TRIAGE", "QUALIFY", "SCHEDULE", "CONFIRM"] — four states at once
```

Supplying a different value for an already-confirmed slot **silently revokes that
confirmation** — the call cannot close until the caller hears the new value read
back. A truck going to the wrong door with a confirmation on file that was never
given is the failure this prevents.

### The emergency classifier never asks a model for permission
Deterministic keyword and bounded-edit-distance matching over a bilingual lexicon,
on every ASR partial, independent of the LLM.

- **Recall is a hard constraint. Precision is a cost we measure.** A false positive
  costs one annoyed dispatcher; a false negative costs a house. `recall === 1.0` is
  asserted on every run over a labeled bilingual corpus.
- **The lexicon stays bilingual although the product is English-only.** Panic reverts
  people to their first language; *"huele a gas"* transfers. Deleting those phrases as
  dead code is the one change in this repo that could kill someone.
- **No negation suppression.** *"There's no gas leak, right?"* transfers to a human.

### The model selects sentences; it never writes load-bearing ones
The AI disclosure is pinned character-for-character. A read-back interpolates a value
(templating, nine lines) rather than letting a model "naturally" turn `1247 Calle
Ocho` into `1247 SW 8th St`. The FAQ returns an *id*; the caller hears the
contractor's own committed answer verbatim.

### Nothing reaches the CRM during the call
The call produces a `PendingBooking`. A durable, journaled saga commits it afterwards,
with retries on transient failures only, and compensating rollback:

```ts
const result = await commitBooking(id, payload, deps);
// → { status: "COMMITTED",  booking, smsDelivered }
// → { status: "ROLLED_BACK", reason }        the CRM is clean
// → { status: "FAILED", needsHumanReview }   compensation itself failed
```

---

## Verification

Reliability claims in this space are mostly unfalsifiable marketing. These are not.

```
 Tests  1,047 passed        Coverage  ~99.3% lines        Typecheck  strict, clean
```

A few of these are load-bearing:

- **The CRM contract suite runs against both adapters.** If it passes for Housecall
  Pro *and* Jobber, the interface is not just a rename of one vendor's endpoints.
- **The tenancy suite runs against a real Postgres** (in-process, via PGlite) with the
  real committed migrations and the real app role — one tenant cannot read another's
  rows, and a passing test asserts the database *owner* bypasses RLS entirely, because
  that's the deployment fact a team gets wrong silently.
- **Zero live model calls anywhere in the test suite.** Every model binding is driven
  through an injected `fetch` against committed fixtures, on *both* vendors — a suite
  whose green depends on a third party's uptime teaches the team to ignore red.
- **The suite is mutation-tested.** Break an invariant, confirm it screams — 39 such
  mutations are pinned, from "correction no longer revokes confirmation" (caught in 3
  places) to "an unclassified correction becomes not-our-fault" (which would quietly
  flatter the published number).

See [`CLAUDE.md`](./CLAUDE.md) for the full test matrix and every mutation.

---

## The first time it spoke to a live model

`packages/groq` gave Call Proof its first live model call — and the first thing it did
was reproduce the benchmark's most-cited failure on turn one. Handed the address tool
and *"1247 Calle Ocho, Miami FL 33135,"* the model flattened four fields into one
string. Not an edge case: the single most-benchmarked failure in the literature, on
the first request. That is *why* principle #1 exists.

The first end-to-end score was **22.2% critical-slot accuracy — identical across three
different models.** An identical score across three models is never a fact about
models; it was three latent bugs in our own contract, each invisible to a fake
extractor scripted with the right answer. Fixing the first two took it to **33.3%**;
the third is unmeasured because the free tier's daily token budget ran out mid-run.
The honest state: *the number is 33.3% and rising, and we do not yet know what a live
model can really do on our slots.* Do not quote 33.3% as a model result — it is a
floor on our own bugs. This is exactly what the eval was built to find.

---

## Status

Built and tested through **Step 9**: the domain core, the slot extractor (Anthropic
*and* Groq bindings), both CRM adapters, the booking saga, the outcome poller,
correction triage, the FAQ, compliance, tenancy with row-level security, billing, the
metrics, the publication mechanism, the eval harness, and the dashboard.

Not built, and deliberately not faked:

- **No live phone call has ever happened.** No Twilio, no LiveKit, no realtime model.
  `apps/agent` is an honest Python scaffold; `Effect[]` is the seam the voice runtime
  binds to.
- **The reliability number is not published, because there is no number.** The whole
  publication mechanism exists — and refuses to publish, because there are no real
  contractors, calls, or corrections yet. A 0% correction rate over no bookings is what
  a broken pipeline reports; the gates exist so Call Proof can't accidentally become
  that.
- **No live credentials wired end-to-end** for the CRM, the geocoder, embeddings,
  auth (Clerk), or Stripe. The ports exist; the vendors haven't been met.
- **No lawyer has reviewed the compliance work.** It is engineering's best reading of
  the law, written so counsel can check the code line by line — which is not the same
  as advice.

See [`CLAUDE.md`](./CLAUDE.md) for conventions and gotchas, [`plan.md`](./plan.md) for
the delivery plan, and [`idea.md`](./idea.md) for the research it derives from.

---

## The number that matters

Every booking the contractor edits or cancels is written back as
`outcomes.correctedFields` — a labeled failure. It is the metric the dashboard leads
with, the loop that nobody in this field has closed, and the one Call Proof intends to
publish.

Not *"our agent is 95% accurate."* **"Of the ten jobs we booked you yesterday, you had
to fix one."** That is the proof in Call Proof.
