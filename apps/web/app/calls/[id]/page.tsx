import { notFound } from "next/navigation";
import { LOW_CONFIDENCE_THRESHOLD } from "@ledgerline/contracts";
import { LATENCY_BUDGET } from "@ledgerline/telemetry";
import { Badge, OutcomeBadge } from "@/components/Bits";
import { StateGraph } from "@/components/StateGraph";
import { byId, clockTime, type DemoSlot } from "@/lib/demo-data";

export default async function CallPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const call = byId(id);
  if (!call) notFound();

  const live = call.record.outcome === null;

  return (
    <main>
      <a href="/" className="back">
        ← All calls
      </a>

      {call.hazard && (
        <div className="hazard">
          <h2>Emergency — transferred to a human</h2>
          <p>
            The safety classifier matched <code>{call.hazard.matchedText}</code> on rule{" "}
            <code>{call.hazard.ruleId}</code> and bypassed the conversation within one
            turn. No model was consulted.
          </p>
        </div>
      )}

      <div className="hero" style={{ paddingBottom: 24 }}>
        <h1 style={{ fontSize: 28 }}>{call.callerName}</h1>
        <p className="hero-sub">
          {clockTime(call.record.startedAt)} · {call.record.fromE164}
        </p>
      </div>

      {live && (
        <section className="card" style={{ marginBottom: 24 }}>
          <div className="card-head">
            <h2>In progress</h2>
            <Badge tone="live" pulse>
              Live
            </Badge>
          </div>
          <div className="live-body">
            <StateGraph current={call.state} />
          </div>
        </section>
      )}

      <div className="call-grid">
        <section className="card">
          <div className="card-head">
            <h2>Transcript</h2>
            <OutcomeBadge outcome={call.record.outcome} />
          </div>
          {call.turns.map((turn) => {
            const slow =
              turn.firstWordLatencyMs !== null &&
              turn.firstWordLatencyMs > LATENCY_BUDGET.firstWordP95Ms;

            return (
              <div key={turn.idx} className={`turn ${turn.role}`}>
                <div className="turn-meta">
                  <span>{turn.role === "agent" ? "Agent" : "Caller"}</span>
                  <span>·</span>
                  <span>{turn.state}</span>
                  {turn.bargeIn && <Badge tone="warn">interrupted</Badge>}
                  {turn.firstWordLatencyMs !== null && (
                    <span className={`turn-lat${slow ? " slow" : ""}`}>
                      {turn.firstWordLatencyMs}ms
                    </span>
                  )}
                </div>
                <p className="turn-text">{turn.text}</p>
              </div>
            );
          })}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>What we captured</h2>
            <span className="note">read back &amp; confirmed</span>
          </div>
          {call.slots.length === 0 ? (
            <p className="empty">The call ended before anything was captured.</p>
          ) : (
            call.slots.map((slot) => <SlotRow key={slot.key} slot={slot} />)
          )}
        </section>
      </div>

      <p className="footnote">
        A slot is only allowed to reach your calendar once the caller has heard it
        read back. Address, callback number, and appointment window are always
        confirmed; a name or problem is confirmed when the agent is less than{" "}
        {Math.round(LOW_CONFIDENCE_THRESHOLD * 100)}% sure it heard right.
      </p>
    </main>
  );
}

function SlotRow({ slot }: { slot: DemoSlot }) {
  const low = slot.confidence < LOW_CONFIDENCE_THRESHOLD;

  return (
    <div className="slot">
      <div className="slot-top">
        <span className="slot-key">{slot.label}</span>
        <span className={`check${slot.confirmed ? "" : " pending"}`}>
          {slot.confirmed ? "✓ confirmed" : "awaiting read-back"}
        </span>
      </div>
      <div className="slot-value">{slot.value}</div>
      {slot.previous && (
        <div className="slot-was">
          caller changed from <s>{slot.previous}</s>
        </div>
      )}
      <div className={`meter${low ? " low" : ""}`} title={`${Math.round(slot.confidence * 100)}% confidence`}>
        <span style={{ width: `${Math.round(slot.confidence * 100)}%` }} />
      </div>
    </div>
  );
}
