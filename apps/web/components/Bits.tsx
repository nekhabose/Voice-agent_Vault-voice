import type { CallOutcome } from "@ledgerline/contracts";

type Tone = "ok" | "warn" | "danger" | "muted" | "live";

export function Badge({
  tone,
  children,
  pulse = false,
}: {
  tone: Tone;
  children: React.ReactNode;
  pulse?: boolean;
}) {
  return (
    <span className={`badge badge-${tone}`}>
      {(tone === "live" || pulse) && (
        <span className={`dot${pulse ? " dot-pulse" : ""}`} aria-hidden />
      )}
      {children}
    </span>
  );
}

const OUTCOME_TONE: Record<CallOutcome, Tone> = {
  BOOKED: "ok",
  ESCALATED_EMERGENCY: "danger",
  ESCALATED_OTHER: "warn",
  OUT_OF_SERVICE_AREA: "muted",
  CALLER_HUNG_UP: "muted",
  AGENT_ERROR: "danger",
};

const OUTCOME_COPY: Record<CallOutcome, string> = {
  BOOKED: "Booked",
  ESCALATED_EMERGENCY: "Emergency",
  ESCALATED_OTHER: "Escalated",
  OUT_OF_SERVICE_AREA: "Out of area",
  CALLER_HUNG_UP: "Hung up",
  AGENT_ERROR: "Error",
};

export function OutcomeBadge({ outcome }: { outcome: CallOutcome | null }) {
  if (outcome === null) {
    return (
      <Badge tone="live" pulse>
        Live
      </Badge>
    );
  }
  return <Badge tone={OUTCOME_TONE[outcome]}>{OUTCOME_COPY[outcome]}</Badge>;
}

/**
 * A single number, its definition, and whether it is inside budget.
 *
 * The sub-label is not decoration. "Correction rate" means nothing to a
 * plumber; "bookings you had to fix" does, and it is the number we are
 * accountable for.
 */
export function Stat({
  label,
  value,
  foot,
  tone,
}: {
  label: string;
  value: string;
  foot: string;
  tone?: "good" | "bad";
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value tabular">{value}</div>
      <div className={`stat-foot${tone ? ` ${tone}` : ""}`}>{foot}</div>
    </div>
  );
}
