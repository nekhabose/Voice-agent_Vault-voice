# Ledgerline — Implementation Plan

**Idea #3 from `idea.md`:** Vertical inbound-call agent for the home/field-services economy.

---

## Context

`idea.md` establishes two things that, taken together, define this product.

First, **demand is proven.** Avoca raised $125M+ at a $1B valuation with 800+ home-services customers doing exactly this: answering inbound calls, qualifying callers, booking jobs, syncing to CRM. Contractors will pay for it. We do not need to validate that a voice agent answering the phone for an HVAC shop is a business.

Second, **the technology is not ready for the general case.** The best ASR→LLM pipeline fills tool-call parameters correctly only ~60.6% of the time in English, and *sequential* multi-step workflows collapse to 5–15% (VoiceAgentBench). Multilingual drops that 60.6% to ~39.2%. Latency and barge-in trade against each other badly (Full-Duplex-Bench-v3). Anyone building an open-ended conversational agent walks into this wall.

The synthesis, and the thesis of this plan: **a missed call at a plumbing shop is a lost job worth hundreds of dollars, and the conversation needed to capture it is bounded.** Name, address, problem, urgency, time window. That is a form with five fields and a decision tree, not an open-ended dialogue. We can build something that works *today* on models that fail the general benchmark, because we never ask the model to do the thing it fails at.

The engineering goal is therefore not "make the LLM smarter." It is **to make the surface the LLM must be correct on as small as possible**, and to verify every consequential action before it commits.

### The wedge

Avoca serves English-speaking US trades. We commit to **multilingual US metro trades** — a Spanish-first (then Hindi, Tagalog, Vietnamese) inbound agent for the immigrant-owned and immigrant-serving contractor market.

This is chosen deliberately, not for novelty. It stacks idea #3's proven demand on top of idea.md §2.2's measured capability gap. That gap is our moat: it is *hard*, incumbents have not solved it, and a US-metro contractor whose customers call in Spanish is currently choosing between a bilingual receptionist they can't afford and voicemail. Code-switching mid-call ("Hola, uh, my water heater está leaking") is the normal case, not the edge case, and it is the specific thing off-the-shelf agents handle worst.

Caveat, stated honestly: `idea.md` §7 open question #2 flags that accent and code-switching robustness is *not directly evidenced* by the research. Phase 0 below exists to kill this wedge cheaply if it doesn't hold.

### What success looks like at the end of this plan

A real phone number rings. A Spanish-speaking homeowner describes a leaking water heater. Ninety seconds later there is a real job on a real contractor's Housecall Pro calendar, an SMS confirmation in Spanish on the homeowner's phone, and a transcript the contractor can read in English. No human touched it. And we have a number — measured, not asserted — for how often that works.

---

## Architectural principles

These are the decisions everything else follows from. Each one is a direct response to a specific finding in `idea.md`.

### 1. Never let the model chain tool calls. (§2.1)

Sequential tool-calling collapses to single digits. So the agent never plans a sequence. Instead, the conversation is a **state machine** with a small number of states, and in each state the model is given **exactly one tool** it is allowed to call — usually one that just records a fact.

```
GREETING → IDENTIFY → TRIAGE → QUALIFY → SCHEDULE → CONFIRM → CLOSE
                         ↓
                     EMERGENCY → HANDOFF
```

The model's job per turn is: *given this state, extract this one field, or ask for it.* Advancing the state is done by **our code**, on a validated slot, not by the model deciding it's time to move on. The actual booking — the multi-step `lookup_customer → check_availability → create_job → send_sms` chain that benchmarks show models cannot do — happens **after the call is scored and gated**, in a deterministic backend workflow with retries and rollback. The LLM never orchestrates it.

This is the single most important idea in the document. We convert a 14.8%-reliable agentic task into a 5-field extraction task plus a deterministic transaction.

### 2. Two-tier latency, and never sacrifice turn-taking for it. (§2.3, §2.4)

The fastest model in the benchmark (Gemini Live) had the *worst* turn-take rate — 22 of 100 scenarios got no response at all. Speed that produces silence is not speed. GPT-Realtime's balance (96% turn-take, 13.5% interruption) is the target profile.

Architecturally: a **realtime speech-to-speech model handles the conversational surface** (listening, backchanneling, barge-in, sub-second first-word latency), while **anything requiring correctness runs on a slower, cheaper text model out-of-band** — behind a filler utterance ("Let me check that for you, un momento"). Never block the audio path on a network call. Availability lookups are pre-warmed and cached before the caller reaches SCHEDULE.

Turn-taking gets an explicit **semantic endpointing** layer: we do not fire on VAD silence alone. A caller reciting an address pauses mid-utterance. We hold.

### 3. Every consequential action is verified before it commits. (§2.5)

Hallucination rates were 5–30% in early 2025 and models state wrong things with the same confidence as right ones. A hallucinated address books a truck roll to the wrong house — a real, expensive, trust-destroying failure.

So: **critical slots are read back to the caller and confirmed** before they enter the system (address, phone, appointment window — always; name and problem — if confidence is low). Addresses are validated against a geocoder, not trusted from the transcript. And nothing is written to the contractor's CRM from inside the call — the call produces a `PendingBooking`, and a post-call workflow commits it.

### 4. The safety tail-risk gets a hard escape hatch. (§5)

`idea.md` §5's recommended lens requires "a red-flag → human-handoff path." Ours: a **rules-based emergency classifier runs on every ASR partial**, in parallel with and independent of the LLM. Gas smell, carbon monoxide, flooding, sparking, no heat below freezing, anything mentioning a child or elderly person plus a hazard — these bypass the state machine entirely and warm-transfer to the on-call human, or dial 911 guidance, within one turn. This classifier is deterministic keyword+embedding matching. It does not ask an LLM for permission.

### 5. Measure from day one, in production. (§7 open question #1)

`idea.md`'s single biggest open question is that no field-deployment reliability numbers exist. We will have them. Every call emits a structured trace: per-turn latency percentiles, barge-in events, turn-take failures, slot-extraction confidence, containment (did it book without a human), and — the ground-truth metric — **whether the booked job was later cancelled or corrected by the contractor.** That last one is the only number that matters and nobody publishes it.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Telephony | **Twilio** (Elastic SIP Trunking + Programmable Voice) | Number provisioning, SMS, and SIP in one vendor. Media Streams as fallback path. |
| Voice orchestration | **LiveKit Agents (Python)** | Owns the audio loop, VAD, barge-in, and turn detection. We need to *tune* turn-taking (§2.4) — a managed platform (Vapi/Retell) rents us the exact layer that is broken, and we could not differentiate on the thing we claim as our moat. |
| Realtime conversation | **GPT-Realtime** (primary) | Best measured turn-take/interruption balance in Full-Duplex-Bench-v3. Provider-abstracted behind an interface; Gemini Live as A/B arm. |
| Slot extraction / validation | **Claude Sonnet 5** (text, out-of-band) | Structured output with a strict JSON schema, per-slot. Cheap, fast, verifiable, and not in the audio path. |
| Emergency classifier | Deterministic keyword + local embedding model | Must not depend on an LLM being available or willing. Runs on ASR partials. |
| Control plane | **Next.js 16 (App Router) on Vercel** | Contractor dashboard, onboarding, webhooks, admin. |
| Backend / workflows | **Vercel Workflow (WDK)** for the post-call booking transaction | Durable, crash-safe, step-based with retries — exactly the "verification, retries, state rollback" middleware §2.1 calls for. Rollback is a compensating step, not a prayer. |
| Database | **Neon Postgres** (Vercel Marketplace) | Multi-tenant with row-level security. `pgvector` for the FAQ/knowledge retrieval. |
| Cache / state | **Upstash Redis** | Live call state, pre-warmed availability, rate limiting. |
| CRM integration | **Housecall Pro** first, adapter interface behind it | Best-documented API in the segment; Jobber and ServiceTitan follow the same adapter. |
| Recordings / transcripts | **Vercel Blob** (private) | Retention policy enforced at write time. |
| Eval harness | Custom, in-repo (`packages/eval`) | See Phase 4. Non-negotiable; it is how we answer §7. |

**Language split.** The agent worker is Python (LiveKit Agents' Python SDK is where the ecosystem lives — turn detection models, VAD, plugins). Everything else is TypeScript. The two talk over a typed HTTP boundary with schemas generated from a single source of truth, so the split costs us one codegen step and nothing else.

---

## Repository layout

```
ledgerline/
├── apps/
│   ├── web/                    Next.js 16 — dashboard, onboarding, Twilio webhooks
│   └── agent/                  Python — LiveKit agent worker (the call runtime)
│       ├── graph/              state machine: states, transitions, guards
│       ├── slots/              per-slot extractors + validators
│       ├── safety/             emergency classifier (no LLM dependency)
│       ├── voice/              provider abstraction (GPT-Realtime | Gemini Live)
│       └── telemetry/          per-turn trace emission
├── packages/
│   ├── db/                     Drizzle schema + migrations (Neon)
│   ├── contracts/              Zod schemas → JSON Schema → Python Pydantic (codegen)
│   ├── crm/                    CRM adapter interface + Housecall Pro impl
│   ├── workflows/              Vercel WDK — post-call booking transaction
│   └── eval/                   simulated-caller harness + scoring
└── plan.md, idea.md
```

`packages/contracts` is load-bearing. The slot schemas, the state-machine definition, and the `PendingBooking` shape are defined **once** in Zod and compiled to Pydantic for the Python worker. Drift between the agent's idea of a booking and the backend's idea of a booking is the most likely source of silent production bugs, and this eliminates it structurally.

---

## Data model (essential tables)

```
tenants          id, name, timezone, locale_default, trade, crm_provider, crm_credentials(enc)
phone_numbers    id, tenant_id, e164, twilio_sid
service_areas    tenant_id, geojson_polygon        -- for "do we even serve this address"
business_hours   tenant_id, dow, open, close, emergency_after_hours(bool)
job_types        tenant_id, name, duration_minutes, requires_photo, emergency_eligible
calls            id, tenant_id, from_e164, started_at, ended_at, locale_detected[],
                 outcome(enum), containment(bool), recording_url, transcript_url
call_turns       call_id, idx, role, text, latency_ms, barge_in(bool), turn_take_ok(bool)
slots            call_id, key, value, confidence, confirmed_by_caller(bool), validator_result
pending_bookings call_id, tenant_id, payload(jsonb), status(enum), workflow_run_id
bookings         pending_booking_id, crm_job_id, crm_customer_id, committed_at
escalations      call_id, reason(enum), triggered_at, transferred_to, human_ack_at
outcomes         booking_id, cancelled(bool), corrected_fields(jsonb), source
```

`slots.confirmed_by_caller` and `outcomes.corrected_fields` are the two columns that make principle #3 and principle #5 real. Without them we are asserting reliability instead of measuring it.

---

## Phased delivery

### Phase 0 — Kill the wedge cheaply (3–5 days, before writing product code)

`idea.md` §7 says code-switching robustness is unevidenced. So we evidence it, before we build on it.

Assemble ~150 real-ish audio samples of Spanish/English code-switched home-services calls (record volunteers, use the Miami-English and Bangor Spanish-English code-switching corpora, augment with call-center background noise at realistic SNR). Run them through GPT-Realtime, Gemini Live, and a Whisper-large→Claude cascade. Measure: word error rate on the five critical slots — **not overall WER, which is a vanity metric.** Getting `1247 Calle Ocho` right matters; getting `um` right does not.

**Gate:** if critical-slot accuracy on code-switched audio is below ~85% for the best configuration, the multilingual wedge is not buildable yet and we fall back to the *underserved-trade* wedge (same architecture, English-only, pick pest control or appliance repair). This decision costs us one week now instead of one quarter later.

Deliverable: a short memo with the numbers, and a decision.

### Phase 1 — One call, end to end (2–3 weeks)

The vertical slice. No dashboard, no multi-tenancy, no auth. A hardcoded tenant in a seed file.

- Twilio number → SIP trunk → LiveKit room → Python agent worker joins.
- State machine with the seven states, English only, GPT-Realtime.
- Slot extraction per state with strict JSON schema; address validated against Google Address Validation API and read back to the caller.
- Emergency classifier wired to a hard transfer to a hardcoded cell number.
- Call ends → `PendingBooking` row → Vercel WDK workflow → Housecall Pro job created → Twilio SMS confirmation.
- Telemetry: every turn traced.

**Exit criteria:** 20 consecutive scripted-but-live calls from real phones. ≥18 book a correct job. Zero wrong addresses committed. p95 first-word latency under 1.2s, p95 turn latency under 2.0s. Emergency phrase transfers within one turn, 10/10.

### Phase 2 — The eval harness (1.5 weeks, overlaps Phase 1)

This is idea #4 from `idea.md` built as internal infrastructure. It is not a side quest — it is what lets Phase 3 move fast without regressing.

`packages/eval` runs **simulated callers**: an LLM-driven persona (impatient, accented, code-switching, background TV, gives address wrong the first time, interrupts constantly, changes their mind mid-utterance) dialing our agent over a real SIP path, scored against a rubric. Scenarios are YAML. It runs in CI on every agent change and produces:

- containment rate, slot accuracy, correction rate
- **barge-in and turn-take rates measured the way Full-Duplex-Bench-v3 measures them**, so our numbers are comparable to the literature
- latency distribution, not just the mean

A regression in turn-take rate blocks a merge. This is the discipline that keeps principle #2 from silently eroding as we optimize for speed.

### Phase 3 — Multilingual, and the wedge proper (3 weeks)

- Locale detection on the first utterance; agent adopts the caller's language and **holds it through code-switching** rather than flip-flopping.
- Spanish-native prompt and voice (not a translated English prompt — the pragmatics of Spanish-language service calls differ, and translated prompts produce agents that sound like forms).
- Slot extractors handle Spanish addresses, Spanish-language urgency vocabulary, and the code-switched middle.
- Transcripts stored bilingually: caller's language verbatim + English translation for the contractor.
- SMS confirmation in caller's language.
- Eval scenarios extended with the Phase 0 corpus.

**Exit criteria:** critical-slot accuracy on code-switched eval scenarios within 5 points of English. Contractor-visible artifacts (job notes, SMS) correct in both languages.

### Phase 4 — Make it a product (3–4 weeks)

- Multi-tenant: Clerk auth, tenant isolation via Postgres RLS, per-tenant number provisioning.
- Onboarding flow: connect Housecall Pro (OAuth), draw service area, set hours, define job types, record a custom greeting.
- Dashboard: live calls, transcripts with audio scrub, bookings, escalations, **and the reliability numbers** — containment, correction rate, missed-call recovery — shown to the contractor as the value proof.
- Billing (per-booked-job, not per-minute — align our incentive with theirs).
- CRM adapters: Jobber, ServiceTitan.

### Phase 5 — Compliance (parallel from Phase 4, gating launch)

`idea.md` §7 open question #4 flags this as unexplored. It gates revenue, not code.

AI-disclosure at call start (required in CA, and increasingly elsewhere); two-party consent recording by state, keyed off the caller's area code with a conservative default; TCPA constraints if we ever do outbound (we should not, initially); PCI scope avoided entirely by never taking payment on the call; recording retention and deletion policy; a per-tenant DPA.

---

## The parts most likely to go wrong

Stated up front, because a plan that only describes the happy path is marketing.

**Latency budget is tighter than it looks.** Twilio SIP → LiveKit → model → back is ~150–250ms of pure transport before the model thinks. Our sub-1.2s first-word target has maybe 700ms of headroom. Mitigation: colocate the LiveKit worker with the model provider's region, pre-warm availability lookups during TRIAGE so SCHEDULE never blocks, and accept a filler utterance rather than a silence when we must wait.

**The state machine will feel rigid to callers.** Real people volunteer the address before you ask and change the appointment time three turns later. The graph must accept **out-of-order slot fills** (extract any slot from any turn, advance when the *required set* is satisfied) and support **backtracking** (a confirmed slot can be un-confirmed). If we build a strict linear flow it will sound like a phone tree and the product dies. This is the highest-risk design detail in the plan and it should be built for on day one, not retrofitted.

**Housecall Pro's API will not match our model.** It always does. The adapter interface must be designed against *two* CRMs on paper before we implement one, or the interface will just be a rename of Housecall Pro's endpoints.

**Emergency classifier false positives** are cheap (an annoyed human picks up); false negatives are catastrophic. Tune the threshold toward paranoia and measure the human-transfer rate as a cost, not a bug.

**Model providers will deprecate the realtime model.** Hence the provider abstraction in `apps/agent/voice/`. Do not let GPT-Realtime's response format leak past that boundary.

---

## Verification

Reliability claims in this space are mostly unfalsifiable marketing. Ours will not be.

1. **Unit** — state-machine transitions, slot validators, emergency classifier (a labeled corpus of hazard/non-hazard utterances, precision and recall reported per release).
2. **Integration** — `packages/workflows` booking transaction against a Housecall Pro sandbox, including the rollback path: force a failure at `create_job` after `create_customer` succeeds and assert the compensating step runs and the customer is not orphaned.
3. **Conversational** — `packages/eval` simulated callers over real SIP, in CI, blocking merges on regression. Scored on containment, slot accuracy, latency percentiles, barge-in rate, turn-take rate.
4. **Live** — a staging number that anyone on the team can dial. Twenty-call acceptance runs at each phase gate, from real cell phones, on real cellular audio, including one from a moving car.
5. **Ground truth** — `outcomes.corrected_fields`. Every booking the contractor edits or cancels is a labeled failure. This closes the loop that `idea.md` §7 open question #1 says nobody has closed, and it is the number we should eventually publish.

---

## First two actions on approval

1. Run **Phase 0**. Do not write product code until the wedge survives it, or is consciously exchanged for the English-only trade wedge.
2. Scaffold the monorepo and `packages/contracts` — the schema is the spine, and everything else is built against it.
