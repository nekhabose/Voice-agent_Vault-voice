# Compliance

> **No lawyer has read this document, or the disclosure it pins.** That signature is task
> **8.7**, and it is the only part of Step 8 that a credential cannot buy and code cannot
> replace. Everything below is engineering's best reading of the law, enforced by code that
> counsel can check against this page line by line — which is the point of writing it this
> way, and is not the same thing as advice.

Ledgerline answers a stranger's phone call, records their voice, holds their address, and
tells a contractor where to send a truck. Six rules govern that, `plan.md` Step 8 names
them, and each one is a mechanism rather than a paragraph. Where they are enforced:

| Rule | Enforced by | Fails how |
|---|---|---|
| AI disclosure, verbatim, before the conversation | `compliance/disclosure.ts`; the `greeting_delivered` guard; `LlmUtterer` refuses to paraphrase it | `auditDisclosure()` names the calls, and its only passing rate is `1.0` |
| Consent to record | `compliance/consent.ts` + `recordingDecision()`; `CallRuntime` starts the tape | An unknown area code is all-party. There is no branch where ignorance permits a recording |
| No outbound (TCPA) | `TransactionalSms`, a branded type | A text to a number no caller gave us does not compile |
| No cardholder data (PCI) | `redactPan()`, in `CallRuntime.hear` / `hearPartial` | The card never reaches the model, the database, or the CRM |
| Retention and deletion | `RECORDING_RETENTION_DAYS` / `TRANSCRIPT_RETENTION_DAYS`; `runRetention()`; the `/api/cron/retention` route | A failed deletion is *counted*, not tombstoned. The deletion stays owed |
| Per-tenant DPA | `DPA_VERSION`; `tenants.dpa_version`; `recordingDecision()` | No accepted DPA, no recording — and a stale one is no DPA |

---

## 1. The AI disclosure

Spoken verbatim at the top of every call, before the conversation begins:

> *"Just so you know, you're speaking with an automated assistant, not a person, and this
> call may be recorded. You can ask for a human at any time."*

Committed at `packages/compliance/src/disclosure.ts`, versioned (`DISCLOSURE_VERSION`), and
pinned by an exact-equality test in two packages. **It is the only sentence in this system
that must never be paraphrased and must never be generated.** `LlmUtterer` will reword an
`ASK_FOR` and nothing else; five tests fail if that check is widened.

The recording notice lives *inside* the disclosure, and that is deliberate rather than
economical. In an all-party-consent state, notice plus continued participation **is** the
consent — so this sentence is the mechanism by which we are permitted to record at all. Two
separate sentences would eventually mean one of them being cut in a tone pass, and it would
be the one that mattered.

**How we know callers heard it.** `auditDisclosure(callIds, turns)` requires an agent turn
whose text contains the string verbatim *and* whose `turnTakeOk` is true — the TTS actually
produced audio. A rendered-but-silent greeting is not a disclosure. It is scored as a
turn-take miss by `packages/telemetry` and as an unrecordable call by us, and both readings
come from the same boolean.

---

## 2. Recording consent

**Two-party ("all-party") consent states.** Recording a call requires the consent of every
party in: **CA, CT, DE, FL, IL, MD, MA, MI, MT, NV, NH, OR, PA, WA.**

Four of those are contested — Michigan, Nevada, Oregon, and Connecticut each have a statute
that reads one way and case law that reads the other — and all four are listed on the
**strict** side on purpose. A state whose law is argued about is a state we do not litigate
in.

**The area code is evidence, not a fact.** Number portability means a `+1 415` number can be
standing in a Boston kitchen, and nothing in the signalling tells us. So:

- An area code we do not recognise → `UNKNOWN` → treated as all-party. An **incomplete map
  is safe**, and every NANP code assigned after we shipped is safe on the day it is
  assigned, with no deploy.
- A withheld number, a foreign number, a short code → all-party.
- A court applies the stricter of the two parties' laws, and the *contractor's* state we do
  know. So `ONE_PARTY` requires **both** ends to be known one-party states.

**The consequence: on the overwhelming majority of calls, the notice comes first and the
recording second.** Audio captured before the disclosure is audio captured without consent,
so it does not exist: `CallRuntime` calls `Recorder.begin()` only after the greeting's
`SpeechOutcome.spoke` comes back true.

> ### The one thing a deployment must get right
>
> **The carrier's own recording switch must be off.** Twilio (and every other provider) will
> happily record from the moment the call is answered if you ask it to, and no amount of
> correct logic on our side unmakes those seconds. `packages/compliance` decides *whether*,
> `CallRuntime` decides *when*, and the deployment's single job is to leave the vendor's
> `record` parameter alone. This is not enforceable in our code, which is why it is written
> here in bold.

**Recording is off by default** (`tenants.recording_enabled`), and requires a current DPA.
An unfinished onboarding therefore records nobody — the cost of forgetting is a missing
feature, never an unlawful recording.

---

## 3. Outbound calls and texts (TCPA)

**We do not make outbound calls.** Ledgerline answers a phone; it does not dial one, and
there is no dialer in the tree.

**We send exactly one kind of message:** a confirmation of an appointment the recipient
asked for, seconds earlier, on a call *they* placed, to the callback number *they* gave us
and heard read back to them. That is a transactional message to a person who initiated the
contact.

This is a type, not a policy. `SmsSender.send()` takes a `TransactionalSms`, and the only
expression in the tree that can produce one reads its destination out of a
`PendingBookingPayload`. There is no way to construct a message for a number nobody dialled
us from — an outbound marketing campaign is a compile error.

**No quiet-hours gate**, deliberately. The 8am–9pm window governs telephone *solicitations*.
If somebody phones a plumber at 2am about a burst pipe, texting them the appointment at
2:01am is the service they requested. A gate we would have to bypass on exactly the calls
that matter most is theatre, and theatre is worse than nothing — it teaches the next reader
that the constraint was handled.

---

## 4. Payment card data (PCI DSS)

**We never ask for payment on the call.** There is no payment slot, no payment state, and
no payment step in the booking saga.

That is a claim about *us*. PCI scope is decided by whether cardholder data is present in
our systems, and a caller who says *"I'll just pay now, it's 4111 1111 1111 1111"* has put
it there without asking. So `redactPan()` runs as the **first statement** of
`CallRuntime.hear()` and `hearPartial()` — the only two doors a caller's words enter this
system through. The card is gone before the emergency classifier, before the extractor, and
therefore before Anthropic, before Postgres, and before the contractor's CRM.

- A **contiguous** run of 13–19 digits is redacted whether or not it passes Luhn. A card
  whose last digit the ASR misheard is still fifteen digits of somebody's real card.
- A **separated** run is redacted only if it is card-shaped and passes Luhn — otherwise
  `"3055551234 33135"` (a phone number and a ZIP, said in one breath) would cost the caller
  their own callback number.
- One deliberate false positive is pinned in the corpus: a contiguous 13-digit *account*
  number is redacted too. We accept that.

**What this cannot reach:** the ASR vendor, which has already heard the audio. That boundary
is a contract — their DPA, and their retention — not a regex, and it is named here rather
than pretended away.

---

## 5. Retention and deletion

| Data | Window | What happens |
|---|---|---|
| Call recordings (audio) | **90 days** | Deleted at the carrier, then tombstoned (`calls.recording_deleted_at`) |
| Transcripts (`call_turns.text`) | **365 days** | Blanked in place; `calls.transcript_redacted_at` set |
| Turn metrics (latency, barge-in, turn-take) | **indefinite** | Untouched. They contain no caller |
| `outcomes`, `job_snapshots` (the raw diff) | **indefinite** | Untouched, and **undeletable** |

`runRetention()` runs daily at 03:00 (`/api/cron/retention`).

**The words go and the numbers stay**, and that interlock is the whole design. Every metric
in `computeMetrics()` is computed from turn *shape* — `first_word_latency_ms`, `barge_in`,
`turn_take_ok` — and never from turn content. So the reliability figures this company exists
to publish can be recomputed, from scratch, over a database that has forgotten every caller
who ever phoned. A retention policy that cost us the measurement would be a policy somebody
would eventually argue their way out of; a test in `packages/telemetry` pins it by computing
the metrics twice, once over turns whose text has been deleted, and asserting they are
identical.

**The deletion job cannot delete the evidence**, and not by convention: the application role
holds no `DELETE` privilege on `outcomes` or `job_snapshots` at all (migration `0002`). A
retention pass that grew an appetite for the corrections that made our published number look
bad would be refused by Postgres. Two tests in `packages/db/src/retention.test.ts` assert
the refusal.

**A failed deletion is counted, never tombstoned.** The media is deleted at the vendor
*first* and the row is marked *second*. Reverse that and a carrier outage writes "deleted"
over audio still sitting in somebody's bucket — a false statement about a person's voice,
and a self-healing one, because the call would leave the working set and no later run would
look at it again. `RetentionReport.recordingsFailed` is the number a human is meant to read,
and the number that must be zero.

---

## 6. The per-tenant DPA

`docs/DPA.md`, version **2026-07-11** (`DPA_VERSION`).

The contractor is the **controller** of their callers' personal data. We are the
**processor**. The DPA is the instrument that says so, and it is what authorises us to hold
a recording of a stranger's voice on the contractor's behalf.

It is a *version*, not a checkbox. What changes between versions is the subprocessor list
and the retention schedule — precisely the two clauses a caller would care about — so a
contractor who accepted the old one has not agreed to what we now do. `dpaStatus()` treats a
stale acceptance as no acceptance, and `recordingDecision()` stops recording until it is
renewed.

**Bumping `DPA_VERSION` turns recording off for every tenant until each re-accepts.** That
is deliberately expensive. A version bump that cost nothing would be a version bump nobody
read.

---

## Subprocessors

The list a caller's data actually travels through. Every one of these is a party to the
DPA's Annex, and **none of them has been contracted yet** — this is the design, and Step 8
does not pretend otherwise.

| Subprocessor | What it sees | Status |
|---|---|---|
| Telephony / SIP (Twilio) | Call audio, caller number | Not contracted (task 4.2) |
| Realtime speech model | Call audio, in-flight | Not contracted (task 4.6) |
| Anthropic | Redacted caller turns, one slot at a time | Bound in code; no credential (task 5.5) |
| Google Address Validation | The service address | Bound in code; no credential (task 4.10) |
| Neon (Postgres) | Everything above, at rest | Not provisioned (task 7.7) |
| Housecall Pro / Jobber | The booking (the contractor's own CRM) | Not contracted (task 7.5) |

---

## What is not done

Named, because a compliance page that implies completeness is the most dangerous document in
a repository.

- **No lawyer has read the disclosure, this page, or the DPA.** Task **8.7**. Committed and
  pinned is not reviewed.
- **No consumer deletion-request path.** CCPA gives a Californian the right to ask a
  contractor to delete their data, and the contractor would have to ask us. Retention is
  scheduled; erasure-on-request is not built. It needs a customer before it needs a design.
- **The carrier's recording switch is a deployment fact, not a code guarantee.** See §2.
- **`HttpRecordingArchive` has never spoken to a live carrier** — real code behind the
  `HttpTransport` port, proven offline, exactly as `GoogleGeocoder` and both CRM adapters
  are. Task **8.6**.
