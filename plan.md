# Ledgerline — Implementation Plan

**The single source of truth for what we are building, why, and how.**

- [`idea.md`](./idea.md) — the upstream research. **Deliberately not revised** to match later decisions; it is the evidence record, and §2.2's multilingual capability gap is real whether or not we build on it.
- [`CLAUDE.md`](./CLAUDE.md) — what exists today, and the conventions for changing it.
- This file — the plan. Sections 1–5 are *why*. Sections 6–8 are *what*. Section 9 is *how, step by step*. Section 10 is the implementation reference the steps point at.

---

## Current status (verified 2026-07-12, after Step 9's core)

The domain core is built and green, the call runtime that binds it to a voice
session is tested end to end without a phone, the eval harness drives extraction
through the *real* `SlotExtractor` port, the wedge has a *why* beside its *what*
(correction triage, a human audit, and the rule that decides which number we are
allowed to publish), Step 7 gave it a **database that actually runs**, Step 8 made
the compliance rules **code rather than a policy page** — and as of Step 9 the
**publication mechanism exists and refuses to publish**: there are no contractors,
so there is no number, and the page says exactly that rather than the 0% a broken
measurement pipeline would report. Everything below was re-run, not copied from a
previous claim.

| Check | Result |
|---|---|
| `npm test` | **976 passed**, 36 files |
| `npm run typecheck` | clean |
| `npm run test:coverage` | **99.39%** lines (thresholds: 90/90/85/90) |
| `cd apps/web && npm run build` | builds, 10 routes |

**Built.** `contracts`, `conversation` (SlotBook + the seven-state machine), `safety`
(deterministic classifier, labeled corpus, `recall === 1.0`), `validators`, `extraction`
(the Anthropic slot extractor behind the `SlotExtractor` port), `crm`
(Housecall Pro + Jobber behind one contract suite, now including `readJob`), `workflows`
(saga + compensating rollback + the outcome poller + the nightly triage batch and the audit
sampler), `telemetry`
(Full-Duplex-Bench-comparable definitions + CI budgets + `agentErrorRate` and
`publishedCorrectionRate()`), `db` (Drizzle schema + two migrations), `utterance` (the committed
catalog + `CachedUtterer` behind the `Utterer` port),
`runtime` (`CallRuntime` — the `Effect[]` binding, driving the machine from caller ASR through
the extractor, classifier, and validators, tracing every turn, posting the `PendingBooking`, and
— as of Step 6.4 — taking the FAQ detour when a caller asks a question instead of answering one),
`eval` (simulated callers, over the real `SlotExtractor` port — Step 5.1), `apps/web`
(dashboard). `validators` also carries `GoogleGeocoder` behind the `Geocoder` port (Step 4.7),
and `contracts` emits the worker's JSON Schema with a drift guard (Step 4.1). Step 6 adds three
packages: `triage` (call site #5, the correction classifier behind the `CorrectionTriager` port),
`faq` (call site #3, retrieval + selection behind the `FaqAnswerer` port), and `anthropic` (the
vendor boundary the three model call sites share — the outage taxonomy and the wire-level test
transport).

Step 7 adds `billing` (per booked job, and it refuses our own money when we got the booking
wrong), gives `db` a client, RLS, and the Postgres stores, and gives `apps/web` the two crons
that finally call the poller and the nightly triage pass.

Step 8 adds `compliance` — the consent regime, the recording gate, PAN redaction, the
retention windows, the branded `TransactionalSms`, and the AI disclosure itself, which moved
here from `utterance` because it is legal text rather than an utterance. `runtime` gains a
`Recorder` it starts only after the caller has *heard* the disclosure; `workflows` gains
`runRetention()`; `db` gains migration `0003` and `PgRetentionStore`; `apps/web` gains the
third cron. `docs/COMPLIANCE.md` and `docs/DPA.md` are the pages, and every rule on them
names the code that enforces it.

Step 9 adds the **publication mechanism**, and it refuses to publish. `contracts` gains the
report, the cohort, and the two ports; `telemetry` gains `decidePublication()` — four sample
gates, a Wilson interval, and no branch that can read the rate; `db` gains migration `0004`,
whose `SECURITY DEFINER` aggregate is the only cross-tenant read in the system and can return
nothing but counts; `workflows` gains `runPublication()`; `apps/web` gains `/published`, a
public JSON feed, and the fourth cron. `docs/RELIABILITY.md` is the methodology, written
**before** the number. There are no contractors, so there is no number — and the page says
that rather than the 0% a broken measurement pipeline would report.

**Not built.** No telephony, no realtime model, no auth *provider*, and **no lawyer has read
a word of the compliance work** (task 8.7 — the documents are written and the code enforces
them; nobody has signed anything). **The `Effect[]` seam is bound and tested, but only against fakes** — `apps/agent` is an honest
Python scaffold with no LiveKit room, no SIP trunk, and no GPT-Realtime (Step 4.2/4.6), and
`CallRuntime` has never driven a real microphone. `GoogleGeocoder` has never spoken to a live
Google endpoint, and the Pydantic half of the codegen has never run (no
`datamodel-code-generator` in this environment). **No model binding in this tree has ever spoken
to a live model** — `AnthropicExtractor`, `AnthropicTriager`, and `AnthropicFaqAnswerer` are all
real code against the real SDK, proven offline through an injected `fetch` against hand-authored
fixtures. The eval harness binds the real `SlotExtractor` port (Step 5.1); its nightly arm has
still never called a live model, and re-recording the fixtures plus the live prompt-cache
assertion is task 5.5. **`observeOutcome()` has only ever read a `FakeTransport`** — no live
Housecall Pro sandbox has been polled (task 4.10). **No sentence in
`packages/utterance/src/catalog.ts` has been spoken aloud by a TTS engine, and none has been read
by a lawyer** (Step 8 gates the second; Step 4 the first).

**The database is the one thing here that is no longer hypothetical, and it is worth being
precise about what that does and does not mean.** The schema, both migrations, the RLS policies,
the column grants, `pgvector`'s cosine ranking, and every Postgres store now run against a *real*
Postgres in the PR suite — in-process, no credential, no network. So tenant isolation is
**proven**, not asserted. What remains unproven is one `Pool` and a URL: `neonDatabase()` has
never connected to a live Neon (task 7.7), `faq_entries` holds no production rows, and
**`HashingEmbedder` is still the only `Embedder` bound** — it has no semantics, so
`SIMILARITY_FLOOR` is still calibrated against nothing (task 6.6, which needs an embedding
*credential*, not a database). **The weekly human audit is still a ritual nobody has performed**
(6.3): it now has a cron, a store, and a dashboard, and it has never had a person.

### Progress board

The build order is §9. **Finishing a step means updating this table and the step's own
heading in the same commit.** A plan that lags the code is worse than no plan — the next
person to open this file will trust it, and be wrong.

| Step | What | Status |
|---|---|---|
| 0 | Pivot cleanup | ✅ **Done** — 2026-07-09 |
| 1 | `packages/extraction` — the LLM slot extractor | ✅ **Done** — 2026-07-09 |
| 2 | `CrmAdapter.readJob` + the outcome pipeline | ✅ **Done** — 2026-07-09 |
| 3 | Utterance generation (build time) | ✅ **Done** — 2026-07-09 |
| 4 | `apps/agent` — one live call | 🟡 **Core built** — 2026-07-10 (live-call gate deferred: 4.2/4.6/4.10) |
| 5 | Eval over the real path | 🟡 **Core built** — 2026-07-10 (nightly/SIP arms deferred: 5.2/5.3/5.5) |
| 6 | Correction triage + FAQ | 🟡 **Core built** — 2026-07-11 (live-model tail: 6.1's live run, 6.3's weekly ritual, 6.6's real embedder) |
| 7 | Product — auth, tenancy, onboarding, billing | 🟡 **Core built** — 2026-07-11 (credential-gated tails: 7.5 onboarding/OAuth, 7.6 Clerk, 7.7 the live Neon) |
| 8 | Compliance | 🟡 **Core built** — 2026-07-11 (8.6's live carrier deletion; **8.7, the lawyer's signature**) |
| 9 | Publish the number | 🟡 **Core built** — 2026-07-12 (the mechanism publishes; **the number needs a contractor** — 9.5) ← **next: the tails** |

Not on the critical path, and unresolved: the `AgenticArm` A/B (§11), and
`claude-haiku-4-5` vs `claude-sonnet-5` for extraction, scored on critical-slot accuracy.

**Seven questions no step so far could settle without a credential or a human.** Steps 1–9
each built the real code against the real interface and hand-authored the strings, because no
vendor account existed. (Step 7 answered the one question that *could* be settled — "does the
tenancy model actually hold" — because Postgres, alone among our vendors, will run in-process.
The rest still wait on a key, a lawyer, or a customer.) Named so they cannot be quietly
forgotten:

- **What the number actually is.** Every discipline that would make it trustworthy is now
  code — the cohort is computed by a function that cannot leak a row, no gate can withhold a
  figure for being embarrassing, the window cannot be gerrymandered, and a published figure
  cannot be retracted. What does not exist is a contractor, a call, or a correction, so the
  mechanism withholds and says why. **Task 9.5**, and it is the only item in this plan that
  neither a credential nor a lawyer can supply: it needs a customer.

- Whether the prompt-cache prefix is large enough to cache at all (§10.1) — **task 5.5**.
- Whether the committed extraction fixtures match what `claude-sonnet-5` actually emits —
  **task 5.5**.
- Whether Housecall Pro's `work_status` and Jobber's `jobStatus` carry the values `readJob`
  maps, and whether a deleted job really answers `404` / `data.job: null` — **task 4.10**.
- Whether `claude-opus-4-8` labels a real correction the way a human would. The triage binding is
  proven offline; the *agreement rate* is the number that decides whether we may use it at all,
  and it cannot exist until real corrections and a real auditor do — **task 6.5**, and the
  publication rule (`publishedCorrectionRate()`) already assumes the answer is "not yet".
- Whether the retrieval floor and the embedder we eventually bind can tell "do you charge for an
  estimate" from "do you charge for a callout". `HashingEmbedder` cannot; nothing has been
  measured — **task 6.6**. Step 7 built the `pgvector` half (`PgVectorFaqIndex`, tested against a
  real Postgres, and it cannot be made to leak one tenant's answers to another's caller). The
  embedder is what is left, and it needs a *credential*, not a database.
- Whether the AI disclosure, `docs/COMPLIANCE.md`, and `docs/DPA.md` satisfy counsel. All
  three are committed, versioned, and enforced by code that a lawyer can check against them
  line by line — but "reviewed" is a signature, not an assertion, and no human has signed.
  **Task 8.7**, and it is now the *only* thing in Step 8 that neither a credential nor a test
  can supply. It gates revenue, not code.
- Whether Twilio's recording-deletion endpoint answers the way `HttpRecordingArchive` maps it
  — and, far more importantly, whether the deployment remembered to leave the **carrier's own
  recording switch off**. That second one is the single compliance rule in this repo with no
  test behind it, because no test can reach it. **Task 8.6**, with Step 4.2's telephony
  account.

---

## 1. Context

`idea.md` establishes two things that, taken together, define this product.

First, **demand is proven.** Avoca raised $125M+ at a $1B valuation with 800+
home-services customers doing exactly this: answering inbound calls, qualifying callers,
booking jobs, syncing to CRM. Contractors will pay for it. We do not need to validate
that a voice agent answering the phone for an HVAC shop is a business.

Second, **the technology is not ready for the general case.** The best ASR→LLM pipeline
fills tool-call parameters correctly only ~60.6% of the time in English, and *sequential*
multi-step workflows collapse to 5–15% (VoiceAgentBench). Latency and barge-in trade
against each other badly (Full-Duplex-Bench-v3). Anyone building an open-ended
conversational agent walks into this wall.

The synthesis, and the thesis of this plan: **a missed call at a plumbing shop is a lost
job worth hundreds of dollars, and the conversation needed to capture it is bounded.**
Name, address, problem, urgency, time window. That is a form with five fields and a
decision tree, not an open-ended dialogue. We can build something that works *today* on
models that fail the general benchmark, because we never ask the model to do the thing it
fails at.

The engineering goal is therefore not "make the LLM smarter." It is **to make the surface
the LLM must be correct on as small as possible**, and to verify every consequential
action before it commits.

---

## 2. The wedge: reliability, measured and published

We build an **English-language US home-services inbound agent**, and we differentiate on a
claim no incumbent makes: **we measure how often it is right, per tenant, and we show the
contractor the number.**

`idea.md` §2.2 documents a multilingual capability gap (60.6% → ~39.2%), and an earlier
draft of this plan made a Spanish-first agent the wedge, gated on a Phase 0 audio study.
We are not taking that branch. `idea.md` §7 open question #2 flags that code-switching
robustness is *not directly evidenced by the research*, and the cost of finding out is a
week of audio work plus a quarter of accumulated Spanish-specific product surface.

This plan takes the fallback the earlier draft named for itself: same architecture,
English-only. Because the domain core was deliberately built wedge-agnostic, the pivot cost
nothing — no product code assumed Spanish, and none has to be unwound. That is what
"wedge-agnostic" was *for*, and it paid.

What replaces the moat matters more than what we gave up. `idea.md` §7 open question #1 is
that **no field-deployment reliability numbers exist** for voice agents. Nobody publishes
them. Avoca does not publish them. We will have them from call one, because
`packages/telemetry` already computes them and `outcomes.correctedFields` — every booking a
contractor later edits or cancels — is a labeled failure.

So the product is not "an agent that answers your phone." It is **"an agent that answers
your phone, and here is exactly how often it got the address wrong last month."** That is
defensible against a competitor with 40× the funding, because the thing being defended is
not a feature. It is a habit of measurement they cannot retrofit without publishing
numbers they never collected.

**The consequence, and it reorders the build:** `outcomes.correctedFields` ships in **Step 2**,
before any telephony — not as a later metrics chore. If the claim is that we measure, the
measurement ships first.

### What success looks like

A real phone number rings. A homeowner describes a leaking water heater. Ninety seconds
later there is a real job on a real contractor's Housecall Pro calendar, an SMS
confirmation on the homeowner's phone, and a transcript the contractor can read. No human
touched it.

And on the dashboard: *312 calls answered. 271 booked without a human. 4 corrected by you.
0 wrong addresses.* Measured, not asserted. Published, eventually.

---

## 3. Architectural principles

Each answers a specific finding in `idea.md`. Violating one is a design change, not a
refactor.

### 1. Never let the model chain tool calls. (§2.1)

Sequential tool-calling collapses to single digits. So the agent never plans a sequence.
The conversation is a **state machine**, and in each state the model gets **exactly one
tool**, which records one fact.

```
GREETING → IDENTIFY → TRIAGE → QUALIFY → SCHEDULE → CONFIRM → CLOSE
                         ↓
                     EMERGENCY → HANDOFF
```

The model's job per turn is: *given this state, extract this one field, or ask for it.*
Advancing the state is done by **our code**, on a validated slot. The booking — the
multi-step `lookup_customer → check_availability → create_job → send_sms` chain that
benchmarks show models cannot do — happens **after the call**, in a deterministic workflow
with retries and compensating rollback. The LLM never orchestrates it.

This is the single most important idea in the document. We convert a 14.8%-reliable
agentic task into a 5-field extraction task plus a deterministic transaction.

**This is what "agentic" means here.** The model owns the conversational surface, wording,
extraction, FAQ answers, and summarization. It does not own control flow. §6 is the
exhaustive list of model call sites; §11 is the experiment that would prove this principle
wrong.

### 2. Two-tier latency, and never sacrifice turn-taking for it. (§2.3, §2.4)

The fastest model in the benchmark (Gemini Live) had the *worst* turn-take rate — 22 of 100
scenarios got no response at all. Speed that produces silence is not speed. GPT-Realtime's
balance (96% turn-take, 13.5% interruption) is the target profile.

A **realtime speech-to-speech model handles the conversational surface**; anything requiring
correctness runs on a slower text model out-of-band, behind a filler utterance. Never block
the audio path on a network call. Availability lookups are pre-warmed before the caller
reaches SCHEDULE.

Turn-taking gets explicit **semantic endpointing**. We do not fire on VAD silence alone. A
caller reciting an address pauses mid-utterance. We hold.

### 3. Every consequential action is verified before it commits. (§2.5)

Models state wrong things with the same confidence as right ones. A hallucinated address
books a truck roll to the wrong house.

**Critical slots are read back and confirmed** before they enter the system — address, phone,
appointment window always; name and problem when extraction confidence is low. Addresses are
validated against a geocoder, not trusted from the transcript. Nothing is written to the CRM
from inside the call: the call produces a `PendingBooking`, and a post-call workflow commits
it.

A geocoder outage yields `unavailable`, not `invalid`. Unverified is not wrong, and an outage
at Google must not take the contractor's phone line down. **The same distinction applies to
the LLM extractor** — see §10.3.

### 4. The safety tail-risk gets a hard escape hatch. (§5)

A **rules-based emergency classifier runs on every ASR partial**, in parallel with and
independent of the LLM. Gas smell, carbon monoxide, fire, arcing, flooding, sewage, no heat
below freezing, any hazard co-occurring with a child or elderly resident. These bypass the
state machine entirely and warm-transfer to a human within one turn. Deterministic keyword
and bounded-edit-distance matching. **It does not ask an LLM for permission**, because an LLM
can be slow, rate-limited, or down, and a gas leak cannot.

Recall is a hard constraint; precision is a cost we measure. A false positive costs one
annoyed dispatcher. A false negative costs a house.

**The lexicon stays bilingual even though the product is English-only.** A Spanish-speaking
homeowner can dial an English-only plumbing shop, and panic reverts people to their first
language. `huele a gas` must transfer. Those phrases cost nothing at runtime and are the one
part of the Spanish pivot that must never be cleaned up.

### 5. Measure from day one, in production — and publish. (§7 open question #1)

Every call emits a structured trace: per-turn latency percentiles, barge-in events, turn-take
failures, slot-extraction confidence, containment, and — the ground-truth metric — **whether
the booked job was later cancelled or corrected by the contractor.**

`outcomes.correctedFields` is the only number that matters. It requires CRM change detection,
which is real engineering, not a dashboard query. It ships in **Step 2**, before telephony.

**Corollary, and it is load-bearing:** when the number is bad, publish the bad number.
Redefining a metric because it embarrasses you is precisely the behavior that makes every
competitor's reliability claim worthless, and it is the only thing that can destroy this wedge.

---

## 4. Stack

| Layer | Choice | Why |
|---|---|---|
| Telephony | **Twilio** (Elastic SIP Trunking + Programmable Voice) | Numbers, SMS, and SIP in one vendor. Media Streams as fallback. |
| Voice orchestration | **LiveKit Agents (Python)** | Owns the audio loop, VAD, barge-in, turn detection. We need to *tune* turn-taking; a managed platform rents us the exact layer that is broken. |
| Realtime conversation | **GPT-Realtime** (primary) | Best measured turn-take/interruption balance in Full-Duplex-Bench-v3. Provider-abstracted; Gemini Live as A/B arm. |
| Slot extraction | **`claude-sonnet-5`** (text, out-of-band) | Strict tool use with a schema derived from `SLOT_SPECS`. Cheap, fast, verifiable, not in the audio path. `claude-haiku-4-5` is a live A/B candidate now that the input is English-only. |
| Summaries, correction triage, eval personas | **`claude-opus-4-8`** | Off the critical path. Correctness over latency. |
| Emergency classifier | Deterministic keyword + bounded edit distance | Must not depend on an LLM being available or willing. |
| Control plane | **Next.js 16 (App Router) on Vercel** | Dashboard, onboarding, webhooks, admin. |
| Backend / workflows | **Vercel Workflow (WDK)** | Durable, crash-safe, step-based with retries. Rollback is a compensating step, not a prayer. |
| Database | **Neon Postgres** (Vercel Marketplace) | Multi-tenant with RLS. `pgvector` for FAQ retrieval. |
| Cache / live state | **Upstash Redis** | Live call state, pre-warmed availability, rate limiting. |
| CRM integration | **Housecall Pro** first, adapter interface behind it | Best-documented API in the segment; Jobber follows the same adapter. |
| Recordings / transcripts | **Vercel Blob** (private) | Retention enforced at write time. |
| Eval harness | Custom, in-repo (`packages/eval`) | Non-negotiable; it is how we answer §7. |

**Language split.** The agent worker is Python (LiveKit Agents' ecosystem — turn detection,
VAD, plugins). Everything else is TypeScript. Zod contracts compile to Pydantic via codegen
in CI, and the build fails on drift.

---

## 5. Repository layout

```
ledgerline/
├── apps/
│   ├── web/                    Next.js — dashboard, reliability page, the two crons ✅
│   └── agent/                  Python — LiveKit worker scaffold + generated Pydantic  🟡 [Step 4.2/4.6]
├── packages/
│   ├── contracts/              Zod schemas → JSON Schema → Pydantic (codegen + drift guard) ✅
│   ├── conversation/           SlotBook + state machine. Pure, no I/O.
│   ├── safety/                 Emergency classifier (no LLM dependency)
│   ├── validators/             Phone, address (Google geocoder), service area, hours ✅
│   ├── anthropic/              The vendor boundary: outage taxonomy + wire-level test transport ✅
│   ├── extraction/             LLM slot extractor behind SlotExtractor port        ✅
│   ├── faq/                    Retrieval + selection behind FaqAnswerer port (#3)  ✅
│   ├── triage/                 Correction classifier behind CorrectionTriager port (#5) ✅
│   ├── utterance/              Committed catalog + CachedUtterer (Utterer port)    ✅
│   ├── crm/                    CrmAdapter + Housecall Pro + Jobber + readJob       ✅
│   ├── runtime/               CallRuntime — the Effect[] binding (VoiceSession port) ✅
│   ├── workflows/              Saga + booking transaction + outcome poller + triage batch ✅
│   ├── billing/                Per booked job — and not for a booking we got wrong  ✅
│   ├── telemetry/              Reliability metrics + latency budgets + the publication rule ✅
│   ├── db/                     Drizzle schema + migrations + RLS + the Postgres stores ✅
│   └── eval/                   Simulated-caller harness + scoring
└── plan.md, idea.md, CLAUDE.md
```

**`packages/db` is the only package whose vendor is real.** Postgres compiles to WebAssembly, so
the schema, both migrations, the RLS policies, the column grants, and `pgvector`'s cosine ranking
are exercised against an *actual* Postgres in the PR suite — no credential, no network, no
transcribed wire shapes. Every other vendor in this tree is stubbed behind a port because we
could not afford to guess at its wire format. This one we do not have to guess about.

**Three packages speak to Anthropic, and none of them owns the vendor.** `extraction` (#2), `faq`
(#3), and `triage` (#5) each hold their own prompt, tool, and outcome type; what a `429` *means*,
and how a binding is proven without a credential, are properties of the API rather than of any
call site, and they live in `anthropic`. Three private copies of that would drift, and the drift
would be silent (Step 6, surprise #5).

`packages/contracts` is load-bearing. Slot schemas, the state graph, and the `PendingBooking`
shape are defined **once** in Zod. Drift between the agent's idea of a booking and the
backend's idea of a booking is the most likely source of silent production bugs, and defining
them once eliminates it structurally.

---

## 6. The LLM surface, exhaustively

Every place a model runs. Nothing else calls a model.

| # | Call site | Model | Mechanism | In audio path? | If it fails |
|---|---|---|---|---|---|
| 1 | Conversational surface (listen, backchannel, barge-in) | GPT-Realtime; Gemini Live as A/B arm | Realtime speech-to-speech | **Yes** | Fall back to cascade (ASR → text → TTS) |
| 2 | Per-turn slot extraction | `claude-sonnet-5` | Strict tool use, one tool, one field | No — runs on the ASR transcript, concurrently | `EXTRACTION_FAILED`; machine re-asks |
| 3 | FAQ / knowledge answers | `claude-sonnet-5` | Tool use + `pgvector` retrieval. **Selects a committed answer; never writes one** (Step 6.4) | No — behind a filler utterance | "Let me have someone call you back on that" |
| 4 | Post-call summary and job notes | `claude-opus-4-8` | Structured output, adaptive thinking | No — after hangup | Booking still commits; notes marked `unsummarized` |
| 5 | Correction triage | `claude-opus-4-8` | Structured output, nightly batch, forced tool (**not** adaptive thinking — the API forbids both at once; Step 6, surprise #2) | No | Raw diff still recorded, uncategorized — **and counted against us** |
| 6 | Simulated caller (eval harness) | `claude-opus-4-8` | Tool use, persona-driven | No — CI only | Scenario fails loudly |
| 7 | Utterance wording | `claude-opus-4-8` | **Build time, not call time** — §10.2 | No | N/A |

**Deliberately absent:** the emergency classifier, the booking saga, address validation, and
`transition()`. These are deterministic and stay that way.

**Not Managed Agents.** Anthropic's Managed Agents surface runs the agent loop server-side. We
cannot afford that round trip in the audio path, and the loop is precisely the thing we refuse
to hand over. Messages API directly.

---

## 7. Data model (essential tables)

```
tenants           id, name, timezone, trade, crm_provider, crm_credentials(enc)
phone_numbers     id, tenant_id, e164, twilio_sid
service_areas     tenant_id, geojson_polygon        -- "do we even serve this address"
business_hours    tenant_id, dow, open, close, emergency_after_hours(bool)
job_types         tenant_id, name, duration_minutes, requires_photo, emergency_eligible
calls             id, tenant_id, from_e164, started_at, ended_at,
                  outcome(enum), containment(bool), recording_url, transcript_url
call_turns        call_id, idx, role, text, latency_ms, barge_in(bool), turn_take_ok(bool)
slots             call_id, key, value, confidence, confirmed_by_caller(bool), validator_result
pending_bookings  call_id, tenant_id, payload(jsonb), status(enum), workflow_run_id
bookings          pending_booking_id, crm_job_id, crm_customer_id, committed_at
job_snapshots     booking_id, polled_at, payload(jsonb)     -- CRM state over time
outcomes          booking_id, cancelled(bool), corrected_fields(jsonb), source,
                  classification(enum), classified_by, classification_rationale,
                  classified_at, human_label(nullable), audited_by, audited_at
faq_entries       tenant_id, question, answer, embedding(vector), updated_at
escalations       call_id, reason(enum), triggered_at, transferred_to, human_ack_at
```

Four columns make principles #3 and #5 real, and without them we are asserting reliability
instead of measuring it:

- `slots.confirmed_by_caller` — the read-back actually happened.
- `outcomes.corrected_fields` — ground truth. The raw diff.
- `outcomes.classification` — was the edit *our* error, a business change, or an enrichment?
  Written by a nightly model pass. **Never destructive**; the raw diff is retained forever and
  anyone can recount. `TriageStore.classify` takes the derived columns and *only* those, so a
  future edit that "cleans up" a diff the classifier disagrees with does not typecheck.
  **Null is not innocence:** an unclassified correction counts as an `agent_error` in
  `agentErrorRate`, so a triage backlog, a declined verdict, or an Anthropic outage can only ever
  make our published number worse (Step 6, surprise #1).
- `outcomes.classification_rationale` — one or two sentences the auditor can check. A label with
  no argument behind it is not auditable, and `runTriage` refuses to write one.
- `outcomes.human_label` — a weekly 10% audit, sampled by hashing the booking id rather than by
  rolling a die, so nobody can re-roll a week whose result they disliked. We report the model's
  agreement with the human *alongside* the correction rate — and below 95% agreement (or fewer
  than 20 audited labels) `publishedCorrectionRate()` publishes the **raw** rate and ignores the
  classifier entirely. An unaudited classifier grading our own homework is marketing with extra
  steps.

`faq_entries.answer` is spoken to the caller **verbatim**, and the embedding is the only reason a
model is involved at all: it *selects* which committed answer responds to the question. A model
that composed the answer would be quoting a price nobody approved, on a recorded line (Step 6.4).

`job_snapshots` exists because change detection is **polled, not webhooked**. Webhook support
differs across vendors and delivery is lossy, and a missed webhook silently reports a 0%
correction rate — exactly the number a dishonest vendor would report. **A metric whose failure
mode is "looks perfect" must not depend on at-most-once delivery.**

---

## 8. Verification strategy

Reliability claims in this space are mostly unfalsifiable marketing. Ours will not be.

1. **Unit** — state-machine transitions, slot validators, emergency classifier (labeled corpus,
   precision and recall reported per release).
2. **Contract** — one suite, both CRM adapters. If it passes for Housecall Pro and Jobber, the
   interface is real and not a rename of one vendor's endpoints.
3. **Integration** — the booking saga against a Housecall Pro sandbox, including the rollback
   path: force a failure at `create_job` after `create_customer` succeeds, assert the
   compensating step runs and the customer is not orphaned.
4. **Extraction** — recorded model responses replayed through the real Zod schemas. **No live
   model calls in the PR suite**; a suite whose green depends on a third party's uptime teaches
   the team to ignore red. Live calls belong in the nightly eval arm.
5. **Conversational** — `packages/eval` simulated callers over real SIP, nightly, blocking on
   regression in containment, slot accuracy, latency percentiles, barge-in, turn-take.
6. **Live** — a staging number anyone on the team can dial. Twenty-call acceptance runs at each
   phase gate, from real cell phones, on real cellular audio, including one from a moving car.
7. **Ground truth** — `outcomes.corrected_fields`. Every booking the contractor edits or cancels
   is a labeled failure. This closes the loop `idea.md` §7 says nobody has closed, and it is the
   number we publish.

---

## 9. Implementation, step by step

The build order is **Steps 0–9**. It replaces the old Phase 0–5 vocabulary, and there is no
Step equivalent of the old Phase 0: that gate existed to test the Spanish-first wedge with ~150
code-switched audio samples, and we are not building that wedge. Deleting it removes a week of
audio work and the project's one unresolved research gate.

**Start at Step 0. It is an hour of work and it stops the docs from lying while you build.**

---

### Step 0 — Pivot cleanup ✅ **Done (2026-07-09)**

Mechanical. Nothing depended on it, but everything reads better after.

| # | File | Change | |
|---|---|---|---|
| 0.1 | `packages/workflows/src/sms.ts` | Dropped the `es` template and the `es-US` tag. `confirmationBody()` and `formatWindow()` no longer take a `Locale` at all — a parameter that no longer affects output is a lie. | ✅ |
| 0.2 | `packages/contracts/src/call.ts` | `localesDetected` comment no longer claims code-switching is the normal case. | ✅ |
| 0.3 | `apps/web/lib/demo-data.ts` + both pages | Demo calls English; `DemoCall.locale` and the `ES` badge removed. | ✅ |
| 0.4 | `packages/eval/src/scenarios.ts` | Code-switched *booking* scenario → `english/answers-in-fragments`. Two Spanish *hazard* scenarios kept, renamed `hazard/*`. | ✅ |
| 0.5 | `packages/safety/*` | Unchanged. Added `english-only-pivot.test.ts` as a named tripwire. | ✅ |

Kept `LocaleSchema` (`primitives.ts:29`) and `PendingBookingPayload.locale`. One field, and
keeping the core wedge-agnostic is the property that made this pivot free. `customer.locale`
still reaches the CRM so a human knows what language to call back in.

**Two things came out different from the plan, and both are worth carrying forward:**

1. **The booking flow is English-only; the safety classifier is not.** That boundary is the
   pivot, and it is now asserted in `eval` (`hazard/*` scenarios) rather than implied. Do not
   "clean up" either side.
2. **The lexicon was already guarded.** Mutation-testing the new tripwire showed the existing
   corpus fails `recall === 1.0` on its own when Spanish phrases are removed. The new file
   still earns its place — a cleanup pass would delete the corpus samples in the same
   commit — but the earlier claim that the phrases were unprotected was overstated.

**Found, deferred to Step 2:** `BookingOutcomeSchema.source` (`contracts/src/booking.ts:68`)
still offers `CRM_WEBHOOK`. We poll. See task 2.2b.

**Result:** 391 tests (was 384), 98.82% coverage, typecheck clean, `apps/web` builds.

**Exit (met).** Three categories of Spanish survive on purpose, and a `git grep -i spanish`
shows only these:

- `packages/safety/**` — the hazard lexicon, its corpus, and the accent-stripping in `text.ts`.
- `packages/eval/src/scenarios.ts` — the two `hazard/*` scenarios. The booking flow is English;
  the classifier is not. That boundary *is* the pivot, so it is asserted, not deleted.
- `packages/crm/src/housecall.ts` — compound-surname handling. A customer can be named Peña on
  an English-only line.

`apps/web` keeps one Spanish caller utterance, in the emergency call, for the same reason.

---

### Step 1 — `packages/extraction` ✅ **Done (2026-07-09)**

The highest-value integration in the project, and it needs nothing but the contracts. Built
first so the risk is retired before any hardware is involved.

| # | Task | Detail | |
|---|---|---|---|
| 1.1 | Add the `SlotExtractor` port + `ExtractionOutcome` | `contracts/src/ports.ts`. `unavailable` carries a `reason`. | ✅ |
| 1.2 | Scaffold `packages/extraction` | Depends on `contracts` only. **Not** added to `transpilePackages` — `apps/web` does not import it, and an unused entry is a lie about the dependency graph. | ✅ |
| 1.3 | `toolFor(key)` — derive the tool schema from the contract | Derived from the new `SLOT_SPECS[key].extraction`, **not** `.schema`. See surprise #1. | ✅ |
| 1.4 | `AnthropicExtractor implements SlotExtractor` | One tool, forced `tool_choice` with `disable_parallel_tool_use`, `thinking: {type:"disabled"}`, `max_tokens: 256`. Zod re-validates on the way in. | ✅ |
| 1.5 | Fixtures: one per slot, plus absent / ambiguous / low-confidence / malformed | Committed in `fixtures.ts`. **Hand-authored, not recorded** — see surprise #5. | ✅ |
| 1.6 | Replay tests against the **real** `SLOT_SPECS` | Mutation-tested: adding an `Urgency` variant fails the extraction suite. | ✅ |
| 1.7 | Prompt-cache pre-warm + CI assertion | `prewarm()` warms all six prefixes. The CI assertion changed — see surprise #4. | ✅ |
| 1.8 | `FakeExtractor` | Scripted per key, records what it was asked. `eval` binds to it in Step 5.1. | ✅ |

**Exit (met).** Replay suite green, `thinking.type === "disabled"` asserted on the outgoing
request body, zero live model calls in `npm test` (no credential is read anywhere; the SDK's
`fetch` is injected). `cache_read_input_tokens` is surfaced and asserted against fixtures;
the *live* assertion moved to Step 5 — surprise #4.

**Result:** 439 tests (was 391), 98.84% coverage, typecheck clean, `apps/web` builds.

**Mutation-tested, all four caught:** dropping `thinking: {type:"disabled"}`; trusting
`strict` and skipping the Zod re-validation; interpolating a per-call value into the cached
prefix; widening `UrgencySchema` in `contracts`.

#### Five things came out different from what this Step predicted

1. **The extraction surface must be *narrower* than the storage surface, so §10.1's
   `zodToJsonSchema(SLOT_SPECS[key].schema)` is not just awkward — it violates principle #3.**
   `AddressSchema` carries `formatted`, `lat`, and `lng`, which are the *geocoder's output*. A
   model handed that schema can hallucinate a normalised address that never existed, and every
   read-back then quotes it confidently back to the caller. Likewise `E164Schema` asks the model
   to invent a country code, which is `validatePhone`'s job. So `SlotSpec` gained an
   `extraction` schema alongside `schema`, and `contracts` gained `AddressInputSchema` (the
   pre-geocode shape, previously duplicated inside `validators`). Two contract tests pin the
   boundary. **This is the single most load-bearing change in Step 1**: deriving the tool from
   the storage schema would have handed the model three jobs that belong to our own code.

2. **Four of the six slot schemas are not JSON objects, and strict tool use requires an object
   root.** `caller_name`, `callback_phone`, `problem_description`, and `urgency` are scalars.
   §10.1's `{...zodToJsonSchema(schema), additionalProperties: false}` produces an invalid tool
   for all four. The real tool wraps every slot in `{value, confidence}` — which the plan already
   required for `confidence`, but never reconciled with the spread.

3. **`strict: true` accepts neither optional keys nor semantic constraints, and this is a
   feature.** It rejects `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`; it has no
   notion of an optional property. `strictify()` therefore drops those keywords and rewrites
   optionals as nullable-and-required, and `stripNulls()` undoes the round trip before Zod sees
   the value. The consequence is the interesting part: **`strict` guarantees the shape and the
   contract guarantees the meaning.** A ZIP of `ABCDE` satisfies `{type: "string"}` and reaches
   us; `AddressInputSchema` is the only thing that stops it from reaching the geocoder. The
   `SERVICE_ADDRESS_MALFORMED` fixture exists to keep that second pass alive.

4. **`cache_read_input_tokens > 0` cannot be asserted in `npm test`,** because doing so requires
   a live model call and the same Exit line forbids exactly that. The contradiction was in the
   plan. What replaced it is *better*, not weaker: the suite asserts that the rendered `tools`
   and `system` blocks are **byte-identical across two calls with different call ids, turn
   indices, and utterances**, which is the property a `Date.now()` in the prefix would actually
   break — and it fails deterministically, offline, in 3ms. Usage is surfaced through an
   `onUsage` hook so a cold cache is visible on a dashboard from day one. The live
   `cache_read_input_tokens > 0` check belongs to the nightly arm; it is task **5.5** now.

   **And a worse problem underneath it, which nobody has verified:** the minimum cacheable
   prefix is model-dependent and is roughly 2k tokens on the Sonnet tier. Our system prompt plus
   one tool is a few *hundred*. **The cache may silently never hit at all** — no error, just
   `cache_creation_input_tokens: 0`. §10.5's "extraction is a rounding error *provided the cache
   hits*" is therefore an unverified assumption, not a budget. Task 5.5 measures it before anyone
   quotes the cost model.

5. **The fixtures are hand-authored, not recorded.** No Anthropic credential existed when this
   Step was built. They are wire-shaped and driven through the real SDK, the real tool schema,
   and the real Zod contracts, so they still prove a contract change breaks the extractor — but
   they prove nothing about what `claude-sonnet-5` actually emits. `fixtures.ts` says so at the
   top. Re-record them at the start of Step 5; the assertions should not need to change.

**Also settled, and worth not re-litigating:**

- **Ambiguity has no `ExtractionOutcome` variant, deliberately.** The tool's `null` escape is how
  "Tuesday or Wednesday" surfaces, and a Zod-rejected value lands in the same place. `absent`
  means *no usable value came out of this utterance*; `unavailable` means *we could not ask*. A
  refusal or a missing `tool_use` block is `unavailable` — treating it as `absent` would burn a
  retry and then escalate a caller who was perfectly clear.
- **Which failures are outages and which are our bugs.** `429`, `5xx`, and a dead socket →
  `unavailable`. `400` and `401` → **throw**. A malformed request or a missing key must crash
  loudly in staging, not degrade into a caller being asked their name four times.

**Found, deferred to Step 5:** `simulate.ts` still carries its inline extractor stub. Binding it
to `FakeExtractor` is task 5.1 and was left there rather than half-done here.

---

### Step 2 — `CrmAdapter.readJob` + the outcome pipeline ✅ **Done (2026-07-09)**

The wedge, made real. Done **before** telephony: it is the claim, and a reliability claim you
cannot compute is a slogan.

| # | Task | Detail | |
|---|---|---|---|
| 2.1 | Design `readJob` against Housecall Pro **and** Jobber, on paper | Done first. The design is the doc comment on `CrmJobSnapshot`; three of its decisions are surprises #1–#3 below. | ✅ |
| 2.2 | `readJob(ref, ctx): Promise<CrmJobSnapshot>` | `packages/crm/src/types.ts`. Shared parsing in the new `snapshot.ts`. | ✅ |
| 2.2b | `CRM_POLL` in `BookingOutcomeSchema.source` | Added, and **`CRM_WEBHOOK` retired** — nothing emitted it, and leaving it there invites someone to wire one up and silently under-report. `classification` and `humanLabel` added as nullable, mirroring §7. | ✅ |
| 2.3 | Implement in both adapters | `housecall.ts` (REST, `404` = deleted), `jobber.ts` (GraphQL, `data.job: null` = deleted). | ✅ |
| 2.4 | Extend the shared contract suite | 8 new shared cases, run against both adapters, plus vendor-specific status-mapping tables. | ✅ |
| 2.5 | `packages/db` — Drizzle schema | 13 tables, `job_snapshots`, the four columns, and the initial migration — `drizzle-kit generate` needs no database. | ✅ |
| 2.6 | Outcome poller | `workflows/src/outcomes.ts`. 24h / 72h / 7d, `diffBooking`, `SnapshotStore`. | ✅ |
| 2.7 | Feed `computeMetrics()` real outcomes | And fix the bug that surfaced when they arrived — surprise #5. | ✅ |

**Exit (partially met, and the gap is named).** `computeMetrics()` returns a `correctionRate`
derived from a Housecall Pro job body **edited by hand and served through `FakeTransport`**,
driven end-to-end through the real adapter, the real poller, and the real `computeMetrics()`.
Only the credential is fake. A *live* sandbox has never been polled — that is **task 4.10**,
where the credential first exists. Step 1 set this precedent with its hand-authored fixtures,
and the honest thing is to say so rather than to claim the sandbox.

**Result:** 526 tests (was 439), 98.99% coverage, typecheck clean, `apps/web` builds.

**Mutation-tested, all seven caught:** swallowing a `503` in `readJob` and reporting a clean
job; treating an unreported field as a correction; counting outcome *rows* instead of bookings;
reading Jobber's truncated `title` instead of `instructions`; comparing `postalCode` exactly, so
ZIP+4 enrichment reads as our error; comparing phone numbers as strings; and putting
`CRM_WEBHOOK` back in the contract.

#### Five things came out different from what this Step predicted

1. **`urgency` cannot be diffed, and pretending otherwise would bias the number we publish.**
   Housecall Pro stores urgency as a job tag; Jobber has nowhere to put it at all. A field only
   one adapter can report is a field whose correction rate differs by provider for reasons that
   have nothing to do with the agent. `DIFFABLE_SLOTS` is therefore five keys, not six, and
   `jobTypeId` goes the same way. This is `CLAUDE.md`'s "never add a method only one adapter can
   implement" applied to a *field* rather than a method, and it is the reason 2.1 had to happen
   before 2.2.

2. **A deleted job is an outcome, not an error.** Both vendors can lose a job entirely —
   Housecall Pro answers `404`, Jobber answers `data.job: null` inside a `200`. Throwing on
   either would make the poller retry forever against a job that no longer exists, and the
   contractor deleting our booking is the loudest possible correction signal. Hence
   `CrmJobStatus.DELETED`, and a `deletedSnapshot()` whose every field is `null` — we know the
   booking died, and we know nothing about what its fields looked like when it did. Reporting
   those nulls as corrections would double-count the cancellation.

3. **Half the work is *not* reporting corrections that never happened.** This was the surprise.
   The naive diff reports a corrected address on every booking (`formatted` is our geocoder's
   output and no CRM echoes it), a corrected phone on every booking (`+13055551234` vs
   `(305) 555-1234`), a corrected name whenever the CRM title-cases, a reschedule whenever the
   vendor returns `-04:00` instead of `Z`, and a corrected ZIP whenever the CRM enriches to
   ZIP+4. Every one of those is a *false* failure that would make our published number worse
   than the truth — and the mirror-image bug, treating an unparsed field as unchanged rather
   than unobserved, makes it better. `diffBooking` has a test for each, and the type system
   forbids the first: `CrmJobSnapshot.address` is an `AddressInput`, so `formatted` cannot
   reach the comparison.

4. **`OutcomeDeps.crm` is `Pick<CrmAdapter, "readJob">`, and the narrowing is load-bearing.**
   The poller observes; it never writes. Typing it that way means a future edit that
   "helpfully" re-syncs a corrected field back into the CRM does not compile. A metric that
   repairs the thing it measures measures nothing.

5. **`computeMetrics()` had a latent bug that only real outcomes could expose.** Three polls per
   booking means one corrected booking arrives as up to three `BookingOutcome` rows.
   `countCorrected()` counted rows, so `correctionRate` would have exceeded `1.0` — a value
   `ReliabilityMetricsSchema` rejects outright, which means the dashboard would have crashed
   rather than lied. It now counts distinct bookings, latest observation wins, ordered by
   `observedAt` rather than array position because a cron guarantees no ordering. **This is what
   Step 2 was for.** The metric had never met its own data.

**Also settled, and worth not re-litigating:**

- **A failed poll emits nothing.** `readJob` throws on a `429`/`5xx`/dead socket and
  `observeOutcome` lets it. Catching it and recording "no corrections observed" is the same lie
  as §7's missed webhook, arrived at more honestly: a metric whose failure mode is *looks
  perfect* must not depend on lossy delivery. Two tests, one per adapter, plus one on the poller.
- **The raw payload is stored before the diff runs.** A bug in `diffBooking` then costs a wrong
  label rather than the evidence, which is what lets Step 6's classification stay a derived
  column that anyone can recount.
- **`packages/db` ships schema only** — no pool, no client, no query helpers. Nothing in the tree
  has a database, and a connection nobody opens is a lie about what is built.

**Found, deferred:** the vendor status vocabularies (`work_status`, `jobStatus`) are transcribed
from documentation, not observed. Task **4.10** verifies them, and the exit criterion above,
against a live sandbox.

Correction triage (call site #5) remains **deferred to Step 6** — you need corrections before you
can classify them, and the raw diff is what matters.

---

### Step 3 — Utterance generation ✅ **Done (2026-07-09)**

| # | Task | Detail | |
|---|---|---|---|
| 3.1 | Add the `Utterer` port | `contracts/src/ports.ts`, with `UtteranceContext`. Forced `Effect` into `contracts` — surprise #1. | ✅ |
| 3.2 | Generate the string set offline | Six slots × ask/reprompt/read-back, 8 hazard guidances, 5 escalation forms, 3 transfer forms, the disclosure. Authored offline by an Opus-class model; **no API call, no credential** — same precedent as Steps 1 and 2. | ✅ |
| 3.3 | Review and **commit** them | Committed. `catalog.ts` is pure data so the review surface is a diff, not a simulation — surprise #4. The human signature is Step 8's. | ⏳ |
| 3.4 | `CachedUtterer` (ships) + `LlmUtterer` (dev) | `LlmUtterer` paraphrases `ASK_FOR` **and nothing else** — surprise #3. It reaches a model through a local `Phraser` port, so no model SDK enters this package. | ✅ |
| 3.5 | *(unplanned)* `GREET`, and `nextPrompt()` | There was no effect on which the disclosure could ride — surprise #2. | ✅ |

**Exit (partially met, and the gap is named).** The AI disclosure is a committed, verbatim
string, pinned character-for-character by a test that exists to fail loudly when somebody
runs a "tone pass" over legal text. It is spoken from the catalog on `GREET`, and
`LlmUtterer` is structurally incapable of paraphrasing it. What has *not* happened is the
word "reviewed": no lawyer has read it. That is a signature, not an assertion, and Step 8
collects it.

**Result:** 575 tests (was 526), 99.08% coverage, typecheck clean, `apps/web` builds.

**Mutation-tested, all five caught:** letting `LlmUtterer` paraphrase anything beyond
`ASK_FOR` (reports a paraphrased disclosure, a paraphrased address read-back, and paraphrased
gas-leak guidance); rewording `AI_DISCLOSURE`; reading back the caller's raw address instead
of the geocoder's `formatted`; dropping the tenant timezone from `speakWindow`; and removing
`GREET` from `nextPrompt`, which silently deletes the disclosure from every call.

#### Five things came out different from what this Step predicted

1. **`Utterer.say(effect, ctx)` cannot live in `contracts` while `Effect` lives in
   `conversation`,** and §10.3 puts the port in `contracts`. So `Effect` and
   `EscalationAction` moved into `contracts/src/effects.ts` as Zod schemas, and `machine.ts`
   re-exports them. This is not a workaround for a cycle — it is where they belong.
   `Effect` is the seam the Python worker binds to (§10.4), and task 4.1 generates its
   Pydantic from the Zod in `contracts`. A type that crosses the language boundary belongs in
   the spine. Nothing else changed; 526 tests stayed green through the move.

2. **There was no effect on which the disclosure could ride.** `promptFor()` returned `[]` in
   GREETING — the state has no required slots — so the machine never told the runtime to
   greet, and `greeting_delivered` would have blocked the call forever waiting for a milestone
   nobody was asked to reach. The disclosure, this Step's entire exit criterion, had nowhere
   to be spoken. Hence a fifth `Effect` variant, `GREET`, and `nextPrompt(ctx)` exported —
   because a call opens with **no event at all**, and the worker has to be able to ask "what do
   I say first?" before anything has happened. Two tests pin it, and the mutation that deletes
   it is the one that ships an undisclosed AI to a caller in California.

3. **§10.2 is wrong about read-backs, and the error is principle #3 run backwards.** It says
   `LlmUtterer` exists "for read-back phrasings that interpolate a value." Interpolating a
   value is *templating*, and asking a model to do it is how `1247 Calle Ocho` becomes
   `1247 SW 8th St` — a normalisation the caller will cheerfully confirm, for an address they
   never gave. The read-back **is** the verification step; a paraphrase of it verifies nothing.
   The same argument retires `GREET` (legal text), `ESCALATE` (life-safety guidance read to
   someone standing in a room filling with gas), and `CREATE_PENDING_BOOKING` (a promise to
   text a specific number). `LlmUtterer` paraphrases `ASK_FOR` and nothing else, by
   construction rather than by policy: the wording of "what's your name?" is not load-bearing,
   and every other sentence's *content* is.

4. **The catalog is data, and that is what makes 3.3 real.** No functions, no concatenation,
   no conditionals — placeholders are `{business}`, `{value}`, `{phone}`, and one `fill()` in
   `render.ts` resolves them. A reviewer reading template *functions* has to simulate them in
   their head to know what a caller hears; a reviewer reading this file just reads it. A test
   walks the catalog and fails if a leaf is anything but a string, or carries a placeholder we
   do not resolve. `git diff catalog.ts` is now the change-control surface for what a stranger
   hears when they phone a plumber at midnight.

5. **`speakWindow` is deliberately *not* `formatWindow`.** The obvious cleanup is to share one
   window formatter with `packages/workflows`' confirmation SMS. Don't: the SMS reads
   `2:00 PM – 6:00 PM`, and an en dash spoken aloud is a silence, while `2:00 PM` is read as
   "two oh oh PM". Same input, two audiences, two renderings — "Thursday, July 9, between 2 PM
   and 6 PM". The DST handling is `Intl`'s in both places, so there is no logic to keep in
   sync, which is the only thing the duplication would have bought.

**Also settled, and worth not re-litigating:**

- **No model SDK entered `packages/utterance`.** `LlmUtterer` takes a local `Phraser` port, in
  the repo's convention. The only `@anthropic-ai/sdk` in the tree is still `packages/extraction`.
- **A drafted line is used or discarded, never repaired.** Empty, over 200 characters, a line
  break, or a surviving `{placeholder}` → the committed line. A model that returned three
  paragraphs was not doing the task, and the catalog line is right there.
- **`ASK_FOR` carries no attempt count, so `UtteranceContext.attempt` does.** Repeating a
  failed question verbatim tells the caller nothing about why it failed, and the second answer
  is usually the first one again. Every slot has a reprompt form, and a test asserts it differs
  from the initial.
- **A `READ_BACK` for an unfilled slot throws.** It is a machine bug, and improvising a
  sentence around a missing value is how the caller confirms `undefined`.

---

### Step 4 — `apps/agent`: one live call 🟡 **Core built (2026-07-10); live-call gate deferred**

Now the hardware — and the hardware is the half that a laptop with no vendor account cannot
build. So this Step split cleanly the way Steps 1–3 did: **the whole `Effect[]` binding is
built and tested against fakes** (`packages/runtime`), and the three tasks that need a real
microphone, a real realtime model, or a real CRM sandbox are named and deferred rather than
faked into a green that means nothing.

| # | Task | Detail | |
|---|---|---|---|
| 4.1 | Zod → Pydantic codegen in CI | JSON Schema for `Effect` + `PendingBooking` emitted from the Zod (`contracts/src/codegen.ts`), committed to `apps/agent/contracts.schema.json`, and drift-guarded in the PR suite. The Pydantic half (`datamodel-code-generator`) is a documented build command — no Python toolchain here. Surprise #7. | 🟡 |
| 4.2 | Twilio number → SIP trunk → LiveKit room | Scaffolded in `apps/agent` (README, `pyproject.toml`, the Effect-dispatch worker), **not wired to hardware.** No credential. | ⬜ |
| 4.3 | `VoiceSession` port + `FakeVoiceSession` | Shipped. The port emits `SpeechOutcome`, not `MachineEvent` — surprise #1. | ✅ |
| 4.4 | Bind `Effect[]` → worker | `CallRuntime`, §10.4. The machine decides; the runtime performs. | ✅ |
| 4.5 | Classifier on **every ASR partial**, in-process | `hearPartial` runs the deterministic classifier before the extractor is asked; `HAZARD_DETECTED` short-circuits the turn. | ✅ |
| 4.6 | GPT-Realtime behind `apps/agent/voice/` | The provider boundary is documented; no realtime model is bound. `CallRuntime` speaks through the `VoiceSession` port, so the provider never reaches the core. | ⬜ |
| 4.7 | Google Address Validation behind the existing `Geocoder` port | `GoogleGeocoder` shipped and tested against transcribed wire shapes through an injected `HttpTransport`. Never spoken to a live Google endpoint (4.10-class gap). | ✅ |
| 4.8 | Hangup → `PendingBooking` → WDK workflow → Housecall Pro job → Twilio SMS | `CallRuntime` posts the `PendingBooking` to a `BookingSink` on `CREATE_PENDING_BOOKING`; `commitBooking()` is unchanged and consumes it. The WDK schedule and live CRM are Step 7 / 4.10. | ✅ |
| 4.9 | Telemetry: every turn traced | Every spoken and heard turn becomes a `CallTurn`; `computeMetrics()` / `checkBudgets()` run over exactly what the caller experienced. Silence is a breach, not free speed. | ✅ |
| 4.10 | **Verify `readJob` against a live Housecall Pro sandbox** | The Step 2 exit criterion, with a real credential. Book a job, edit its address by hand, poll it, assert `correctionRate`. Confirm `work_status` and `jobStatus` really carry the values the adapters map, and that a deleted job really answers `404` / `data.job: null`. Both vocabularies are transcribed from docs, not observed. | ⬜ |

**Exit criteria — the first live-call gate. NOT MET, and cannot be without a Twilio/LiveKit
credential.** 20 consecutive scripted-but-live calls from real phones. ≥18 book a correct job.
**Zero wrong addresses committed.** p95 first-word latency < 1.2s, p95 turn latency < 2.0s.
`checkBudgets()` green. Emergency phrase transfers within one turn, 10/10. And `computeMetrics()`
reports a real `correctionRate` from those 20 calls.

**What *is* met:** the same gate, driven end to end through the *real* machine, the *real*
classifier, the *real* validators, and the *real* `Effect[]` binding, against a `FakeVoiceSession`
and a `FakeExtractor`. `computeMetrics()` reports a `correctionRate` and `checkBudgets()` returns
green from `CallRuntime`'s own traced turns; a scripted silent turn breaches `turnTakeRate`, which
is the property that makes "you cannot buy latency with silence" a test rather than a slogan.

**Result:** 611 tests (was 575), 99.18% coverage, typecheck clean, `apps/web` builds. The +36 are
23 in `packages/runtime`, 10 for `GoogleGeocoder`, and 3 for the codegen drift guard.

#### Seven things came out different from what this Step predicted

1. **The `VoiceSession` port cannot emit `MachineEvent`, and that is principle #3.** §10.3 sketched
   `perform(effects): Promise<void>` plus `onEvent(MachineEvent)`. But a `SLOT_FILLED` event carries
   a value that has *already* been through `packages/validators` — the geocoder, the E.164 parse.
   An audio layer that could construct one would have to own the geocoder, and principle #3 is that
   the geocoder decides what an address is, not the thing listening to the caller. So effects go
   down and **raw** speech comes back up: `say(text): Promise<SpeechOutcome>`, `transfer`, `hangUp`.
   `CallRuntime` is the only thing that turns speech into a validated event.

2. **`perform(): Promise<void>` left `CallTurn.turnTakeOk` with nowhere to come from.** Turn-take is
   the metric Full-Duplex-Bench-v3 found the *fastest* model failing — silence in 22 of 100
   scenarios. Only the layer that actually spoke knows whether it spoke, when its first word
   landed, and whether it talked over the caller. So `say` returns a `SpeechOutcome` carrying
   exactly those numbers, and a `void` return would have made principle #5's budgets uncomputable.

3. **`EscalationReason.AGENT_ERROR` and its catalog line existed from day one with no event that
   could reach them.** The extractor's `unavailable` outcome is what reaches them. `CallRuntime`
   retries an `unavailable` extraction once behind the boundary, and a second outage drives a new
   `AGENT_ERROR` machine event — an Anthropic outage is a human's problem, never a caller asked
   their name a fourth time. A one-line addition to `machine.ts`, and the last dead escalation path
   is now live.

4. **`HttpTransport` moved from `crm` into `contracts`, for the same reason `Effect` did in Step 3.**
   Task 4.7's `GoogleGeocoder` speaks HTTP to a vendor too, and the only alternative was
   `validators` depending on `crm`, which points the dependency graph backwards. A port that
   crosses a package boundary belongs in the spine. `crm/src/http.ts` is deleted; `FetchTransport`
   performs real I/O from `contracts`, the same licence `systemClock` already takes.

5. **The runtime arms exactly one slot per turn, so out-of-order fills never arise at *this* layer.**
   `SlotBook` accepts any slot from any turn and the machine can cross four states on one utterance —
   but the extractor is only ever asked the single slot the machine is focused on (principle #1,
   enforced by the driving loop and not just the tool schema). A caller who volunteers three facts
   at once is still asked for the other two in turn. Multi-slot-per-turn extraction was considered
   and rejected: it is the sequential-tool-call task VoiceAgentBench shows models failing.

6. **A rejected read-back has no dedicated machine event, so "no" routes back through extraction.**
   On a rejected read-back `CallRuntime` re-extracts the *same* slot from the rejection utterance:
   a different value corrects it (revoking the confirmation, and the machine reads the new value
   back), while a bare "no" yields nothing and counts as an extraction failure — the bounded path
   that escalates a caller stuck rejecting rather than looping forever. Reusing the extraction
   escape hatch kept the machine's event set small and the loop finite.

7. **Task 4.1's Pydantic half needs a tool this environment forbids installing (PEP 668).** So the
   step split the way Step 1's fixtures did: the deterministic, offline half — the JSON Schema
   generated *from* the Zod, and a test that fails the build the moment the committed copy drifts —
   ships and is guarded in the PR suite. The `datamodel-code-generator` invocation that turns that
   schema into `contracts.py` is a documented build command, and `contracts.py` is `.gitignore`d
   because it is a generated artifact, never hand-edited.

**Also settled, and worth not re-litigating:**

- **The audio layer is a port with a fake, like everything else.** `FakeVoiceSession` records what
  it was told to say and lets a test script a silent turn; `FakeBookingSink` records the payload
  and can be made to throw. Tests assert on what the collaborator saw, never on a mocking framework.
- **`validateSlot` is duplicated with `eval/src/simulate.ts` on purpose, narrowly.** Both dispatch a
  raw extraction to the three validators, but `simulate.ts` also builds a `MachineEvent` for a
  text-driven harness, and the two pull apart the moment either changes. The validator *set* is the
  contract; a new one is a compile error in both places.

---

### Step 5 — Eval over the real path 🟡 **Core built (2026-07-10); nightly/SIP arms deferred**

The buildable half is the extraction seam, and it is exactly the task `CLAUDE.md` flagged as
"left undone rather than half-done." The eval harness no longer bakes the extracted value into
the scenario: a fill now *declares* which slot a turn states and *scripts the fake*, and the
caller's utterance text flows text → `SlotExtractor` → validators → machine, the same path
`CallRuntime` performs. The three arms that need a credential or a SIP trunk — LLM-driven
callers, real-SIP barge-in numbers, and the live prompt-cache measurement — are named and
deferred, exactly as Steps 1–4 deferred their live halves.

| # | Task | Detail | |
|---|---|---|---|
| 5.1 | Bind the real `SlotExtractor` port in `simulate.ts` | `deps.makeExtractor(scenario)` — the PR suite binds `FakeExtractor` scripted from the scenario's fills (`extractors.ts`, `scriptFromScenario`); the nightly arm binds `AnthropicExtractor` over the same seam, proven offline through an injected `fetch` (zero live calls). The outage-retry-then-`AGENT_ERROR` policy now mirrors `CallRuntime` on both sides of the port — surprise #3. | ✅ |
| 5.2 | LLM-driven caller personas | `claude-opus-4-8`. Impatient, heavy accent, background TV, gives the address wrong the first time, interrupts, changes their mind. The 13 committed scenarios *are* the scripted-persona arm; the LLM-driven caller needs a credential this environment does not have. Deferred, named — surprise #5. | ⬜ |
| 5.3 | Real-SIP arm, nightly | Only over SIP are barge-in and turn-take comparable to Full-Duplex-Bench-v3. No SIP trunk here. Deferred, named. | ⬜ |
| 5.4 | Turn-take regression blocks a merge | Already enforced — but in `runtime.test.ts`, not here: `CallRuntime` traces real `SpeechOutcome`s and `checkBudgets()` breaches `turnTakeRate` on a scripted silent turn (Step 4.9). The text-driven eval has no latency model, so its turn-take number is the SIP arm's — surprise #4. | 🟡 |
| 5.5 | **Measure the prompt cache against a live model, before quoting §10.5** | Re-record the Step 1 fixtures. Assert `cache_read_input_tokens > 0` on the second request — in the nightly arm, never the PR suite. `anthropicExtractor(client, onUsage)` already surfaces the hook where this assertion lands. If the prefix is below the model's minimum cacheable size it caches *silently*, and §10.5's cost model is wrong by ~10×. See Step 1, surprise #4. | ⬜ |

Existing scenarios keep running against fakes — fast, deterministic, gating every PR.

**Exit (partially met, and the gap is named).** The eval scores critical-slot accuracy and
containment over 13 scenarios driven through the *real* `SlotExtractor` port — but in the PR
arm that port is `FakeExtractor`, so the number proves the port, the validators, and the machine
carry values through intact, **not** that `claude-sonnet-5` heard them right. The nightly arm
that would prove the latter is bound and typed and driven offline; it has never called a live
model. That is task 5.5, where the credential first exists — the same precedent Steps 1–4 set.

**Result:** 616 tests (was 611), 99.19% coverage, typecheck clean, `apps/web` builds. The +5 are
all in `packages/eval`: the port is exercised (the collaborator saw the right slot and utterance),
a corrected slot is re-extracted from the correction utterance, an outage retries once and then
escalates as `AGENT_ERROR`, a transient outage recovers on the retry, and the nightly
`AnthropicExtractor` binding is driven end to end through an injected `fetch`.

#### Five things came out different from what this Step predicted

1. **There was no "extractor stub" to replace — the stub was the scenario.** 5.1 said "replace
   the extractor stub in `simulate.ts`," but `toEvent` read the value straight out of `fill.raw`;
   there was no extractor object at all. So the real change was to make a fill *declare* a slot and
   *script the fake*, and to route the turn's text through `deps.makeExtractor(scenario).extract(...)`.
   The value now takes the production path — text → port → validators → machine — instead of
   scenario → machine. This is the whole point of the step: without the port, the eval can never
   run against the real model.

2. **The extractor is built per-scenario, not per-run, so it is a factory.** The PR fake is
   scripted from *that scenario's* fills, which means it cannot be one shared instance on
   `SimulationDeps`. `makeExtractor: (scenario) => SlotExtractor` is the one interface change; the
   nightly arm ignores the argument and returns a single `AnthropicExtractor`, because there the
   model — not the script — produces the value.

3. **The outage-retry policy is now asserted on both sides of the port, deliberately.**
   `extractAndBuild` retries an `unavailable` outcome once and then drives `AGENT_ERROR`, exactly
   as `CallRuntime.extractAndApply` does. The gotchas already said `simulate.ts`'s validator
   dispatch and `runtime`'s `validateSlot` are "not duplicates to merge"; the retry policy is now a
   third such deliberate twin. It is the same contract on the two sides of the seam, and a suite
   that let one drift from the other would be lying about what the runtime does.

4. **5.4's turn-take gate already lives in `runtime.test.ts`, and that is correct.** The
   text-driven eval has no latency model — every turn is instantaneous — so a turn-take number
   computed here would be a fiction. The layer that actually spoke is the one that knows whether it
   spoke, so `CallRuntime` traces the `SpeechOutcome`s and `checkBudgets()` breaches `turnTakeRate`
   on a scripted silent turn (Step 4.9). The eval's turn-take arm is the real-SIP arm (5.3),
   because only over SIP is the number comparable to the literature.

5. **The nightly arm is provable *offline*, so the seam ships proven rather than merely typed.**
   "AnthropicExtractor in the nightly arm" reads like it needs a key, but the *binding* does not:
   inject the SDK's `fetch`, answer with a committed `tool_use` body, and the eval harness drives
   the real extractor end to end — the cached request it builds, the block it interprets, the value
   through the validators and the machine. Only the *live model* — re-recording fixtures and
   asserting the cache actually hits — needs a credential, and that was already task 5.5. Same
   split as Step 1's hand-authored fixtures.

**Also settled, and worth not re-litigating:**

- **A fill's `raw` is the fake's script, never a shortcut around the port.** Every fill is now
  extracted; the garbage-phone scenario returns `filled("call me maybe")` and the *validator*
  rejects it, exactly as a real extractor's output would be rejected. Nothing reaches the machine
  without crossing the port and the validators.
- **`eval` now depends on `@ledgerline/extraction` at runtime**, which the dependency diagram
  always anticipated ("eval binds it at Step 5.1"). `FakeExtractor` and the `AnthropicExtractor`
  binding both live behind that edge; `@anthropic-ai/sdk` rides in transitively and is declared.
- **Confirmations stay declarative.** A caller's yes/no to a read-back is not a slot value, so
  `confirms`/`confirmsAll` do not route through the extractor — only fills do. That matches the
  machine's event set and keeps the harness honest about what the port is for.

---

### Step 6 — Correction triage + FAQ 🟡 **Core built (2026-07-11); live/DB-gated tails deferred**

Step 2 made the wedge computable: *that* a booking was corrected. Step 6 asks *why*, and the
whole step is an argument with itself about how a model that grades our own homework could cheat.
The answer is not that the model is trustworthy. The answer is that **every failure mode of this
pipeline makes our published number worse**, and that the classifier is not used at all until a
human audit vouches for it.

| # | Task | Detail | |
|---|---|---|---|
| 6.1 | Nightly `claude-opus-4-8` pass | `packages/triage`: `AnthropicTriager` behind the new `CorrectionTriager` port — one forced strict tool, `agent_error \| business_change \| enrichment \| null`, a mandatory rationale, and a system prompt whose last paragraph tells the model to be *harder* on itself. `runTriage()` in `packages/workflows` is the batch. Proven offline through an injected `fetch`; it has never called a live model. | 🟡 |
| 6.2 | Raw diff stored unclassified, forever | Not a convention — a type. `TriageStore.classify` takes `{bookingId, observedAt, classification, rationale, classifiedBy, classifiedAt}` and cannot express an edit to `correctedFields`, exactly as `OutcomeDeps.crm = Pick<CrmAdapter, "readJob">` cannot express a write. | ✅ |
| 6.3 | Weekly 10% human audit → `outcomes.human_label` | `auditSample()` hashes the booking id (deterministic, unre-rollable, unsteerable). `computeMetrics()` reports `auditedOutcomes` and `triageAgreementRate`; `publishedCorrectionRate()` refuses to use the classifier below 95% agreement or 20 labels. The *ritual* — a person, weekly — needs the dashboard and the database. | 🟡 |
| 6.4 | FAQ retrieval (`pgvector`) behind a filler utterance | `packages/faq` + two new effects (`SAY_FILLER`, `ANSWER_FAQ`). The runtime speaks the filler *first*, then retrieves, then speaks — and the model **selects** a committed answer rather than writing one. `InMemoryFaqIndex` + `HashingEmbedder` ship; `pgvector` and a real embedder need the database. | 🟡 |
| 6.5 | **Measure the model against a human, before quoting any triaged number** | The agreement rate is the licence to use the classifier at all, and it cannot exist until real corrections and a real auditor do. `publishedCorrectionRate()` already assumes the answer is "not yet" and quotes the raw rate. Needs a credential *and* a live CRM. | ⬜ |
| 6.6 | Bind a real embedder; tune `SIMILARITY_FLOOR` against it | `HashingEmbedder` has no semantics — "how much do you charge" and "what does it cost" score zero against each other. The floor (0.15) is calibrated against *it*, which is to say against nothing. Step 7, with the database. | ⬜ |

**If model and human disagree more than ~5% of the time, publish the raw correction rate and
drop the classifier until it earns its place.** That sentence is now
`publishedCorrectionRate()`, with `AUDIT_AGREEMENT_FLOOR = 0.95` and `MIN_AUDITED_OUTCOMES = 20`.
It was written *before* the day the raw number embarrasses us, which is the only day it matters.

**Exit (met for the core, and the gap is named).** The triage pipeline runs end to end over real
`BookingOutcome`s, the FAQ detour runs end to end inside a real call, and six mutations of the
invariants were verified to fail the suite. What has never happened: a live model call, a real
correction, a human auditor, and a `pgvector` query.

**Result:** 708 tests (was 616), 99.29% coverage, typecheck clean, `apps/web` builds.

#### Five things came out different from what this Step predicted

1. **"Only `agent_error` counts against `correctionRate`" was the most dangerous sentence in this
   plan, and it is now two numbers instead of one.** Read literally, it makes triage a machine for
   deleting our own failures: a classifier that declines, an Anthropic outage, or a cron nobody
   wired up would each *silently improve* the published figure — the missed-webhook failure mode
   (§7) wearing a third hat. So `correctionRate` stays **raw and untouched**, `agentErrorRate` is
   computed beside it, and **an unclassified correction is an agent error**. Every way this
   pipeline can fail now pushes the published number *up*. That inversion is the whole step, and
   `packages/telemetry` has a test for each direction.

2. **Extended thinking and a forced `tool_choice` are mutually exclusive in the Messages API**, so
   §6's "structured output, adaptive thinking" for call site #5 could not be had. We kept the
   forced tool: a nightly pass whose label has to be parsed out of a paragraph is a nightly pass
   that mislabels whatever it fails to parse, and a label outside the enum is not a fourth kind of
   correction — it is `declined`, which counts against us.

3. **The FAQ model selects an answer; it never writes one.** §6 said "tool use + `pgvector`
   retrieval", which reads like RAG — retrieve context, generate an answer. That is a model quoting
   a price on a recorded line that the contractor never approved, and "the retrieval was right, the
   phrasing drifted" is not a defence anyone will accept. So the tool returns an *id*, the caller
   hears the contractor's committed sentence verbatim, and an id we never sent comes back
   `unknown`. This is principle #3's "no model speaks a sentence whose content is load-bearing",
   arrived at from the other end — and it makes `faq_entries.answer` a review surface owned by the
   contractor, exactly as `catalog.ts` is one owned by us.

4. **A question is not an extraction failure, and the fix is where the check sits.** The FAQ detour
   runs **only on an utterance the extractor already found nothing in**, which is what makes it
   safe: an utterance that fills a slot can never be spent on the FAQ, however it is phrased. Put
   the question check *first* and a caller saying "what? oh, Rosa Peña" loses their name to a
   filler. Two `runtime` tests fail if you move it. And a caller who only ever asks questions is
   bounded (`maxFaqAnswers`, 3) into the ordinary extraction-failure path, which ends in a human.

5. **Three packages now speak to Anthropic, so the vendor got a boundary.** `CLAUDE.md` said "the
   model SDK implementation lives in `extraction` and stays there"; Step 6 adds two more call
   sites, and that rule stops being true. What must *not* be triplicated is the answer to "is a
   `429` an outage or our bug" and "how do we prove a binding with no credential" — both are
   properties of the API, not of any call site. `packages/anthropic` holds exactly those two
   things and nothing else: no prompts, no tools, no domain types.

**Also settled, and worth not re-litigating:**

- **`isCorrected` and `effectiveLabel` live in `contracts`.** `telemetry` counts corrections and
  `workflows` decides which ones to send for triage; if they disagreed about what "corrected"
  means, the published number would not add up. The human label always beats the model's — a
  tie-break that preferred the model would make the audit decorative.
- **The audit sample is hashed, not random.** Stable (the same booking is in or out forever, so a
  disliked week cannot be re-rolled) and unsteerable (the id was assigned before the outcome
  existed). `Math.random()` is neither, and nothing in this repo reads entropy it did not inject.
- **`SAY_FILLER` and `ANSWER_FAQ` are the only effects `transition()` never emits.** They change no
  slot, no state, and no guard, so they are not machine events — but they are still effects,
  because the Python worker is the thing that has to speak them. `RUNTIME_ONLY_EFFECT_TYPES` names
  them so a reader of `machine.ts` does not conclude they are dead.

---

### Step 7 — Product 🟡 **Core built (2026-07-11); credential-gated tails deferred**

Every step so far ended with the same sentence: *this is real code behind a real port, and it
has never met the vendor.* Step 7 is the first one where **the vendor came to us.** Postgres
compiles to WebAssembly, so `packages/db` no longer has to guess: the schema, both migrations,
the RLS policies, the column grants, `pgvector`'s cosine operator, and every store run against
an *actual* Postgres in the PR suite, with no credential and no network. That is a strictly
stronger claim than any other binding in this repo can make, and it is available only because
Postgres is the one vendor that will run in-process.

The gates that remain are the ones a database cannot supply: a Clerk key, a Housecall Pro
developer account, a Twilio number, and a Neon URL.

| # | Task | Detail | |
|---|---|---|---|
| 7.1 | Tenant isolation via Postgres RLS | Migration `0002`. Every tenant-scoped table `ENABLE`d **and** `FORCE`d, policies on `current_setting('app.tenant_id')`, and a dedicated `ledgerline_app` role that owns nothing — see surprise #1, which is the reason the role exists at all. `TENANT_SCOPED_TABLES` is the spec and `rls.test.ts` checks the database against it, so a new table with no policy fails the build. | ✅ |
| 7.2 | `packages/db` gains a client | `withTenant(db, tenantId, fn)` — one transaction, `set_config(..., is_local => true)`. Surprise #2 is why it is not a `SET`. `packages/db` was schema-only until now on the honest grounds that "a pool nobody opens is a lie about what is built"; it is not a lie any more. | ✅ |
| 7.3 | The Postgres stores, and the cron that finally calls them | `PgSnapshotStore`, `PgOutcomeStore`, `PgBookingStore`, `PgTriageStore`/`PgAuditStore`, `PgVectorFaqIndex` — every port earlier Steps left with a double and a note saying "the real one is Step 7's". `runOutcomePolls()` in `workflows` is the cron body; `apps/web/app/api/cron/*` and `vercel.json` are the schedule. **`bookings.completed_polls` is now a column somebody increments.** | ✅ |
| 7.4 | Billing per booked job | `packages/billing`. And the rule that makes the wedge survivable: **we do not bill for a booking we got wrong** — including one nobody has classified yet. See surprise #4. | ✅ |
| 7.5 | Onboarding: Housecall Pro OAuth, service area, hours, job types, greeting | The *provider* is already a column and `crmForTenant()` switches on it, so a Jobber shop and a Housecall Pro shop poll through the same code. The credential is the gap: no developer account, so no OAuth flow, so `crm_credentials_enc` holds a sentinel and `crmForTenant()` **refuses** rather than falling back to another tenant's token. | ⬜ |
| 7.6 | Clerk auth | The seam is built (`TenantResolver`), and every route funnels through it into `withTenant()`. The binding is eight lines and needs a key. Isolation does not depend on it: it lives in the database, so swapping the identity provider changes one file and nothing below it. | ⬜ |
| 7.7 | A live Neon instance | `neonDatabase()` ships and has never connected. It is the only thing in `packages/db` that has not met a real Postgres. Applying the migrations to a real Neon also unblocks **6.6** (a real embedder, and `SIMILARITY_FLOOR` calibrated against something) and **4.10** (the live CRM sandbox). | ⬜ |

**Exit (met for the core, and the gap is named).** Tenant isolation is proven — not asserted —
against a real Postgres: one contractor cannot read another's calls, cannot write into another's
tenant, cannot reach another's FAQ answers through the retrieval index, and an unscoped
connection sees *nothing at all*. The poller and the nightly triage pass have a schedule. Billing
exists and refuses our own money. What has never happened: a Clerk session, an OAuth handshake, a
Neon URL, and a contractor.

**Result:** 774 tests (was 708), 99.31% coverage, typecheck clean, `apps/web` builds (6 routes,
was 3).

**Mutation-tested, all three caught:** making `set_config` session-level instead of
transaction-local (the tenant leaks to the next request on a pooled connection — exactly one test
catches it); billing an unclassified correction; and letting a failed poll consume the poll it
still owes.

#### Four things came out different from what this Step predicted

1. **"Tenant isolation via Postgres RLS" is not what protects you. The connection role is.**
   This is the finding that shaped the step, and it is a fact about Postgres that a deployment
   gets wrong *silently*.

   Postgres exempts a table's **owner** from row-level security unless the table is `FORCE`d —
   and exempts a **superuser** even then. Neon's default connection string is the owner. So the
   obvious, documented, everybody-does-it deployment — write the policies, take the URL Neon
   hands you, ship — produces a database with a complete set of RLS policies that **do
   nothing**. There is no error. There is no warning. Every query returns every tenant's rows,
   and every test written against that connection passes with the policies deleted.

   The mitigation is a role that owns nothing: migration `0002` creates `ledgerline_app`,
   `FORCE`s RLS on all fourteen tables, and grants it only DML. `DATABASE_URL` must name *it*.
   And because "we must remember to use the right role" is exactly the kind of thing a team
   forgets, `rls.test.ts` **pins the bypass**: there is a passing test asserting that the owner
   sees both tenants' rows. It reads like a bug. It is the documentation.

2. **A pooled connection makes `SET app.tenant_id` a cross-tenant read with no bug in any
   query.** The natural way to scope a request is to set the GUC when you get the connection.
   But the connection is *pooled*: the setting outlives the request that made it, and the next
   request — a different contractor — inherits it. Nothing in any query is wrong. The `WHERE`
   clauses are right, the policies are right, and the data is somebody else's.

   So the tenant is set with `set_config(..., is_local => true)` **inside a transaction**, where
   it dies whether the transaction commits or rolls back. `SET LOCAL` cannot take a bind
   parameter, which is the real reason it is the function form rather than the statement.

   This also forced the driver: **`drizzle-orm/neon-http` cannot be used**, because it does not
   support transactions at all — and no transaction means no `is_local`, which means no
   `app.tenant_id`, which means every policy evaluates against NULL. The HTTP driver is the one
   Vercel's docs reach for first. The WebSocket pool is the price of row-level security, and
   row-level security is the price of multi-tenancy.

3. **RLS needs `tenant_id` on every table, denormalized — and the denormalization is enforced by
   a foreign key, not by review.** A policy is a `USING` clause evaluated per row. It can afford
   `tenant_id = app_current_tenant()`. It cannot afford `EXISTS (SELECT … JOIN … JOIN …)` three
   levels up from `outcomes` to the owning tenant. So `tenant_id` is denormalized onto
   `call_turns`, `slots`, `escalations`, `bookings`, `job_snapshots`, and `outcomes`.

   Denormalized data can disagree with its source, and a row whose `tenant_id` says one thing
   while its parent call says another is a row RLS hands to the wrong contractor. So it is not
   allowed to disagree: every child declares a **composite foreign key** on `(parent_id,
   tenant_id)`, and every parent a matching unique constraint. Filing a call turn under the
   wrong tenant does not fail a code review — it fails the database. That is
   `TriageStore.classify`'s move (a guarantee carried by the type system) done in DDL.

   And the same reasoning produced a *second* database-level guarantee we did not plan: the app
   role holds `UPDATE` on `outcomes`' **seven derived columns and nothing else**, and no `DELETE`
   at all. Step 6.2 made "the raw diff is never written" a type error. It is now also a
   permission error, which holds for a raw `db.execute()` that never went near the port. A model
   grading our own homework must not be able to erase the homework, and one mechanism guarding
   that is one mechanism away from none.

4. **Billing per booked job is not the incentive alignment. Refusing to bill for a booking we got
   wrong is.** "Per booked job rather than per minute" only fixes the obvious perversion — that
   per-minute pricing pays us to keep a homeowner on the phone. It leaves a worse one standing:
   if we bill for every job that reaches the CRM, then **a booking the contractor had to fix is
   still revenue**, and our own error rate becomes an income stream. We are the company that
   publishes its error rate. Those two facts cannot both be true of one business.

   So `billable = !cancelled && !isAgentError(outcome)` — and `isAgentError` is imported from
   `contracts` rather than restated, because `telemetry` computes the number we *publish* from
   the same predicate. If they drifted, we would invoice a contractor for a booking we had
   publicly called our own mistake. `invoice.test.ts` asserts the identity directly.

   The consequence is the good part. `isAgentError` counts an **unclassified** correction as our
   fault (Step 6's inversion), so a triage backlog, a declined verdict, an Anthropic outage, or a
   cron nobody wired up now costs us *money* and not merely a worse published number. Every
   failure mode of this pipeline has a price, and we pay it. `Invoice.staleTriage` reports how
   much, because the first symptom of a broken cron must not be a quiet drop in revenue.

**Also settled, and worth not re-litigating:**

- **The store ports moved into `contracts`** — `SnapshotStore`, `TriageStore`, `AuditStore`,
  `FaqIndex`, `Embedder`, plus the new `OutcomeStore` and `BookingStore`. `packages/db` cannot
  implement a port it would have to depend on `workflows` to see, and `db → workflows → crm`
  points the graph backwards. Same argument as `Effect` (Step 3) and `HttpTransport` (Step 4): a
  port that crosses a package boundary belongs in the spine. The in-memory doubles stay where
  they are; they are test doubles, not contracts.
- **`isAgentError` and `latestPerBooking` moved into `contracts` too**, for the reason in
  surprise #4. Three packages now ask "was this our fault", and they must not be able to disagree.
- **The poll *schedule* stays in `workflows`, not in the store.** `BookingStore.unfinished()`
  answers a storage question ("which bookings still owe a poll"); `nextDuePoll()` answers the
  product one ("is one due yet"). A store that knew `POLL_OFFSETS_MS` would put a product
  decision — when a correction is likely to land — inside a SQL file.
- **Vercel Cron sends `GET`.** A route exporting only `POST` deploys, schedules, and never fires,
  and the symptom is a correction rate of zero — precisely the number a dishonest vendor would
  report. The safety of a mutating `GET` rests entirely on the `CRON_SECRET` check, and a missing
  secret is a **refusal**, never a bypass.
- **`drizzle-kit generate` emitted a migration that does not apply.** It ordered every composite
  foreign key *before* the unique constraint it references. We know because we ran it. Nothing
  short of running it would have found that, and until this Step nothing could.

---

### Step 8 — Compliance 🟡 **Core built (2026-07-11); the signature is deferred**

This Step was described above as gating *launch, not code*, and that sentence turned out to
be the single most misleading line in this plan. Every bullet in it could have been a policy
document — and a policy document is a thing you are later found to have breached. **The whole
argument of this repo is that a rule worth having is a rule the system cannot break**: RLS
rather than a `WHERE` clause, `Pick<CrmAdapter, "readJob">` rather than a code review, an
unclassified correction counting against us rather than a promise not to cheat. Compliance is
the step where that argument is either true or was always decoration.

So `packages/compliance` is a package, not a page. `docs/COMPLIANCE.md` and `docs/DPA.md`
exist, and every rule in them names the code that enforces it.

| # | Task | Detail | |
|---|---|---|---|
| 8.1 | AI disclosure, verbatim, and **proof a caller heard it** | `AI_DISCLOSURE` moved from `utterance` to `compliance`, gained `DISCLOSURE_VERSION`, and `catalog.ts` re-exports it. `auditDisclosure()` scores real traces: an agent turn carrying the string **verbatim** *and* `turnTakeOk` — a greeting the TTS never spoke is not a disclosure. Its only passing rate is `1.0`. | ✅ |
| 8.2 | Two-party consent by area code, conservative default | `compliance/consent.ts`. 14 all-party states (four contested, all listed strictly), ~300 area codes, and the property that matters: **an incomplete map is safe**. See surprise #1. | ✅ |
| 8.3 | The notice, then the tape | The new `Recorder` port; `CallRuntime` is its only caller, and calls `begin()` only once the disclosure's `SpeechOutcome.spoke` comes back true. `RECORD_FROM_ANSWER` requires *both* ends to be known one-party states. Off without an enabled tenant and a current DPA. | ✅ |
| 8.4 | TCPA: no outbound | `TransactionalSms` — a branded type, and `transactionalSms(booking, body)` is the only thing that can mint one. It reads `to` **out of the booking**. An outbound campaign is a compile error. See surprise #3. | ✅ |
| 8.5 | PCI scope: never take payment | `redactPan()`, the **first statement** of `CallRuntime.hear`/`hearPartial`. The card never reaches the classifier, the extractor, Anthropic, Postgres, or the CRM. A labeled corpus, both directions, with one pinned false positive. See surprise #2. | ✅ |
| 8.6 | Retention and deletion | 90 days (audio) / 365 (words). `runRetention()`, `PgRetentionStore`, migration `0003`, and `/api/cron/retention`. **The words go and the numbers stay** — surprise #4. `HttpRecordingArchive` has never spoken to a live carrier; it needs Step 4.2's telephony account. | 🟡 |
| 8.7 | **A lawyer reads it** | `DPA_VERSION`, `tenants.dpa_version`, and a gate: no current DPA, no recording. The documents are written and the code enforces them. **Nobody has signed anything.** This is the one thing in Step 8 that a credential cannot buy and code cannot replace. | ⬜ |

**Exit (met for the core, and the gap is named).** Seven mutations of the invariants were
verified to fail the suite. What has never happened: a lawyer's signature, a live carrier
deletion, and a caller.

**Result:** 919 tests (was 774), 99.36% coverage, typecheck clean, `apps/web` builds (7
routes, was 6).

**Mutation-tested, all seven caught:** an unknown area code becoming one-party (2 tests); the
tape starting before the disclosure (5); `requiresNoticeBeforeRecording` making *ignorance*
permissive (4); the tombstone written before the media is deleted (2); a **silent** greeting
still starting the tape (1); the PAN redaction moved to after the extractor (2); and dropping
the Luhn/grouping guard, which eats a caller's phone number (1).

#### Five things came out different from what this Step predicted

1. **"Keyed off the caller's area code" is a sentence that cannot mean what it says, and the
   conservative default is not a fallback — it is the design.** Number portability means a
   `+1 415` number can be standing in a Boston kitchen, and nothing in the signalling tells
   us. Every verdict is a *belief*, so the only real question is which way the beliefs are
   allowed to be wrong.

   They are allowed to be wrong toward caution and never away from it. An area code we do not
   know is all-party — so an **incomplete map is safe**, and every NANP code assigned after we
   shipped is safe on the day it is assigned, with no deploy. The asymmetry then propagates
   backwards into the data: the all-party half of the map is deliberately *generous* (a wrong
   entry costs us a recording), and the one-party half lists only codes we are sure of (a
   wrong entry records somebody entitled to be asked first). Vermont has no wiretapping
   statute at all, so it is `UNKNOWN` rather than one-party: **"no statute" is not
   "permissive."**

   And the *contractor* is a party too, whose state we actually know. A court applies the
   stricter of the two laws, so `ONE_PARTY` requires **both** ends to be known one-party
   states — a claim we can defend, rather than one we merely have no evidence against.

2. **"PCI scope avoided entirely by never taking payment on the call" is a claim about us, and
   PCI scope is not decided by us.** It is decided by whether cardholder data is present in
   our systems, and a caller who says *"I'll just pay now, it's 4111 1111 1111 1111"* has put
   it there without being asked. We never ask for a card; that is not remotely the same as
   never receiving one, and the difference is a QSA's entire job.

   So `redactPan()` is the first statement of `hear()` and `hearPartial()` — the only two
   doors a caller's words enter this system through — and the card is gone before the
   classifier, before the extractor, and therefore before Anthropic, before Postgres, and
   before the contractor's CRM. **The trade-off runs the opposite way to the consent map's**,
   which is what makes it interesting: over-redaction shreds a number the *plumber* needed, so
   this classifier is precise rather than merely aggressive, has a labeled corpus in both
   directions, and pins its one deliberate false positive exactly as `packages/safety` pins
   its three.

3. **"We should not do outbound, initially" is a sentence in a plan. The TCPA is a statute
   with a per-message private right of action.** So `SmsSender.send()` now takes a
   `TransactionalSms` — a branded type whose sole constructor takes a `PendingBookingPayload`
   and reads the destination *out of it*. The only number this system can text is the
   `callback_phone` a caller gave us on their own call and confirmed on a read-back. An
   outbound campaign is not a policy we have decided against; it is an expression that does
   not typecheck.

   We also **did not** build a quiet-hours gate, deliberately. Every message we can send
   confirms an appointment the recipient asked for seconds earlier on a call they placed. A
   gate we would have to bypass on exactly the calls that matter most is theatre, and theatre
   is worse than nothing: it teaches the next reader that the constraint was handled.

4. **The retention policy and the reliability promise are the same design decision, and we
   made it two steps ago without noticing.** Retention deletes the recording and blanks
   `call_turns.text` — and every number in `computeMetrics()` survives, because principle #5
   defined the metrics over turn *shape* (`first_word_latency_ms`, `barge_in`, `turn_take_ok`)
   and never over turn *content*. **The reliability figures can be recomputed, from scratch,
   over a database that has forgotten every caller who ever phoned.**

   That reads like a lucky accident and is not. The obvious way to build any of those metrics
   — a containment heuristic over the transcript, a barge-in detector looking for a cut-off
   word — would have coupled the number we publish to the caller's own words, and a retention
   policy would then have been a *choice* between deleting somebody's voice and being able to
   prove our error rate. Nobody makes that choice on purpose. It gets discovered, late, by
   somebody looking for a way out of it. A test in `telemetry` now pins it by computing the
   metrics twice, once over turns whose text has been deleted.

   The interlock runs the other way too, and Step 8 added no SQL to get it: the app role holds
   **no `DELETE` on `outcomes` or `job_snapshots`** (migration `0002`), so the deletion policy
   structurally cannot shred the corrections that made our published number look bad. A
   retention job with a compliance badge is exactly the shape a dishonest one would take.

5. **The demo data had quietly invented its own disclosure, and nothing could have caught it
   until now.** `apps/web/lib/demo-data.ts` carried seven hand-written variations on "you're
   speaking with an automated assistant" — none of them the committed string, none of them
   mentioning that the call may be recorded. It looked completely fine on a dashboard and it
   disclosed nothing. `auditDisclosure()` scores the string **verbatim** precisely because a
   paraphrase is a disclosure nobody reviewed, and the first thing it found was ours.

**Also settled, and worth not re-litigating:**

- **`AI_DISCLOSURE` lives in `compliance` now, and `catalog.ts` re-exports it** — the
  `machine.ts`/`Effect` move, for the reason that settled `isCorrected` (Step 6) and the store
  ports (Step 7): a thing two packages must agree on belongs upstream of both. It is also not
  really an utterance. It is legal text that happens to be spoken, and its neighbours are
  `DPA_VERSION` and the consent regime — the things one person reviews in one sitting.
- **The recording notice lives *inside* the disclosure**, and that is not economy. In an
  all-party state, notice plus continued participation *is* the consent, so that sentence is
  the mechanism by which we may record at all. Two separate sentences would eventually mean
  one of them being cut in a tone pass, and it would be the one that mattered.
- **A stale DPA is no DPA.** What changes between versions is the subprocessor list and the
  retention schedule — precisely the two clauses a caller would care about. Bumping
  `DPA_VERSION` therefore turns recording off for every tenant until each re-accepts, which is
  deliberately expensive: a version bump that cost nothing would be a version bump nobody read.
- **A failed deletion is counted, never tombstoned** — the poller's rule ("a failed poll does
  not consume the poll it still owes"), and the same reasoning. A row saying
  `recording_deleted_at` beside audio still in a carrier's bucket is a false statement about
  somebody's voice, and a *self-healing* one: the call leaves the working set and no later run
  ever looks at it.
- **The one rule with no test behind it, stated in bold in three places:** the carrier's own
  recording switch must be off. Twilio will record from the moment a call is answered if asked,
  and no amount of correct logic on our side unmakes those seconds. It is a deployment fact,
  not a code guarantee (`docs/COMPLIANCE.md` §2, `apps/agent/README.md`).

---

### Step 9 — Publish the number 🟡 **Core built (2026-07-12); the number needs a contractor**

Write up `correctionRate` across N tenants and M thousand calls, with the methodology and the
human-audit agreement rate. `idea.md` §7 says nobody has this. Being first to publish it *is*
the marketing — and it only works if the disciplines in §7 held.

**This Step was described above as one that "cannot be *built*: it needs real tenants, real
calls, and real corrections… what is missing is a contractor."** That is half true, and the
half it gets wrong is the half with all the engineering in it. Everything Step 9 would
*report* was indeed already computed. Nothing that would *publish* it existed — and the act of
publishing turns out to have four hazards, three of which no earlier Step could have found,
because they only appear the moment a number leaves the building.

The deliverable is therefore the **mechanism and the methodology**, and its first act is to
**refuse to publish**. There are no contractors, so there is no number, and `/published` says
so in those words. That refusal is not a placeholder standing in for the real Step; it is the
first thing this page has ever had to be right about.

| # | Task | Detail | |
|---|---|---|---|
| 9.1 | The cross-tenant cohort | `app_reliability_cohort` — a `SECURITY DEFINER` function that sees every tenant's rows and **can only return counts** (migration `0004`), plus `CohortReader`/`PgCohortReader`. See surprise #1. | ✅ |
| 9.2 | The publication decision | `decidePublication()` in `telemetry`. Four sample gates, a Wilson interval, the worst tenant beside the pooled average. **No gate can read the rate** — surprise #3. | ✅ |
| 9.3 | An append-only ledger of figures | `reliability_reports`; `ReportStore` has no `update`/`delete` and the app role has no `UPDATE`/`DELETE` grant. A quarter we disliked cannot be withdrawn, only followed. | ✅ |
| 9.4 | The public page, the feed, the cron | `/published` (renders the *live* decision, so a cron nobody ran cannot leave a stale figure looking current), `/api/reliability` (public JSON, built to be archived **by other people**), `/api/cron/publish` (quarterly, on the 15th — surprise #4). | ✅ |
| 9.5 | **The number itself** | Needs three contractors, a thousand calls, and five hundred matured bookings. The gates are what say so, and they are the reason this row is not a lie. | ⬜ |
| 9.6 | The write-up | `docs/RELIABILITY.md` — the methodology, published **before** the number, because a methodology published after the result is a methodology written to fit it. | ✅ |

**Exit (met for the mechanism; the number is named as missing).** Eight mutations verified to
fail the suite. What has never happened: a contractor, a call, and a correction.

**Result:** 976 tests (was 919), 99.39% coverage, typecheck clean, `apps/web` builds (10
routes, was 7).

**Mutation-tested, all eight caught:** `SECURITY DEFINER` → `SECURITY INVOKER` (the aggregate
sees nothing — 4 tests); counting immature bookings in the denominator (3); an unclassified
correction becoming *not* our fault in the SQL (2); dropping the minimum-bookings gate, so an
empty cohort publishes 0.0% (2); **adding a gate that withholds an embarrassing number** (3,
one of which exists solely to say so); Wilson → the textbook normal approximation (3);
granting `UPDATE`/`DELETE` on `reliability_reports` (2); dropping the idempotency guard, so a
retried cron stacks two figures for one quarter in a table nothing can clean up (1).

---

#### Surprise #1 — the number we publish is the only one in the system that has no tenant

Principle #6 says tenant isolation is a property of the database: every query runs inside
`withTenant()`, row-level security filters every row to `app.tenant_id`, and **an unscoped
connection sees nothing**. That is the guarantee the whole of Step 7 was built to earn.

The published figure is an aggregate across *every* tenant. So it cannot be computed that way
— and the obvious workaround is a catastrophe. Connect as the table owner and count: Postgres
exempts an owner from RLS unless the table is FORCEd, and a superuser even then, so the one
number we show the world would be the one produced by **the only connection in the system with
no isolation at all**. `rls.test.ts` has a passing test proving that bypass exists, and it was
written in Step 7 precisely so nobody would reach for it. Step 9 is the step where somebody
would have.

The second workaround is subtler and worse: loop `withTenant()` over every tenant and add the
results up. That requires a *list of tenants* — which is a list somebody can shorten. **Picking
the customers who make us look good is the most obvious way to cheat at this and the easiest
one to hide**; a `tenantIds?: string[]` parameter with a comment saying "for testing" would
read as reasonable in review forever.

So: a `SECURITY DEFINER` function, owned by the migration runner, granted to `ledgerline_app`,
whose **return type is a row of counts**. The app role gains the ability to compute the
statistic and gains no ability to read a row it could not read a moment ago — there is a test
for each half of that sentence, and flipping the function to `SECURITY INVOKER` fails four.
`CohortReader.cohort()` takes a window and nothing else, so cherry-picking a subset would need
a schema change, a migration, and a conversation.

That is `Pick<CrmAdapter, "readJob">` and `TriageStore.classify` done in DDL: **the signature
is the guarantee.**

#### Surprise #2 — the newest bookings always flatter us, and the calendar would have done it for us

A booking committed yesterday has not been re-read at 72h or 7d yet, so **no correction *can*
have been observed on it**. Leaving it in the denominator dilutes the numerator with bookings
that never had a chance to fail.

The consequence is that a vendor who published monthly, from the first of the month, would
report a number bent in their favour **by the calendar alone, and would never have to know they
were doing it.** There is no bad actor in that story and no bug in any query. It is the
missed-webhook failure mode (principle #5) arriving through arithmetic instead of through
delivery, and it is the one that would have shipped, because the code that produces it is the
code you would write.

So a booking counts only once its full poll schedule has run. And because *that* exclusion is
itself abusable — a CRM outage stops the polls, and the survivors publish a lovely number —
`observedCoverage` is a **publication gate** rather than a footnote: below 95% we publish
nothing and say we could not observe our own product.

#### Surprise #3 — the load-bearing property is the one the code does *not* have

Every other discipline in this repo is something the code does. This one is something it
cannot do: **there is no branch in `decidePublication()` that reads the correction rate.**

Every reason a figure can be withheld is a statement about the *sample* — too few tenants, too
few calls, too few bookings, too much of the window unobserved — and each is printed beside the
cohort it was measured over. There is no path from *this quarter is embarrassing* to
`withheld`, and `publication.test.ts` asserts that a cohort in which the contractor corrected
**every single booking we made** publishes 100%, on the front page.

That test is the product. A vendor who retains the option to suppress a figure they dislike has
published nothing, whatever their website says — and the only way to be believed is to have
**deleted the option**, in code somebody else can read. Adding a gate that reads the rate fails
three tests, one of which exists for no other purpose.

The same argument settles two smaller questions. The **window is derived, never chosen**
(`lastCompleteQuarter()`): a vendor who picks their reporting period has a free parameter worth
more than any amount of spin, and *the trailing 37 days* catches a good streak in a way nobody
could ever prove was deliberate. And a **published figure cannot be retracted** — no `UPDATE`,
no `DELETE`, in the port *and* in the grant — so a bad quarter can only be followed by another
quarter published beside it, and **the gaps in the history are visible on purpose.**

#### Surprise #4 — a quarterly cron on the 1st would have withheld every quarter, forever

The last bookings of a quarter are polled at 24h, 72h, and 7d. On the 1st of the following
month they are still *immature*, so they are excluded from the rate, so `observedCoverage`
craters, so the coverage gate refuses to publish — and the failure would have looked like a bug
in the gates rather than a bug in the schedule. `vercel.json` fires on the **15th** of Jan, Apr,
Jul, and Oct.

Two smaller things fell out of the same corner. A cron that may be retried must not stack two
figures for one quarter into a table with **no `UPDATE` and no `DELETE` grant** — a duplicate
there could never be cleaned up, and would sit on the public page forever as two different
answers to what our correction rate was. Hence a unique constraint on
`(window_start, window_end, methodology_version)` and an idempotent `publish()`. And the public
page computes the **live** decision on every request rather than rendering the last stored one,
because otherwise a cron nobody ran leaves the previous quarter's figure looking current —
which is how a vendor stops publishing without ever deciding to.

#### What is deferred, and named

**9.5 — the number.** It needs three contractors, a thousand calls, and five hundred matured
bookings, and no amount of engineering substitutes for any of them. The gates are what say so,
and today they say it out loud on the page.

`apps/web`'s routes and the `/published` renderer are **not tested** — the same status the
other three crons have carried since Step 7 ("eight lines of wiring apiece"). The *decision*
they render is tested exhaustively; the JSX around it is not. And the published-figure branch
of that page has never rendered against real data, because there is none.

---

## 10. Implementation reference

The detail the steps above point at.

### 10.1 Slot extraction

*Built in Step 1. This section was rewritten after the fact; the original sketch did not
survive contact with `strict` mode, and the ways it failed are the interesting part.*

`SLOT_SPECS[key].extraction` in `packages/contracts/src/slots.ts` is a `z.ZodType`. Strict tool
use takes a JSON Schema. So the tool the model is handed is **derived from the contract, not
written by hand.**

**Derive from `.extraction`, never from `.schema`.** They are different schemas on purpose.
`.schema` is the *stored fact*, after our own code has checked it: an address the geocoder
resolved, a phone number in E.164. Handing that to the model asks the model to do the
validating, and it will happily oblige with something plausible — a `formatted` address that
never existed, a country code it guessed. `.extraction` is the *narrower* shape the model is
allowed to report. Widening it hands `packages/validators` work back to the model, which is
principle #3 run in reverse.

```ts
// packages/extraction/src/tool.ts (abridged)
function toolFor(key: SlotKey) {
  const spec = SLOT_SPECS[key];
  return {
    name: `record_${key}`,
    description: `Record the caller's ${spec.label} ... Use null if this utterance
                  does not state it, or states it ambiguously.`,
    strict: true,
    input_schema: {
      type: "object",                   // strict mode requires an object root, and four
      properties: {                     // of six slot schemas are scalars
        value: nullable(strictify(zodToJsonSchema(spec.extraction))),
        confidence: { type: "number" },
      },
      required: ["value", "confidence"],
      additionalProperties: false,
    },
  };
}
```

`strictify()` earns its keep. Strict mode rejects `minLength`, `maxLength`, `pattern`,
`minimum`, `maximum`, and has **no notion of an optional key**. So it drops those keywords and
rewrites every optional property as nullable-and-required; `stripNulls()` undoes the round trip
before Zod sees the value.

**Which means `strict` guarantees the shape, and the contract guarantees the meaning.** A ZIP of
`ABCDE` satisfies `{type: "string"}` and comes straight back at you. Re-validating with the Zod
schema on the way in is not belt-and-braces — it is the only thing standing between the model
and the geocoder.

**One tool per call.** `tools: [toolFor(key)]`, `tool_choice: { type: "tool", name: "record_" +
key, disable_parallel_tool_use: true }`. The model's entire decision space is "what is the value
of this one field, or nothing." That is principle #1 enforced by the type system rather than by
a prompt — and `null` is the "or nothing", because a forced `tool_choice` leaves the model no
other way to decline.

**Confidence.** The tool schema carries a `confidence: number` alongside the value. Strict mode
strips the `0..1` bound (a numerical constraint), so the extractor clamps it.
`LOW_CONFIDENCE_THRESHOLD` (0.85) already drives the `if_low_confidence` read-back policy on
`caller_name` and `problem_description`. A self-reported confidence is a weak signal — models
state wrong things with the same confidence as right ones. Calibrate it against the eval corpus.
If it does not separate correct fills from incorrect ones, promote both slots to
`always`-confirm, accept the extra turn, and say so publicly.

#### Three API details that decide whether this is fast

**Sonnet 5 runs adaptive thinking when `thinking` is omitted.** Sonnet 4.6 ran thinking-off by
default; Sonnet 5 flipped it. An extractor that omits the field silently pays multi-second
thinking latency on every turn, and `checkBudgets()` fails with no obvious cause.

```ts
thinking: { type: "disabled" },   // NOT omitted. Omitting means adaptive on Sonnet 5.
max_tokens: 256,
```

Pin it. Assert the outgoing request body has `thinking.type === "disabled"`, or somebody will
refactor the extractor, drop the field, and add seconds to every turn of every call.

**Prompt caching is a prefix match, and `tools` render first.** One tool per slot means six cache
prefixes, not one. Pre-warm all six at worker boot with a `max_tokens: 0` request. Two
constraints, both easy to get wrong:

- `max_tokens: 0` is rejected alongside a forced `tool_choice`. Pre-warm with the tools and
  system prompt in place but **no** `tool_choice`; send `tool_choice` on real requests. Changing
  `tool_choice` invalidates only the messages tier — the tools + system cache survives.
  Implemented as `AnthropicExtractor.prewarm()`, which swallows outages: a cold cache is a cost
  problem, and boot-time warming must never take the phone line down.
- The minimum cacheable prefix is model-dependent, and a prefix below it caches silently: no
  error, just `cache_creation_input_tokens: 0`. **Verify empirically** by asserting
  `cache_read_input_tokens > 0` on the second request. **This cannot live in `npm test`** — it
  needs a live model, and the Step 1 exit criterion forbids that. It is task 5.5, in the nightly
  arm. Our prefix is a few hundred tokens against a Sonnet-tier minimum near 2k, so the honest
  status today is *we do not know whether this cache hits at all.*

What `npm test` asserts instead, and what actually catches the bug: the rendered `tools` and
`system` blocks are **byte-identical across two calls with different call ids, turn indices, and
utterances**. That is the property a `Date.now()` in the prefix breaks, and it fails offline, in
milliseconds, on the commit that introduces it — rather than a month later on a cost graph.

Never interpolate a timestamp, call ID, or the caller's name into the system prompt. Those go in
the final user turn, after the last breakpoint. A `Date.now()` in the prefix invalidates the cache
on every turn of every call, multiplies extraction cost roughly tenfold, and the only symptom is
a latency graph nobody can explain.

**English-only makes `claude-haiku-4-5` plausible.** Extraction over clean English is much easier
than over code-switched audio, and Haiku is cheaper and faster. A/B it against Sonnet 5 in the
eval harness on critical-slot accuracy, not vibes. If you do: Haiku 4.5 **rejects the `effort`
parameter** and uses the older `budget_tokens` thinking config, so a Sonnet-shaped request body
will not transfer. Keep `AnthropicExtractor` behind the `SlotExtractor` port and swap
implementations. Do not parameterize one class over both.

### 10.2 Utterance wording — generated at build time

*Built in Step 3. Revised after the fact: this section used to say `LlmUtterer` handles
read-backs, and that was principle #3 run backwards. See Step 3, surprise #3.*

The obvious design calls a model each turn to phrase "What's the service address?" naturally.
Don't.

Six slots, one locale, a handful of read-back and escalation forms. A few hundred strings, not an
open set. Generate them **offline** with `claude-opus-4-8`, review them, commit them, and let the
realtime model speak them with natural prosody.

This buys three things the naive design cannot: zero added latency in the audio path, a diffable
review surface for what the agent says to real customers, and compliance text — the AI disclosure
required in California — that is *verbatim* rather than paraphrased by a model at runtime. The
last one is not optional.

`packages/utterance/src/catalog.ts` is **pure data**. No template functions, no concatenation:
placeholders are `{business}`, `{value}`, `{phone}`, and one `fill()` resolves them. That is what
makes the human review a diff rather than a simulation.

`Utterer` stays a port. `CachedUtterer` ships and performs no I/O. `LlmUtterer` is a drafting
tool for development, and it may paraphrase **`ASK_FOR` and nothing else**:

| Effect | May a model reword it? | Why |
|---|---|---|
| `ASK_FOR` | **Yes** | The wording of "what's your name?" is not load-bearing. |
| `GREET` | No | It carries the AI disclosure. Legal text. |
| `READ_BACK` | No | It *is* the verification step. A model that "naturally" renders `1247 Calle Ocho` as `1247 SW 8th St` gets a yes to an address the caller never gave. |
| `ESCALATE` | No | Life-safety guidance, read to someone who may be standing in gas. |
| `CREATE_PENDING_BOOKING` | No | It promises an SMS to a specific number. |

`LlmUtterer` reaches a model through a local `Phraser` port. **No model SDK lives in
`packages/utterance`** — the model SDK *implementation* is `packages/extraction`'s alone.
(`packages/eval` declares `@anthropic-ai/sdk` as of Step 5.1, but only to type the client it
hands to `AnthropicExtractor` in the nightly arm; it constructs no model client of its own.)

### 10.3 New ports

The repo's convention is ports with real fakes, never mocking frameworks. Each new capability
enters through one, gets a fake in the same package, and `eval` runs against the fakes.

```ts
// packages/contracts/src/ports.ts
//   SlotExtractor + ExtractionOutcome ship as of Step 1
//   Utterer + UtteranceContext ship as of Step 3
//   Effect + EscalationAction moved here from `conversation` in Step 3 (surprise #1):
//     the Utterer port needs them, and task 4.1 generates Pydantic from them.

/** One field, one turn. Never a plan, never a sequence. */
export interface SlotExtractor {
  extract(key: SlotKey, utterance: string, ctx: ExtractionContext):
    Promise<ExtractionOutcome>;
}

export type ExtractionOutcome =
  | { readonly kind: "filled"; readonly raw: unknown; readonly confidence: number }
  /** No usable value here: unsaid, ambiguous, or rejected by the contract. */
  | { readonly kind: "absent" }
  /** Model unavailable. Distinct from `absent` — an outage is not a caller error. */
  | { readonly kind: "unavailable"; readonly reason: string };

/** Turns an Effect into words. Backed by a build-time catalog (§10.2). */
export interface Utterer {
  say(effect: Effect, ctx: UtteranceContext): Promise<string>;
}

/**
 * `GREET` is the fifth Effect, added in Step 3. GREETING requires no slots, so
 * the machine emitted nothing there, and the AI disclosure had nowhere to be
 * spoken. `nextPrompt(initialContext())` returns it: a call opens with no event.
 */

/** The voice runtime. Performs Effect[]; emits MachineEvent[]. */
export interface VoiceSession {
  perform(effects: readonly Effect[]): Promise<void>;
  onEvent(handler: (e: MachineEvent) => void): void;
}
```

The `unavailable` variant mirrors the geocoder decision in principle #3: *a geocoder outage
yields `unavailable`, not `invalid`.* An Anthropic outage must not make the machine believe the
caller said nothing — that would burn an extraction-failure retry and escalate a caller who was
perfectly clear. Route `unavailable` to a filler and one bounded retry, then `ESCALATE`.

New fakes: `FakeExtractor` (scripted per key — shipped, Step 1), `TemplateUtterer` and
`FakePhraser` (shipped, Step 3), `FakeVoiceSession` (records what it was told to say).

`TemplateUtterer` emits `[ASK_FOR caller_name]` rather than prose, deliberately: an `eval`
scenario that asserts on real customer sentences goes red the day somebody improves a comma,
and a suite that cries wolf teaches the team to ignore it.

`ExtractionContext` carries `callId` and `turnIndex`, and exists so that per-call information has
somewhere to go **other than the cached prompt prefix.** `AnthropicExtractor` reads neither; they
are for tracing. That is the point — see §10.1.

### 10.4 Binding the voice runtime to `Effect[]`

`packages/conversation/src/machine.ts:122` defines the seam. The Python LiveKit worker is the only
thing that performs effects.

| Effect | What the worker does |
|---|---|
| `GREET` | Speak `Utterer.say(...)` — the opening, the AI disclosure verbatim, the invitation. Then emit `AGENT_GREETED`. This is the *first* thing a call does, from `nextPrompt(initialContext())`. |
| `ASK_FOR` | Speak `Utterer.say(...)`. Arm the extractor for `key` on the next final transcript. |
| `READ_BACK` | Speak the value. Await yes/no. Emit `SLOT_CONFIRMED`, or a corrected `SLOT_FILLED`. |
| `ESCALATE` | `WARM_TRANSFER` → SIP REFER. `DIAL_911_GUIDANCE` → speak, then transfer. `DECLINE` → close. |
| `CREATE_PENDING_BOOKING` | POST the `PendingBooking` to the control plane. Do not wait for the CRM. |
| `SAY_FILLER` | Speak. Buys the FAQ lookup its time out loud. Content-free by construction — it is spoken *before* we know whether we have an answer. |
| `ANSWER_FAQ` | Speak the contractor's committed answer verbatim, or the catalog's callback promise when `answer` is null. |

The last two are the only effects **`transition()` never emits** (`RUNTIME_ONLY_EFFECT_TYPES`).
`CallRuntime` produces them on a turn the caller spent asking *us* something, and they change no
slot, no state, and no guard — the call resumes exactly where it was, with `nextPrompt()` re-asking
the question the caller interrupted.

The classifier runs on **every ASR partial**, in-process, before the transcript reaches a model.
`HAZARD_DETECTED` short-circuits the turn. That ordering is load-bearing, and it is why
`packages/safety` has no model dependency.

**The language boundary.** The machine is TypeScript; the worker is Python. Generate Pydantic from
the Zod contracts in CI and fail the build on drift. The alternative — a localhost HTTP sidecar
running the TS core — costs 1–3ms inside the turn budget and adds a process that can crash
independently of the worker. **Prefer codegen. Never hand-edit the generated Pydantic.**

### 10.5 Cost and latency budget

Per call, roughly 12 turns and 6 extractions:

| Item | Model | Per call | Notes |
|---|---|---|---|
| Extraction ×6 | `claude-sonnet-5` | ~1.2k in (cached), ~0.3k out | Cache read ≈ 0.1× input price |
| FAQ selection ×0–3 | `claude-sonnet-5` | ~0.4k in (cached prefix + candidates), ~0.05k out | Only on a turn the extractor found nothing in, and only above the retrieval floor — a question nothing matches costs *no* model call at all |
| Post-call summary | `claude-opus-4-8` | ~4k in, ~1k out | Off the critical path |
| Correction triage | `claude-opus-4-8` | amortized, nightly | Per *corrected* booking, not per call. Most bookings are never triaged, because most are never corrected |

The realtime model dominates cost and is priced per minute. Extraction is a rounding error
**provided the cache hits.** Put `cache_read_input_tokens` on a dashboard from day one.

`checkBudgets()` (`packages/telemetry/src/metrics.ts:110`) already blocks merges on p95 first word
> 1.2s, p95 turn > 2.0s, turn-take < 96%, barge-in > 13.5%. Extraction runs concurrently with the
realtime model's own response, so it must finish *inside* the turn, not extend it. Budget 400ms
p95; alert at 600ms.

**You cannot buy latency with silence.** The fastest model in Full-Duplex-Bench-v3 had the worst
turn-take rate. If extraction is slow, speak a filler. Do not go quiet.

### 10.6 Correction triage, and the number we are allowed to publish

*Built in Step 6. The design is a list of ways a model grading our own homework could cheat, and
what stops each one.*

The pipeline is three files. `packages/triage` asks the model; `packages/workflows/src/triage.ts`
runs the batch and owns the stores; `packages/telemetry/src/metrics.ts` decides what may be said
out loud.

```
observeOutcome()  →  BookingOutcome{correctedFields, classification: null}   ← raw, forever
runTriage()       →  ClassificationRecord{classification, rationale, ...}    ← derived, additive
auditSample()     →  HumanLabelRecord{humanLabel, auditedBy, ...}            ← the human wins
computeMetrics()  →  correctionRate (raw)  +  agentErrorRate  +  triageAgreementRate
publishedCorrectionRate()                                                    ← which one we quote
```

Five properties, and each is load-bearing:

1. **The raw diff is never written.** `TriageStore.classify` accepts the derived columns and
   nothing else, so an edit that "cleans up" a diff the classifier disagrees with does not
   compile. Same move as `OutcomeDeps.crm = Pick<CrmAdapter, "readJob">`.
2. **Null is guilt, not innocence.** `agentErrorRate` counts an unclassified correction as an agent
   error. A declined verdict, an outage, an un-run cron — each leaves the correction counting
   against us, so every failure mode of this pipeline pushes the published number *up*.
3. **A verdict needs an argument.** `interpret()` returns `declined` for a label with no rationale.
   An unauditable exoneration is precisely what this call site must not be able to produce.
4. **The model may only lower the number, and only with a licence.** `publishedCorrectionRate()`
   quotes `agentErrorRate` **only** while ≥20 corrections carry a human label and the classifier
   agrees with the auditor ≥95% of the time. Otherwise it quotes the raw rate and says why.
5. **The audit sample is hashed, not rolled.** `auditSample()` buckets on the booking id: stable
   across re-runs (a disliked week cannot be re-rolled) and assigned before the outcome existed
   (it cannot be steered toward the easy cases).

The system prompt's last paragraph is the bias correction — *"You are classifying the mistakes of
the system you are part of… That is a reason to be harder on yourself, not easier"* — and it is the
most important text in the package. A model asked whether an edit was its own fault reaches for the
exculpatory reading, and every exculpatory reading improves the number we publish.

### 10.7 FAQ retrieval — the model that selects, and does not write

*Built in Step 6.4. §6 called this "tool use + `pgvector` retrieval", which reads like RAG. It is
deliberately not RAG.*

```
caller: "do you charge for an estimate?"
  ↓ extractor returns `absent`         ← the gate: a filled slot is never spent on the FAQ
  ↓ isQuestion(text)                    ← deterministic, ours, not a model's call
  ↓ SAY_FILLER  ("Let me check that for you.")   ← spoken FIRST; the lookup runs in the silence
  ↓ embed → pgvector top-5 → drop anything below SIMILARITY_FLOOR
  ↓ nothing left?  → `unknown`, and NO model call at all
  ↓ claude-sonnet-5, forced strict tool: { entry_id: string | null }
  ↓ id we never sent?  → `unknown`
  ↓ ANSWER_FAQ  (the contractor's committed sentence, verbatim)
  ↓ nextPrompt()  → the slot they interrupted, asked again
```

The model's entire decision space is *which of these approved answers responds to this question, or
none*. It cannot write a sentence, summarise one, or blend two. The alternative — generating from
retrieved context — is a model quoting a price on a recorded line that the contractor never
approved, and it fails in the way `READ_BACK` fails when a model "naturally" renders `1247 Calle
Ocho` as `1247 SW 8th St`: fluently, plausibly, and wrongly.

`FaqOutcome` separates `unknown` (nothing we wrote covers it) from `unavailable` (we could not
ask). The caller hears the same sentence either way; a dashboard that could not tell them apart
would send us to fix the index when what we needed was to write an FAQ entry.

---

## 11. The experiment that could prove principle #1 wrong

State it before writing code, because a principle that cannot be falsified is a manifesto.

Build `AgenticArm` behind a per-tenant flag: one Anthropic tool-use loop with all four booking
tools and the freedom to plan. Run both arms over the same `packages/eval` scenarios, then over a
small live cohort.

Score on what `computeMetrics()` already returns:

| | Deterministic arm | Agentic arm |
|---|---|---|
| `containmentRate` | | |
| Critical-slot accuracy | | |
| **`correctionRate`** | | |
| `turnLatencyP95Ms` | | |
| Wrong-address commits | | |

`correctionRate` is ground truth. If the agentic arm wins on it, we ship the agentic arm and
publish the result — it would be genuinely new information about what these models can do.

The prior, from VoiceAgentBench, is that it loses badly. Priors are not data, and we will be the
only ones holding the data. That is the whole thesis.

---

## 12. The parts most likely to go wrong

Stated up front, because a plan that only describes the happy path is marketing.

**The correction classifier will flatter us.** A model asked whether a contractor's edit was our
fault has an obvious bias. The mitigations — raw diff stored unclassified forever, human-audit
agreement rate published — are load-bearing, not process theater.

**`correctionRate` will look terrible at first**, and the temptation will be to redefine it. See
principle #5's corollary. This is the failure mode that ends the company quietly.

**Latency budget is tighter than it looks.** Twilio SIP → LiveKit → model → back is ~150–250ms of
pure transport before the model thinks. The sub-1.2s first-word target has maybe 700ms of headroom.
Colocate the worker with the model provider's region, pre-warm availability during TRIAGE, and
accept a filler utterance rather than a silence.

**Prompt caching will break silently.** One `Date.now()` in a system prompt and extraction cost
multiplies ~10× with no error, only a latency graph nobody can explain. *Guarded as of Step 1:*
the suite asserts the rendered `tools` and `system` bytes are identical across calls, and
`onUsage` puts `cacheReadInputTokens` where a dashboard can see it. **Still unguarded:** whether
the prefix is large enough to cache in the first place. Task 5.5.

**Adaptive thinking will be left on by accident.** Sonnet 5 enables it when `thinking` is omitted.
Somebody will refactor the extractor, drop the field, and add seconds to every turn. *Pinned as of
Step 1* — the test asserts `thinking.type === "disabled"` on the outgoing request body, and it was
mutation-tested by deleting the field.

**Somebody will let a model reword something that must not be reworded.** The AI disclosure,
the address read-back, and the gas-leak guidance all look like prose that a language model
could improve. Each is a sentence whose *content* is load-bearing — legal text, the
verification step, and life-safety instructions. *Guarded as of Step 3:* `LlmUtterer` refuses
every effect but `ASK_FOR`, `AI_DISCLOSURE` is pinned character-for-character, and both
mutations were tested. The remaining exposure is a "tone pass" on `catalog.ts` that a reviewer
waves through — which is why the disclosure test's failure message says to fetch a lawyer.

**Somebody will "simplify" `SlotSpec.extraction` away**, noticing it equals `.schema` for four of
six slots and concluding the split is redundant. It is not. For `service_address` and
`callback_phone` it is the line between the model reporting what it heard and the model doing
`packages/validators`' job. Two tests in `contracts.test.ts` fail if you merge them.

**Codegen drift between Zod and Pydantic.** The `PendingBooking` the worker believes in diverges
from the one the backend commits. This is the most likely source of silent production bugs. Fail
CI on any diff; never hand-edit the output.

**The state machine will feel rigid to callers.** Real people volunteer the address before you ask
and change the appointment three turns later. The graph accepts **out-of-order slot fills** and
supports **backtracking** — a confirmed slot can be un-confirmed. This was built on day one rather
than retrofitted, and three tests guard the mutation that keeps a stale confirmation.

**Housecall Pro's API will not match our model.** It always does. `CrmAdapter` was designed against
*two* CRMs on paper before either was implemented, which is the only reason the interface is not a
rename of Housecall Pro's endpoints. `readJob` gets the same treatment. Do not add a method only
one adapter can implement.

**Emergency classifier false positives** are cheap; false negatives are catastrophic. Tune toward
paranoia and measure the human-transfer rate as a cost, not a bug.

**Someone will delete the Spanish hazard phrases** during an English-only cleanup pass, because
they look like dead code. They are not. See principle #4, and Step 0.5.

**Model providers will deprecate the realtime model.** Hence the provider abstraction in
`apps/agent/voice/`. Do not let GPT-Realtime's response format leak past that boundary.

---

## Start here

~~Step 0 — pivot cleanup.~~ Done 2026-07-09.
~~Step 1 — `packages/extraction`.~~ Done 2026-07-09. Read its five surprises before you touch
the extractor; #1 and #4 changed the contracts and the exit criterion respectively.
~~Step 2 — `readJob` and the outcome pipeline.~~ Done 2026-07-09. Read its five surprises before
you touch `diffBooking`; #3 is the one that would quietly corrupt the number we publish.
~~Step 3 — utterance generation.~~ Done 2026-07-09. Read surprise #3 before you touch
`LlmUtterer`: the read-back is the verification step, and a model must never rephrase it.
~~Step 4 — the `Effect[]` binding.~~ Core built 2026-07-10. `packages/runtime`'s `CallRuntime`
drives a whole call against fakes; read its seven surprises before you touch the port, and #1
first — the `VoiceSession` speaks and returns `SpeechOutcome`, it does not emit `MachineEvent`.
~~Step 5 — eval over the real path.~~ Core built 2026-07-10. `simulate.ts` now drives extraction
through the real `SlotExtractor` port (`FakeExtractor` in the PR suite, `AnthropicExtractor` in
the nightly arm); read surprise #1 — a fill now *scripts the fake*, it is not a value baked into
the scenario.

~~Step 6 — correction triage + FAQ.~~ Core built 2026-07-11. Read surprise #1 before you touch
`correctionRate`: "only `agent_error` counts against it" was the most dangerous sentence in this
plan, and it is now two numbers, because every failure mode of triage must push the published
figure *up*.
~~Step 7 — product: tenancy, the crons, billing.~~ Core built 2026-07-11. Read surprise #1
before you touch the database connection: **RLS policies do nothing when you connect as the
owner**, which is the role Neon hands you by default, and there is a passing test asserting the
bypass so that nobody mistakes the policies for the guarantee.

~~Step 8 — compliance.~~ Core built 2026-07-11. Read surprise #1 before you touch
`packages/compliance`: "keyed off the caller's area code" cannot mean what it says — number
portability makes an area code *evidence*, not a fact — so the conservative default is the
design rather than a fallback, and the map is allowed to be wrong in exactly one direction.

~~Step 9 — publish the number.~~ Core built 2026-07-12. This Step was called the one that
"cannot be *built*", and that was half wrong: everything it would *report* was already
computed, but nothing that would *publish* it existed — and publishing has hazards of its own.
Read surprise #1 before you touch `PgCohortReader`: **the published figure is the only
quantity in this system with no tenant**, so the obvious way to compute it is as the table
owner, which is the one connection with no isolation at all. And read surprise #3 before you
touch `decidePublication()`: its load-bearing property is a branch it does **not** have.

1. **The number itself — task 9.5.** ← you are here, and it is not an engineering task. It
   needs three contractors, a thousand calls, and five hundred matured bookings. The mechanism
   is built, tested against a real Postgres, and today it **refuses to publish** and says why,
   which is the correct answer and will keep being the correct answer until somebody sells
   this to a plumber.
2. **The two signatures and the credentialed tails.** **8.7 — a lawyer reads the disclosure,
   `docs/COMPLIANCE.md`, and `docs/DPA.md`** — the only item in this plan that neither a
   credential nor a test can supply, and it gates revenue. Then: 4.2 (Twilio → SIP → LiveKit),
   4.6 (GPT-Realtime), 4.10 (live Housecall Pro sandbox), 5.2 (LLM caller personas), 5.3
   (real-SIP barge-in/turn-take), 5.5 (the live prompt-cache measurement), 6.5 (the human
   audit's agreement rate), 6.6 (a real embedder), 7.5 (Housecall Pro OAuth), 7.6 (Clerk), 7.7
   (a live Neon), 8.6 (the live carrier deletion — and the deployment check that the carrier's
   own recording switch is off). Each is built to the port and waiting for a key.

The uncertain parts are retired: the model integration (Step 1), the wedge computation (Step 2),
the committed catalog (Step 3), the whole conversational control loop (Step 4's core), the
extraction seam under the eval (Step 5's core), the triage pipeline and its publication rule
(Step 6's core), tenant isolation — proven against a real Postgres rather than argued (Step 7's
core), the compliance rules, which are now code that cannot be violated rather than a page
somebody could be found to have breached (Step 8's core), and the publication mechanism, which
cannot be made to withhold a number for being bad (Step 9's core). What is left is plumbing to
hardware and credentials, a lawyer, and a contractor — not risk.

**Before you finish any step:** update the progress board at the top of this file and the
step's own heading, in the same commit as the code. If you changed a boundary or a principle,
`CLAUDE.md` too. That file's opening rule applies here: a stale plan teaches the next reader
something false.
