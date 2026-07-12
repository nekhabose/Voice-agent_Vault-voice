# Data Processing Addendum

**Version `2026-07-11`** — this string is `DPA_VERSION` in `packages/compliance/src/dpa.ts`,
and `tenants.dpa_version` records which version each contractor accepted.

> **⚠️ Not reviewed by counsel.** This is a template written by engineers so that the code
> enforcing it has something to enforce. It is task **8.7**, and it must not be put in front
> of a contractor until a lawyer has signed it. A DPA is a contract; this is a specification
> of one.

---

## The parties

- **Controller** — the contractor (the "Customer"). It is *their* customers who phone, and
  their business relationship that the data serves.
- **Processor** — Ledgerline. We process that data only to answer the phone, capture the
  job, and write it to the Customer's CRM.

## 1. Subject matter and duration

We answer inbound telephone calls to numbers the Customer directs to us, converse with the
caller, capture the details of a service request, and commit it to the Customer's CRM.
Processing lasts for the term of the agreement, plus the retention windows in §5.

## 2. Categories of data subject

Members of the public who telephone the Customer's business.

## 3. Categories of personal data

| Category | Why | Where |
|---|---|---|
| Name | To address the caller and identify the customer record | `slots.caller_name` |
| Telephone number | To confirm the appointment, and to call back | `slots.callback_phone`, `calls.from_e164` |
| Service address | To send a technician to the right building | `slots.service_address` |
| A description of the problem, in their words | To schedule the right work | `slots.problem_description` |
| Voice recording | Quality and dispute resolution, **only where enabled** (§5) | `calls.recording_url` |
| Transcript | The record of what was said | `call_turns.text` |

**Not processed:** payment card data. We do not take payment on the call, and a card number
a caller volunteers unasked is redacted before it reaches storage, any model, or the
Customer's CRM (`redactPan()` — `docs/COMPLIANCE.md` §4). Special-category data as such is
not collected; a caller may of course volunteer health information ("my mother is on
oxygen") in describing an emergency, and it lands in the problem description and is treated
exactly as the rest of it.

## 4. Recording and consent

Recording is **off by default** and requires the Customer to enable it
(`tenants.recording_enabled`) *and* to have accepted the current version of this Addendum.

Every caller is told, before the conversation begins and in words that do not vary:

> *"Just so you know, you're speaking with an automated assistant, not a person, and this
> call may be recorded. You can ask for a human at any time."*

Recording does not begin until that sentence has been **spoken and heard**, except where
both the caller's and the Customer's states permit one-party consent. The Customer warrants
that the state recorded in `tenants.state_code` is where their business operates; we assess
the caller's state from their area code and, where we cannot, we apply the stricter rule.

## 5. Retention

| Data | Retained | Then |
|---|---|---|
| Voice recordings | 90 days | Deleted at the telephony provider; the deletion is recorded |
| Transcripts | 365 days | Erased in place |
| Call metadata and reliability metrics (latency, barge-in, turn-take, outcome) | Indefinitely | Retained. They identify nobody |
| Booking correction records | Indefinitely | Retained. They are the evidence behind our published reliability figures, and cannot be deleted by us or by the Customer |

The last row is a deliberate limitation on the Customer's rights, and we say so plainly: a
correction is our own error rate, and a vendor able to delete the record of its mistakes on
request is a vendor whose published number means nothing. The correction record contains no
caller identifier — it is a diff of *fields*, not of people.

## 6. Subprocessors

The current list is in `docs/COMPLIANCE.md`. We will give the Customer notice before adding
one, and adding one bumps `DPA_VERSION` — which, by design, stops recording until the
Customer accepts the new version. That is not a formality: a new subprocessor is a new party
seeing a caller's voice, and the Customer's consent to the old list is not consent to the
new one.

## 7. Security

- Every contractor's data is isolated by PostgreSQL row-level security, enforced by the
  database rather than by our queries, under a role that owns nothing and bypasses nothing
  (`packages/db/migrations/0002`).
- The correction record is append-only **by privilege**: the application holds no `UPDATE`
  on the raw diff and no `DELETE` on it at all.
- CRM credentials are encrypted at the application boundary.

## 8. Data subject rights

Requests from a caller reach the Customer, who is the controller. We assist within our
technical means. **A per-caller erasure path is not yet built** — see `docs/COMPLIANCE.md`,
"What is not done." Retention is scheduled and automatic; erasure on request is not, and
this Addendum must not be signed as though it were.

## 9. Return and deletion

On termination, we delete the Customer's operational data within 30 days, excepting the
correction records described in §5, which are retained without caller identifiers.

---

*Signature blocks intentionally omitted. This document has not been reviewed by counsel and
is not ready to be signed by anybody — see the notice at the top.*
