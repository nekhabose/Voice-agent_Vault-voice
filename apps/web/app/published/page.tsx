import {
  METHODOLOGY_VERSION,
  type ReliabilityReport,
} from "@ledgerline/contracts";
import {
  MIN_COHORT_BOOKINGS,
  MIN_COHORT_CALLS,
  MIN_COHORT_TENANTS,
  MIN_OBSERVED_COVERAGE,
} from "@ledgerline/telemetry";
import { publicationState, quarterLabel, rate } from "@/lib/publication";

/**
 * The number nobody else publishes (plan, Step 9).
 *
 * `idea.md` §7's first open question is that **no field reliability figures exist** for
 * deployed voice agents — only synthetic benchmarks. Being the first to publish ours is the
 * whole marketing case, and it is worth exactly nothing unless the mechanism behind it is
 * one we could not have bent even if we had wanted to. So this page is mostly an argument
 * about its own trustworthiness, and every claim in it points at code somebody can read.
 *
 * **It renders live, on every request.** A page that showed only the last published figure
 * would let a cron nobody ran leave a stale number looking current — which is how a vendor
 * stops publishing without ever deciding to. So the current window's decision is computed
 * on each load, and a withheld quarter says, in the present tense, what it is waiting for.
 *
 * **And today it withholds**, because there are no contractors, no calls, and no
 * corrections. That is the honest state of this company, and printing it is not a
 * placeholder — it is the first thing this page has ever had to be right about.
 */
export const dynamic = "force-dynamic";

export default async function Published() {
  const state = await publicationState();

  return (
    <main>
      <div className="hero">
        <h1>
          How often does this agent get it wrong?{" "}
          <span className="quiet">We are the only people who will tell you.</span>
        </h1>
        <p className="hero-sub">
          Every booking a contractor later edits or cancels is a failure we caused, and we
          count it. No voice-agent vendor publishes this number. The benchmarks in the
          literature are synthetic; this is the field.
        </p>
      </div>

      {state.kind === "no_database" ? <NoData /> : <Decision state={state} />}

      <Methodology />
    </main>
  );
}

/**
 * The state this company is actually in.
 *
 * Not a placeholder, and deliberately not a zero. `computeMetrics()`' ratio of nothing over
 * nothing is `0` — a **flawless correction rate**, from no data at all — and a page that
 * printed it would be technically truthful and completely dishonest. That failure mode
 * (a metric whose broken state looks perfect) is the one this product is organised against,
 * so the first place it could have appeared is the first place we refuse it.
 */
function NoData() {
  return (
    <section className="panel">
      <h2>We have not published a number yet.</h2>
      <p className="alarm">
        No contractor has used this agent to answer a real call, so there is nothing to
        report. Not a zero — <strong>nothing</strong>.
      </p>
      <p className="reason">
        A correction rate of 0% over no bookings is the number a broken measurement pipeline
        reports, and it is the number a dishonest vendor reports. We would rather say this.
      </p>
    </section>
  );
}

function Decision({
  state,
}: {
  state: Extract<Awaited<ReturnType<typeof publicationState>>, { kind: "measured" }>;
}) {
  const { decision, history, window } = state;

  return (
    <>
      {decision.status === "published" ? (
        <Headline report={decision.report} />
      ) : (
        <section className="panel">
          <h2>
            {quarterLabel(window.start)} is not published, and here is exactly why.
          </h2>
          <ul className="reason">
            {decision.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p className="reason">
            Every one of those is a statement about the <em>sample</em>. None of them is a
            statement about the number — there is no code path in this system from &ldquo;the
            correction rate is embarrassing&rdquo; to &ldquo;withheld&rdquo;, and a test
            asserts that a 100% correction rate over an adequate sample publishes anyway.
          </p>
          <p className="reason">
            We had {decision.cohort.tenants} tenants, {decision.cohort.calls} calls, and{" "}
            {decision.cohort.committedBookings} bookings whose outcome we have finished
            observing.
          </p>
        </section>
      )}

      {history.length > 0 && <History reports={history} />}
    </>
  );
}

/** The figure, and everything a sceptic needs to discount it properly. */
function Headline({ report }: { report: ReliabilityReport }) {
  return (
    <>
      <section className="panel">
        <h2>{quarterLabel(report.windowStart)}</h2>
        <p className="published tabular">{rate(report.correctionRate)}</p>
        <p className="alarm">
          of bookings were corrected or cancelled by the contractor. This is the raw number.
          Nothing is subtracted from it.
        </p>
        <p className="reason">
          95% confidence: {rate(report.correctionRateLow)} to{" "}
          {rate(report.correctionRateHigh)}, over {report.committedBookings} bookings from{" "}
          {report.tenants} contractors and {report.calls} calls. A point estimate with no
          interval invites a precision the sample cannot support, and we are the people who
          would benefit from you believing it.
        </p>
      </section>

      <section className="stats">
        {/*
          The worst tenant, beside the average. Nine contractors at 2% and one at 40% pool to
          something respectable — and the tenth, the only one for whom this product does not
          work, is arithmetically invisible in that number. Publishing the pooled figure alone
          would be scrupulously honest and thoroughly misleading.
        */}
        <Figure
          label="Our worst customer"
          value={rate(report.worstTenantCorrectionRate)}
          foot={`Over ${report.worstTenantBookings} bookings. An average hides the contractor for whom this did not work.`}
        />
        <Figure
          label="Our fault"
          value={rate(report.agentErrorRate)}
          foot="Corrections we caused. An unclassified correction counts here, against us."
        />
        <Figure
          label="Outcomes observed"
          value={rate(report.observedCoverage)}
          foot="Bookings whose full poll schedule finished. A rate over less than this would have a hole in it."
        />
        <Figure
          label="Model agrees with our auditor"
          value={rate(report.triageAgreementRate)}
          foot={`Over ${report.auditedOutcomes} human-audited labels.`}
        />
      </section>

      <section className="panel">
        <h2>The figure we quote, and which one it is</h2>
        <p className="published tabular">{rate(report.publishedRate)}</p>
        <p className={report.publishedBasis === "raw" ? "alarm" : "quiet"}>
          {report.publishedBasis === "raw"
            ? "The raw rate — the classifier has not earned the right to reduce it."
            : "Corrections attributed to the agent, licensed by a human audit."}
        </p>
        <p className="reason">{report.publishedReason}</p>
      </section>
    </>
  );
}

function Figure({
  label,
  value,
  foot,
}: {
  label: string;
  value: string;
  foot: string;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value tabular">{value}</div>
      <div className="stat-foot">{foot}</div>
    </div>
  );
}

/**
 * Every figure we have ever published.
 *
 * **The gaps are the point.** A published report cannot be edited or deleted — the app role
 * holds `SELECT` and `INSERT` on that table and nothing else — so a quarter we did not like
 * cannot be withdrawn. It can only be followed by another quarter, published beside it. If
 * a period is missing from this list, we stopped publishing, and you can see that we did.
 */
function History({ reports }: { reports: readonly ReliabilityReport[] }) {
  return (
    <section className="panel">
      <h2>Everything we have ever published</h2>
      <table className="table">
        <thead>
          <tr>
            <th>Period</th>
            <th>Corrected</th>
            <th>95% CI</th>
            <th>Bookings</th>
            <th>Method</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((report) => (
            <tr key={report.id}>
              <td>{quarterLabel(report.windowStart)}</td>
              <td className="tabular">{rate(report.correctionRate)}</td>
              <td className="tabular">
                {rate(report.correctionRateLow)}–{rate(report.correctionRateHigh)}
              </td>
              <td className="tabular">{report.committedBookings}</td>
              <td>{report.methodologyVersion}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="reason">
        Figures under different methodology versions measure different things and must not be
        drawn as a trend. A published figure cannot be edited or deleted — the database will
        not permit it — so a quarter missing from this list is a quarter we stopped
        publishing, and you can see that we did.
      </p>
    </section>
  );
}

/** The rules, in advance. A methodology published after the number is a number with an excuse. */
function Methodology() {
  return (
    <section className="panel">
      <h2>How this is computed ({METHODOLOGY_VERSION})</h2>
      <ul className="reason">
        <li>
          <strong>Ground truth is the contractor, not us.</strong> We re-read every booking in
          the CRM at 24 hours, 72 hours, and 7 days. Anything they changed or cancelled is a
          failure. We poll rather than listen for webhooks, because a missed webhook reports a
          0% correction rate — the number a dishonest vendor would report.
        </li>
        <li>
          <strong>A booking is only counted once its polls have finished.</strong> A booking
          made yesterday cannot show a correction yet, and counting it would make the newest
          bookings flatter us. At least {MIN_OBSERVED_COVERAGE * 100}% of a quarter&rsquo;s
          bookings must have been fully observed or we publish nothing.
        </li>
        <li>
          <strong>An unclassified correction counts against us.</strong> A model sorts each
          correction into our fault, a change of plan, or an enrichment — but a correction it
          has not labeled, or declined to label, or could not label because the model was
          down, counts as <em>our fault</em>. Every failure of that pipeline pushes this
          number up.
        </li>
        <li>
          <strong>The classifier is licensed, not trusted.</strong> We only quote the reduced
          figure while a human audit of at least 20 corrections agrees with the model at least
          95% of the time. Otherwise we quote the raw rate, which is worse for us and true.
        </li>
        <li>
          <strong>The window is a calendar quarter, and we do not choose it.</strong> A vendor
          who picks their reporting period can catch a good streak, and nobody could prove it.
        </li>
        <li>
          <strong>We do not publish thin data.</strong> At least {MIN_COHORT_TENANTS}{" "}
          contractors, {MIN_COHORT_CALLS.toLocaleString("en-US")} calls, and{" "}
          {MIN_COHORT_BOOKINGS} bookings — below that, a correction rate has a confidence
          interval too wide to mean anything, and quoting it would be the most sophisticated
          lie we could tell.
        </li>
        <li>
          <strong>We do not bill for a booking we got wrong.</strong> The same predicate that
          puts a booking in the numerator above removes it from your invoice. Our error rate
          cannot be an income stream.
        </li>
      </ul>
      <p className="reason">
        The full methodology is in <code>docs/RELIABILITY.md</code>, and the machine-readable
        figures are at <code>/api/reliability</code>.
      </p>
    </section>
  );
}
