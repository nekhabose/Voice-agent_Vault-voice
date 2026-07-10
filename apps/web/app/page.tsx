import { checkBudgets } from "@ledgerline/telemetry";
import { Badge, OutcomeBadge, Stat } from "@/components/Bits";
import { StateGraph } from "@/components/StateGraph";
import {
  BOOKED,
  CALLS,
  ESCALATION_COPY,
  FINISHED,
  HANDLED_WITHOUT_HUMAN,
  LIVE_CALLS,
  METRICS,
  NEEDS_ATTENTION,
  clockTime,
  ms,
  pct,
} from "@/lib/demo-data";

export default function Dashboard() {
  const breaches = checkBudgets(METRICS);
  const breached = new Set(breaches.map((b) => b.metric));
  const needs = NEEDS_ATTENTION.length;

  return (
    <main>
      {/*
        One sentence, answering the only question a dispatcher has when they
        pick the tablet up: is the phone being answered, and does anything
        need me right now?
      */}
      <div className="hero">
        <h1>
          {HANDLED_WITHOUT_HUMAN} of {FINISHED} calls booked themselves today.{" "}
          {needs > 0 ? (
            <span className="alarm">
              {needs} {needs === 1 ? "needs" : "need"} you.
            </span>
          ) : (
            <span className="quiet">Nothing needs you.</span>
          )}
        </h1>
        <p className="hero-sub">
          {LIVE_CALLS.length > 0
            ? `${LIVE_CALLS.length} call in progress right now.`
            : "No calls in progress."}
        </p>
      </div>

      {needs > 0 && (
        <section className="card attend">
          <div className="card-head">
            <h2>Needs you</h2>
            <span className="note">Handed off to a person</span>
          </div>
          {NEEDS_ATTENTION.map((call) => (
            <a key={call.record.id} href={`/calls/${call.record.id}`} className="attend-row">
              <Badge tone="danger" pulse>
                {call.hazard ? call.hazard.category.replace(/_/g, " ") : "Escalated"}
              </Badge>
              <span className="attend-why">
                <strong>{call.callerName}</strong>
                <p>
                  {call.escalationReason
                    ? ESCALATION_COPY[call.escalationReason]
                    : call.summary}
                </p>
              </span>
              <span className="row-time tabular">{clockTime(call.record.startedAt)}</span>
            </a>
          ))}
        </section>
      )}

      {LIVE_CALLS.map((call) => (
        <section key={call.record.id} className="card">
          <div className="card-head">
            <h2>In progress</h2>
            <Badge tone="live" pulse>
              Live
            </Badge>
          </div>
          <div className="live-body">
            <div className="live-top">
              <div>
                <div className="live-caller">{call.callerName}</div>
                <p className="live-said">{call.summary}</p>
              </div>
              <a href={`/calls/${call.record.id}`} className="row-time">
                Listen in →
              </a>
            </div>
            <StateGraph current={call.state} />
          </div>
        </section>
      ))}

      <section>
        <div className="stats">
          <Stat
            label="Booked without a human"
            value={pct(METRICS.containmentRate)}
            foot={`${BOOKED.length} of ${FINISHED} finished calls`}
          />
          <Stat
            label="Bookings you had to fix"
            value={pct(METRICS.correctionRate)}
            foot="Measured from your edits, not our guess"
            tone={METRICS.correctionRate > 0 ? "bad" : "good"}
          />
          <Stat
            label="Time to first word (p95)"
            value={ms(METRICS.firstWordLatencyP95Ms)}
            foot={
              breached.has("firstWordLatencyP95Ms")
                ? "Over the 1.20s budget"
                : "Inside the 1.20s budget"
            }
            tone={breached.has("firstWordLatencyP95Ms") ? "bad" : "good"}
          />
          <Stat
            label="Answered when spoken to"
            value={pct(METRICS.turnTakeRate)}
            foot={
              breached.has("turnTakeRate")
                ? "Below the 96% target"
                : `Interrupted the caller ${pct(METRICS.bargeInRate)} of turns`
            }
            tone={breached.has("turnTakeRate") ? "bad" : "good"}
          />
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Today&rsquo;s calls</h2>
          <span className="note">{CALLS.length} total</span>
        </div>
        {CALLS.map((call) => (
          <a key={call.record.id} href={`/calls/${call.record.id}`} className="row">
            <span className="row-time tabular">{clockTime(call.record.startedAt)}</span>
            <span className="row-main">
              <span className="row-title">{call.callerName}</span>
              <span className="row-sub">{call.summary}</span>
            </span>
            <OutcomeBadge outcome={call.record.outcome} />
          </a>
        ))}
      </section>

      <p className="footnote">
        Every number here is measured, not asserted. &ldquo;Bookings you had to
        fix&rdquo; comes from jobs you edited or cancelled after we created them —
        the one reliability figure nobody in voice AI publishes, and the one we
        are accountable to.
      </p>
    </main>
  );
}
