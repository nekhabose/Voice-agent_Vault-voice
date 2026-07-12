# The number, and how it is computed

> **We have not published a number yet.** No contractor has used this agent to answer a real
> call, so there is nothing to report — and a correction rate of 0% over no bookings is
> precisely the figure a broken measurement pipeline produces. This document exists *before*
> the number, on purpose: a methodology published after the result is a methodology written
> to fit it.

Methodology version **2026-07-12** (`METHODOLOGY_VERSION`, `contracts/src/publication.ts`).

---

## Why this document exists

`idea.md` §7's first open question, after a review of the literature, is this:

> *What are **real production** reliability numbers for deployed commercial voice agents, vs.
> the synthetic benchmarks? (No field measurements surfaced.)*

Nobody publishes them. The benchmarks that exist — VoiceAgentBench, Full-Duplex-Bench-v3 —
are rigorous and synthetic, and every vendor in this market is free to describe their agent
as "highly accurate" because there is no number anyone could check them against.

So the wedge is not a better agent. It is **a number, published, whether or not it flatters
us** — and the only thing that makes such a number worth anything is that the mechanism
producing it is one we could not bend even if we wanted to. That is what the rest of this
page is about. Every claim below names the code that enforces it, so a sceptic can check the
claim against the mechanism rather than against our good intentions.

---

## What we measure

**The contractor is the ground truth, not us.** After a call books a job, we write it to the
contractor's CRM and then re-read it — at 24 hours, 72 hours, and 7 days. Anything they
changed is something we got wrong. Anything they cancelled is something we got wrong.

That is the whole metric. `outcomes.corrected_fields` is a diff between what the agent
captured and what the contractor's CRM says a week later, and it is not a proxy for quality:
it is a plumber fixing an address because we sent a truck to the wrong door.

| Figure | What it is |
|---|---|
| **Correction rate** | Bookings the contractor edited or cancelled, over all matured bookings. **Raw. Nothing is subtracted from it, ever.** |
| **95% interval** | Wilson score interval on the above. A point estimate invites a precision the sample cannot support. |
| **Agent-error rate** | The subset a classifier attributes to *us*. Always ≤ the correction rate. |
| **Worst tenant** | The single worst contractor's rate, and the bookings it is over. |
| **Observed coverage** | How much of the quarter's booking volume we actually finished observing. |
| **Audit agreement** | How often the classifier and a human auditor chose the same label. |

---

## The disciplines

Each of these is a way we could cheat, closed. They are listed in the order somebody would
discover them while trying.

### 1. We poll. We do not listen for webhooks.

Webhook delivery is at-most-once. A missed webhook means a correction we never hear about —
and a correction we never hear about **improves our published number**. A metric whose
failure mode is *looks perfect* must not depend on lossy delivery.

`CRM_WEBHOOK` was removed from `OutcomeSourceSchema` and there is a test that fails if
someone puts it back. A failed poll throws and records *nothing*, rather than recording "no
corrections" — the same failure wearing a different hat.

### 2. An empty cohort is not a perfect score.

`0 corrections ÷ 0 bookings` is `0` in every programming language, and a company with no
customers therefore reports a **flawless correction rate**. So publication is a *decision*,
not a number: below three contractors, a thousand calls, or five hundred bookings we publish
nothing at all and say what we are waiting for.

`decidePublication()`, `packages/telemetry/src/publication.ts`. This is the state we are in
today.

### 3. The newest bookings always flatter us, so they are excluded.

A booking committed yesterday has not been re-read at 72 hours or 7 days yet. **No correction
*can* have been observed on it.** Leaving it in the denominator dilutes the numerator with
bookings that never had a chance to fail — and a vendor who published monthly, from the first
of the month, would report a number bent in their favour by the calendar alone and would
never have to know they were doing it.

So a booking counts only once its full poll schedule has run. And because *that* exclusion is
itself abusable — a CRM outage stops the polls, and the survivors publish a lovely number —
at least **95% of a quarter's bookings must have been fully observed** or we publish nothing.

### 4. An unclassified correction counts against us.

A model sorts each correction into `agent_error`, `business_change`, or `enrichment`. The
obvious reading of that — *only `agent_error` counts against the correction rate* — turns
triage into a machine for deleting our own failures: a classifier that declines, an Anthropic
outage, or a cron nobody wired up would each **silently improve** the published figure.

So the raw rate stays raw, the agent-error rate is computed *beside* it, and a correction
nobody has labeled is **our fault**. Every failure mode of that pipeline pushes the published
number *up*.

`isAgentError()`, `contracts/src/booking.ts`: `label === null || label === "agent_error"`.

### 5. The classifier is licensed, not trusted.

A model asked whether a contractor's edit was its own fault is an interested party. So a
human audits a stable, hash-selected sample of corrections, and we quote the reduced figure
**only** while at least 20 corrections carry a human label *and* the model agrees with the
auditor at least 95% of the time. Otherwise we quote the raw rate, which is worse for us and
true.

The audit sample is chosen by hashing the booking id — stable, so a disliked week cannot be
re-rolled, and assigned before the outcome existed, so it cannot be steered.

### 6. We do not choose the window.

A vendor who selects their reporting period has a free parameter worth more than any amount
of spin: *the trailing 37 days* catches a good streak, *since the fix shipped* is the same
move with an engineering excuse attached, and neither is a lie anyone could prove. The window
is a **calendar quarter**, derived from the clock (`lastCompleteQuarter()`), the same every
time, settled before anyone knows what it will contain.

### 7. The pooled average is not allowed to hide anyone.

Nine contractors at 2% and one at 40% pool to 5.8%. The tenth — the only one for whom this
product does not work — is arithmetically invisible in that number, and the number is
scrupulously honest. So the **worst single tenant's rate** is published beside the average,
with the booking count it is over, because 100% over three bookings is noise and over three
hundred is an emergency.

No tenant id ever leaves the aggregate. The floor of three contractors is what keeps the
arithmetic itself from naming one.

### 8. A published figure cannot be retracted.

`reliability_reports` is append-only **by privilege**: the application role holds `SELECT`
and `INSERT` and nothing else — no `UPDATE`, no `DELETE` (migration `0004`) — and the
`ReportStore` port has no method that could express either. A quarter we did not like cannot
be withdrawn. It can only be followed by another quarter, published beside it.

The consequence is that **the gaps are visible**. A period missing from the history at
`/published` is a period we stopped publishing, and you can see that we did.

### 9. Nothing can withhold a figure for being bad.

Read the gates in `decidePublication()` and note what is not among them: **the rate**. There
is no branch that reads the numerator and decides the number is too embarrassing to print.
Every reason a figure can be withheld is a statement about the *sample*, and every one of
them is printed beside the cohort it was measured over.

`publication.test.ts` asserts that a cohort in which the contractor corrected **every single
booking we made** publishes 100%. That test is the product. A vendor who retains the option
to suppress a figure they dislike has published nothing, whatever their website says, and the
only way to be believed is to have deleted the option in code somebody else can read.

### 10. We do not bill for a booking we got wrong.

The same predicate that puts a booking in the numerator above removes it from the invoice
(`packages/billing`, importing `isAgentError` from `contracts` — there is a test asserting
the two cannot drift). If we billed for every job that reached the CRM, **our own error rate
would be an income stream**, and we are the company that publishes its error rate. Those two
facts cannot both be true of one business.

An *unclassified* correction is therefore also unbilled: a triage backlog costs us money, not
merely a worse number.

---

## Where the number comes from, mechanically

The published figure is the only quantity in this system that is **not** one contractor's,
and that is a genuine engineering problem rather than a paragraph. Every other query runs
inside `withTenant()` with Postgres row-level security underneath it, and an unscoped
connection sees *nothing*.

The obvious way to compute a cross-tenant aggregate — connect as the database owner and count
— would make the one number we show the world the one produced by the only connection in the
system with no isolation at all. (Postgres exempts a table's owner from RLS unless the table
is FORCEd, and a superuser even then. There is a passing test in `rls.test.ts` proving that
bypass exists, precisely so nobody reaches for it.)

Instead, the cohort is computed by a `SECURITY DEFINER` function that sees every tenant's rows
and **can only return counts** (`app_reliability_cohort`, migration `0004`). The application
role calls it with no tenant set, gets the aggregate, and still cannot read a single row of
anyone's data — there is a test for each half of that sentence. The function's return type is
the guarantee.

---

## What is not measured, and why

- **Latency, barge-in, and turn-take are not in the published figure yet.** They are computed
  (`computeMetrics()`, using Full-Duplex-Bench-v3's definitions so they are comparable to the
  literature) and enforced as CI budgets — but they require a real SIP path to mean anything,
  and there is no telephony account (task 5.3).
- **A caller's words are not needed for any of it.** Retention blanks transcripts after 365
  days and deletes audio after 90, and every number here survives, because they are computed
  over turn *shape* and never turn *content*. The published figures can be recomputed over a
  database that has forgotten every caller who ever phoned.

---

## Machine-readable

`GET /api/reliability` returns the current decision, the cohort, and the full publication
history as JSON — deliberately public and unauthenticated, so that a journalist, a customer,
or a competitor can archive it on a schedule and catch us moving the goalposts later. The
append-only table means we could not move them quietly even if we tried; that endpoint is what
makes the fact checkable from outside.

Today it returns `{"status": "unmeasured"}`.
