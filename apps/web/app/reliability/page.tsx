import {
  DPA_VERSION,
  RECORDING_RETENTION_DAYS,
  TRANSCRIPT_RETENTION_DAYS,
} from "@ledgerline/compliance";
import { AUDIT_AGREEMENT_FLOOR, MIN_AUDITED_OUTCOMES } from "@ledgerline/telemetry";
import { invoiceFor } from "@ledgerline/billing";
import { Stat } from "@/components/Bits";
import { BOOKED, DISCLOSURE, METRICS, OUTCOMES, PUBLISHED, TENANT, pct } from "@/lib/demo-data";

/**
 * The reliability page — "the reliability numbers as the pitch, not a tab" (plan, Step 7).
 *
 * Every figure here is computed by `@ledgerline/telemetry` and `@ledgerline/billing` from
 * the same records the agent produces. None of them is typed into this file, and the
 * *sentence at the top of the page is the one we would least like to write*: the raw
 * correction rate, before any classifier has been allowed near it.
 *
 * That ordering is the product. A competitor can build a voice agent; what they cannot
 * retrofit is a page that leads with the number that embarrasses them.
 */
export default function Reliability() {
  const licensed = PUBLISHED.basis === "agent_error";

  // Drawn from the same outcomes the metrics are. A booking we got wrong is a booking we
  // do not bill for, so this figure and the correction rate above it move together — and
  // that is the entire argument for why the number on this page can be trusted.
  const invoice = invoiceFor({
    tenantId: "demo",
    periodStart: "2026-07-01T00:00:00.000Z",
    periodEnd: "2026-08-01T00:00:00.000Z",
    jobs: BOOKED.map((call) => ({
      bookingId: call.record.id,
      committedAt: "2026-07-08T18:30:00.000Z",
    })),
    outcomes: OUTCOMES,
    pricePerBookingCents: 900,
  });

  return (
    <main>
      <div className="hero">
        <h1>
          {TENANT.name} booked {BOOKED.length} jobs.{" "}
          <span className={METRICS.correctionRate > 0 ? "alarm" : "quiet"}>
            You corrected {pct(METRICS.correctionRate)} of them.
          </span>
        </h1>
        <p className="hero-sub">
          Nobody else in this industry publishes this number. We publish it whether or not
          it flatters us — that is the only reason it is worth anything.
        </p>
      </div>

      <section className="stats">
        <Stat
          label="Correction rate (raw)"
          value={pct(METRICS.correctionRate)}
          foot="Every booking you edited or cancelled. Nothing subtracted."
          tone={METRICS.correctionRate > 0 ? "bad" : "good"}
        />
        <Stat
          label="Our fault"
          value={pct(METRICS.agentErrorRate)}
          foot="Corrections we caused. An unclassified correction counts here."
        />
        <Stat
          label="Audited by a human"
          value={`${METRICS.auditedOutcomes}`}
          foot={`We need ${MIN_AUDITED_OUTCOMES} before the classifier is trusted at all.`}
        />
        <Stat
          label="Model agrees with the auditor"
          value={pct(METRICS.triageAgreementRate)}
          foot={`Below ${pct(AUDIT_AGREEMENT_FLOOR)}, we ignore the classifier.`}
        />
      </section>

      {/*
        The publication rule, said out loud. `publishedCorrectionRate()` decides which of
        the two rates above we are entitled to quote, and refuses the flattering one until
        a human audit has vouched for the classifier. A contractor being shown a
        reliability number deserves to know which number it is.
      */}
      <section className="panel">
        <h2>What we are allowed to publish</h2>
        <p className="published tabular">{pct(PUBLISHED.rate)}</p>
        <p className={licensed ? "quiet" : "alarm"}>
          {licensed
            ? "Attributed to the agent."
            : "The raw rate, because the classifier has not earned its place."}
        </p>
        <p className="reason">{PUBLISHED.reason}</p>
      </section>

      {/*
        Billing, on the reliability page rather than a billing page, because the two are
        the same claim. We charge per booked job and we do not charge for a job we got
        wrong — so an agent error is a line we waive, not a line we hide.
      */}
      <section className="panel">
        <h2>What we charged you for</h2>
        <p>
          {invoice.billed} of {invoice.booked} bookings, at $9.00 each —{" "}
          <strong className="tabular">${(invoice.totalCents / 100).toFixed(2)}</strong>.
        </p>
        <p className="reason">
          {invoice.waived === 0
            ? "Nothing waived this month."
            : `${invoice.waived} waived: we do not bill for a booking we got wrong.` +
              (invoice.staleTriage > 0
                ? ` ${invoice.staleTriage} of those is still unclassified, and stays unbilled until it is.`
                : "")}
        </p>
      </section>

      {/*
        Compliance, on the reliability page rather than in a policy PDF, for the same reason
        the correction rate is here rather than in a footnote: a promise nobody can check is
        a promise nobody made.

        The disclosure rate is the one number on this page with no acceptable value but
        100%. `checkBudgets()` argues about 96% turn-take because that is an engineering
        trade-off; a caller who was never told they were talking to a machine is not a
        trade-off. And it is scored against what was *actually spoken*, verbatim — a
        paraphrase counts as a failure, which is how a model that "helpfully" rewords the
        greeting shows up here rather than nowhere.
      */}
      <section className="panel">
        <h2>What every caller was told</h2>
        <p className="published tabular">{pct(DISCLOSURE.rate)}</p>
        <p className={DISCLOSURE.rate === 1 ? "quiet" : "alarm"}>
          {DISCLOSURE.rate === 1
            ? `All ${DISCLOSURE.calls} callers heard the AI disclosure, word for word, before anything else.`
            : `${DISCLOSURE.undisclosed.length} of ${DISCLOSURE.calls} callers did not hear it: ${DISCLOSURE.undisclosed.join(", ")}.`}
        </p>
        <p className="reason">
          Recordings are deleted after {RECORDING_RETENTION_DAYS} days and transcripts after{" "}
          {TRANSCRIPT_RETENTION_DAYS}; the latency and turn-taking figures above outlive both,
          because they never contained a caller. Data processing addendum {DPA_VERSION} — and
          without a current one, we record nobody.
        </p>
      </section>
    </main>
  );
}
