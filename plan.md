# Ledgerline — Implementation Plan

**The single source of truth for what we are building, why, and how.**

- [`idea.md`](./idea.md) — the upstream research. **Deliberately not revised** to match later decisions; it is the evidence record, and §2.2's multilingual capability gap is real whether or not we build on it.
- [`CLAUDE.md`](./CLAUDE.md) — what exists today, and the conventions for changing it.
- This file — the plan. Sections 1–5 are *why*. Sections 6–8 are *what*. Section 9 is *how, step by step*. Section 10 is the implementation reference the steps point at.

---

## Current status (verified 2026-07-09, after Step 2)

The domain core is built and green. Everything below was re-run, not copied from a previous claim.

| Check | Result |
|---|---|
| `npm test` | **526 passed**, 13 files |
| `npm run typecheck` | clean |
| `npm run test:coverage` | **98.99%** lines (thresholds: 90/90/85/90) |
| `cd apps/web && npm run build` | builds, 3 routes |

**Built.** `contracts`, `conversation` (SlotBook + the seven-state machine), `safety`
(deterministic classifier, labeled corpus, `recall === 1.0`), `validators`, `extraction`
(the Anthropic slot extractor behind the `SlotExtractor` port), `crm`
(Housecall Pro + Jobber behind one contract suite, now including `readJob`), `workflows`
(saga + compensating rollback + the outcome poller), `telemetry`
(Full-Duplex-Bench-comparable definitions + CI budgets), `db` (Drizzle schema + the initial
migration), `eval` (simulated callers), `apps/web` (dashboard).

**Not built.** No telephony, no realtime model, no auth, no billing, no compliance work.
`AnthropicExtractor` exists but has never spoken to a live model — it is tested entirely
against committed fixtures, and `packages/eval/src/simulate.ts` still binds its own inline
stub rather than the real extractor (Step 5.1). The `db` schema has never been applied to a
Postgres: `drizzle-kit generate` needs no database and `migrate` does, and no Neon instance
exists (Step 7). **`observeOutcome()` now produces the `BookingOutcome[]` that
`computeMetrics()` consumes, but it has only ever read a `FakeTransport`** — no live
Housecall Pro sandbox has been polled (task 4.10).

### Progress board

The build order is §9. **Finishing a step means updating this table and the step's own
heading in the same commit.** A plan that lags the code is worse than no plan — the next
person to open this file will trust it, and be wrong.

| Step | What | Status |
|---|---|---|
| 0 | Pivot cleanup | ✅ **Done** — 2026-07-09 |
| 1 | `packages/extraction` — the LLM slot extractor | ✅ **Done** — 2026-07-09 |
| 2 | `CrmAdapter.readJob` + the outcome pipeline | ✅ **Done** — 2026-07-09 |
| 3 | Utterance generation (build time) | ⬜ Not started ← **next** |
| 4 | `apps/agent` — one live call | ⬜ Not started |
| 5 | Eval over the real path | ⬜ Not started |
| 6 | Correction triage + FAQ | ⬜ Not started |
| 7 | Product — auth, tenancy, onboarding, billing | ⬜ Not started |
| 8 | Compliance | ⬜ Not started |
| 9 | Publish the number | ⬜ Not started |

Not on the critical path, and unresolved: the `AgenticArm` A/B (§11), and
`claude-haiku-4-5` vs `claude-sonnet-5` for extraction, scored on critical-slot accuracy.

**Three questions no step so far could settle without a credential.** Steps 1 and 2 each
built the real code against the real interface and hand-authored the fixtures, because no
vendor account existed. Named so they cannot be quietly forgotten:

- Whether the prompt-cache prefix is large enough to cache at all (§10.1) — **task 5.5**.
- Whether the committed extraction fixtures match what `claude-sonnet-5` actually emits —
  **task 5.5**.
- Whether Housecall Pro's `work_status` and Jobber's `jobStatus` carry the values `readJob`
  maps, and whether a deleted job really answers `404` / `data.job: null` — **task 4.10**.

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
│   ├── web/                    Next.js — dashboard, onboarding, Twilio webhooks
│   └── agent/                  Python — LiveKit agent worker (the call runtime)   [Step 4]
├── packages/
│   ├── contracts/              Zod schemas → JSON Schema → Pydantic (codegen)
│   ├── conversation/           SlotBook + state machine. Pure, no I/O.
│   ├── safety/                 Emergency classifier (no LLM dependency)
│   ├── validators/             Phone, address, service area, business hours
│   ├── extraction/             LLM slot extractor behind SlotExtractor port        ✅
│   ├── crm/                    CrmAdapter + Housecall Pro + Jobber + readJob       ✅
│   ├── workflows/              Saga + booking transaction + outcome poller         ✅
│   ├── telemetry/              Reliability metrics + latency budgets
│   ├── db/                     Drizzle schema + migrations (Neon)                  ✅
│   └── eval/                   Simulated-caller harness + scoring
└── plan.md, idea.md, CLAUDE.md
```

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
| 3 | FAQ / knowledge answers | `claude-sonnet-5` | Tool use + `pgvector` retrieval | No — behind a filler utterance | "Let me have someone call you back on that" |
| 4 | Post-call summary and job notes | `claude-opus-4-8` | Structured output, adaptive thinking | No — after hangup | Booking still commits; notes marked `unsummarized` |
| 5 | Correction triage | `claude-opus-4-8` | Structured output, nightly batch | No | Raw diff still recorded, uncategorized |
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
                  classification(enum), classified_by, human_label(nullable)
escalations       call_id, reason(enum), triggered_at, transferred_to, human_ack_at
```

Four columns make principles #3 and #5 real, and without them we are asserting reliability
instead of measuring it:

- `slots.confirmed_by_caller` — the read-back actually happened.
- `outcomes.corrected_fields` — ground truth. The raw diff.
- `outcomes.classification` — was the edit *our* error, a business change, or an enrichment?
  Written by a nightly model pass. **Never destructive**; the raw diff is retained forever and
  anyone can recount.
- `outcomes.human_label` — a weekly 10% audit. We report the model's agreement with the human
  *alongside* the correction rate. An unaudited classifier grading our own homework is
  marketing with extra steps.

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

### Step 3 — Utterance generation (2 days)

| # | Task | Detail |
|---|---|---|
| 3.1 | Add the `Utterer` port | §10.3. |
| 3.2 | Generate the string set offline with `claude-opus-4-8` | Six slots × ask/read-back forms, escalation forms, the AI disclosure. |
| 3.3 | Review and **commit** them | A human reads every line the agent will say to a customer. |
| 3.4 | `CachedUtterer` (ships) + `LlmUtterer` (dev) | §10.2. |

**Exit:** the AI disclosure is a committed, reviewed, verbatim string — not a runtime
paraphrase. This is a compliance requirement, not a preference.

---

### Step 4 — `apps/agent`: one live call (2–3 weeks)

Now the hardware. Everything above is already tested.

| # | Task | Detail |
|---|---|---|
| 4.1 | Zod → Pydantic codegen in CI | `zod-to-json-schema` → `datamodel-code-generator`. Fail the build on drift. Never hand-edit output. |
| 4.2 | Twilio number → SIP trunk → LiveKit room | Worker joins. |
| 4.3 | `VoiceSession` port + `FakeVoiceSession` | Prove the `Effect[]` binding in CI before touching audio. |
| 4.4 | Bind `Effect[]` → worker | §10.4. |
| 4.5 | Classifier on **every ASR partial**, in-process | Before the transcript reaches any model. `HAZARD_DETECTED` short-circuits the turn. |
| 4.6 | GPT-Realtime behind `apps/agent/voice/` | Its response format must not leak past that boundary. |
| 4.7 | Google Address Validation behind the existing `Geocoder` port | |
| 4.8 | Hangup → `PendingBooking` → WDK workflow → Housecall Pro job → Twilio SMS | `commitBooking()` does not change. |
| 4.9 | Telemetry: every turn traced | |
| 4.10 | **Verify `readJob` against a live Housecall Pro sandbox** | The Step 2 exit criterion, with a real credential. Book a job, edit its address by hand, poll it, assert `correctionRate`. Confirm `work_status` and `jobStatus` really carry the values the adapters map, and that a deleted job really answers `404` / `data.job: null`. Both vocabularies are transcribed from docs, not observed. |

**Exit criteria — the first live-call gate.** 20 consecutive scripted-but-live calls from real phones.
≥18 book a correct job. **Zero wrong addresses committed.** p95 first-word latency < 1.2s, p95
turn latency < 2.0s. `checkBudgets()` green. Emergency phrase transfers within one turn, 10/10.
And `computeMetrics()` reports a real `correctionRate` from those 20 calls.

---

### Step 5 — Eval over the real path (1.5 weeks, overlaps Step 4)

| # | Task | Detail |
|---|---|---|
| 5.1 | Replace the extractor stub in `simulate.ts` | Bind `FakeExtractor` for the PR suite; `AnthropicExtractor` in the nightly arm. |
| 5.2 | LLM-driven caller personas | `claude-opus-4-8`. Impatient, heavy accent, background TV, gives the address wrong the first time, interrupts constantly, changes their mind mid-utterance. |
| 5.3 | Real-SIP arm, nightly | Only over SIP are barge-in and turn-take comparable to Full-Duplex-Bench-v3, which is the entire point of defining them that way. |
| 5.4 | Turn-take regression blocks a merge | This is the discipline that keeps principle #2 from eroding as we optimize for speed. |
| 5.5 | **Measure the prompt cache against a live model, before quoting §10.5** | Re-record the Step 1 fixtures. Assert `cache_read_input_tokens > 0` on the second request — in the nightly arm, never the PR suite. If the prefix is below the model's minimum cacheable size it caches *silently*, with no error, and §10.5's cost model is wrong by ~10×. Pad the system prompt, or accept an uncached prefix and say so. See Step 1, surprise #4. |

Existing scenarios keep running against fakes — fast, deterministic, gating every PR.

---

### Step 6 — Correction triage + FAQ (1 week)

| # | Task | Detail |
|---|---|---|
| 6.1 | Nightly `claude-opus-4-8` pass | Classify each diff: `agent_error \| business_change \| enrichment`. Only `agent_error` counts against `correctionRate`. |
| 6.2 | Raw diff stored unclassified, forever | Classification is a derived column, never a destructive write. |
| 6.3 | Weekly 10% human audit → `outcomes.human_label` | Publish the agreement rate *alongside* the correction rate. |
| 6.4 | FAQ retrieval (`pgvector`) behind a filler utterance | Call site #3. Never blocks the audio path. |

**If model and human disagree more than ~5% of the time, publish the raw correction rate and
drop the classifier until it earns its place.** A model asked whether a contractor's edit was
our own fault has an obvious bias.

---

### Step 7 — Product (3–4 weeks)

Clerk auth. Tenant isolation via Postgres RLS. Per-tenant number provisioning. Onboarding:
connect Housecall Pro (OAuth), draw the service area, set hours, define job types, record a
custom greeting. Dashboard: live calls, transcripts with audio scrub, bookings, escalations,
**and the reliability numbers as the pitch, not a tab.** Billing per booked job rather than per
minute — align our incentive with theirs. Jobber and ServiceTitan through the existing contract
suite.

---

### Step 8 — Compliance (parallel with Step 7, gates launch, not code)

AI disclosure at call start, spoken **verbatim** from the string committed in Step 3.
Two-party-consent recording by state, keyed off the caller's area code with a conservative
default. TCPA constraints if we ever do outbound (we should not, initially). PCI scope avoided
entirely by never taking payment on the call. Recording retention and deletion policy. A
per-tenant DPA.

---

### Step 9 — Publish the number

Write up `correctionRate` across N tenants and M thousand calls, with the methodology and the
human-audit agreement rate. `idea.md` §7 says nobody has this. Being first to publish it *is*
the marketing — and it only works if the disciplines in §7 held.

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

The obvious design calls a model each turn to phrase "What's the service address?" naturally.
Don't.

Six slots, one locale, a handful of read-back and escalation forms. A few hundred strings, not an
open set. Generate them **offline** with `claude-opus-4-8`, review them, commit them, and let the
realtime model speak them with natural prosody.

This buys three things the naive design cannot: zero added latency in the audio path, a diffable
review surface for what the agent says to real customers, and compliance text — the AI disclosure
required in California — that is *verbatim* rather than paraphrased by a model at runtime. The
last one is not optional.

`Utterer` stays a port. `LlmUtterer` exists for development and for read-back phrasings that
interpolate a value; `CachedUtterer` is what ships.

### 10.3 New ports

The repo's convention is ports with real fakes, never mocking frameworks. Each new capability
enters through one, gets a fake in the same package, and `eval` runs against the fakes.

```ts
// packages/contracts/src/ports.ts  — SlotExtractor and ExtractionOutcome ship as of Step 1

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

/** Turns an Effect into words. Backed by a build-time cache (§10.2). */
export interface Utterer {
  say(effect: Effect, ctx: UtteranceContext): Promise<string>;
}

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

New fakes: `FakeExtractor` (scripted per key — shipped, Step 1), `TemplateUtterer`,
`FakeVoiceSession` (records what it was told to say).

`ExtractionContext` carries `callId` and `turnIndex`, and exists so that per-call information has
somewhere to go **other than the cached prompt prefix.** `AnthropicExtractor` reads neither; they
are for tracing. That is the point — see §10.1.

### 10.4 Binding the voice runtime to `Effect[]`

`packages/conversation/src/machine.ts:122` defines the seam. The Python LiveKit worker is the only
thing that performs effects.

| Effect | What the worker does |
|---|---|
| `ASK_FOR` | Speak `Utterer.say(...)`. Arm the extractor for `key` on the next final transcript. |
| `READ_BACK` | Speak the value. Await yes/no. Emit `SLOT_CONFIRMED`, or a corrected `SLOT_FILLED`. |
| `ESCALATE` | `WARM_TRANSFER` → SIP REFER. `DIAL_911_GUIDANCE` → speak, then transfer. `DECLINE` → close. |
| `CREATE_PENDING_BOOKING` | POST the `PendingBooking` to the control plane. Do not wait for the CRM. |

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
| Post-call summary | `claude-opus-4-8` | ~4k in, ~1k out | Off the critical path |
| Correction triage | `claude-opus-4-8` | amortized, nightly | Per booking, not per call |

The realtime model dominates cost and is priced per minute. Extraction is a rounding error
**provided the cache hits.** Put `cache_read_input_tokens` on a dashboard from day one.

`checkBudgets()` (`packages/telemetry/src/metrics.ts:110`) already blocks merges on p95 first word
> 1.2s, p95 turn > 2.0s, turn-take < 96%, barge-in > 13.5%. Extraction runs concurrently with the
realtime model's own response, so it must finish *inside* the turn, not extend it. Budget 400ms
p95; alert at 600ms.

**You cannot buy latency with silence.** The fastest model in Full-Duplex-Bench-v3 had the worst
turn-take rate. If extraction is slow, speak a filler. Do not go quiet.

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

1. **Step 3 — utterance generation.** ← you are here. Two days, and the AI disclosure it commits
   is a compliance requirement rather than a preference.
2. **Step 4 — telephony.** Don't forget task 4.10: it closes Step 2's exit criterion against a
   real credential.

Do not start with telephony. It is the most visible part and the least uncertain.

**Before you finish any step:** update the progress board at the top of this file and the
step's own heading, in the same commit as the code. If you changed a boundary or a principle,
`CLAUDE.md` too. That file's opening rule applies here: a stale plan teaches the next reader
something false.
