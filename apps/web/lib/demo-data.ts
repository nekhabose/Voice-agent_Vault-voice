import type {
  BookingOutcome,
  CallRecord,
  CallState,
  CallTurn,
  EscalationReason,
  HazardDetection,
  SlotKey,
} from "@ledgerline/contracts";
import { computeMetrics, publishedCorrectionRate } from "@ledgerline/telemetry";

/**
 * Seed data for the dashboard: one realistic day at a small Miami plumbing shop.
 *
 * Typed against the real domain contracts rather than a bespoke view model, so
 * the UI cannot drift from what the agent actually produces. Every headline
 * number on the dashboard is computed from these records by
 * `@ledgerline/telemetry` — none of them is typed into the page. When the
 * Postgres layer lands, only this file is replaced.
 */

export const TENANT = {
  name: "Rivera Plumbing & Heating",
  timeZone: "America/New_York",
  trade: "Plumbing",
} as const;

export interface DemoSlot {
  readonly key: SlotKey;
  readonly label: string;
  readonly value: string;
  readonly confidence: number;
  readonly confirmed: boolean;
  /** Shown struck through: what the caller corrected. */
  readonly previous?: string;
}

export interface DemoCall {
  readonly record: CallRecord;
  readonly callerName: string;
  readonly summary: string;
  readonly turns: readonly CallTurn[];
  readonly slots: readonly DemoSlot[];
  /** Only meaningful while the call is live. */
  readonly state: CallState;
  readonly hazard?: HazardDetection;
  readonly escalationReason?: EscalationReason;
}

const TENANT_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

interface Timing {
  readonly firstWord: number;
  readonly total: number;
  readonly bargeIn?: boolean;
  /** The agent never responded. A turn-take failure, not a fast turn. */
  readonly missed?: boolean;
}

function turn(
  callId: string,
  idx: number,
  role: "caller" | "agent",
  state: CallState,
  text: string,
  timing?: Timing,
): CallTurn {
  const spoke = role === "agent" && timing !== undefined && !timing.missed;
  return {
    callId,
    idx,
    role,
    state,
    text,
    firstWordLatencyMs: spoke ? timing.firstWord : null,
    turnLatencyMs: spoke ? timing.total : null,
    bargeIn: timing?.bargeIn ?? false,
    turnTakeOk: role === "agent" ? !timing?.missed : true,
    createdAt: "2026-07-08T13:00:00.000Z",
  };
}

function record(
  id: string,
  startedAt: string,
  outcome: CallRecord["outcome"],
  locales: CallRecord["localesDetected"],
  from: string,
): CallRecord {
  return {
    id,
    tenantId: TENANT_ID,
    fromE164: from,
    startedAt,
    endedAt: outcome ? startedAt : null,
    localesDetected: locales,
    outcome,
    containment: outcome === "BOOKED",
    recordingUrl: null,
    transcriptUrl: null,
  };
}

/* -------------------------------------------------------------------------- */
/* The calls worth reading in full                                             */
/* -------------------------------------------------------------------------- */

const live: DemoCall = {
  record: record("live-1", "2026-07-08T17:42:00.000Z", null, ["en"], "+13055557781"),
  callerName: "Rosa Delgado",
  summary: "Water heater leaking into the garage",
  state: "SCHEDULE",
  turns: [
    turn("live-1", 0, "agent", "GREETING", "Rivera Plumbing, you're speaking with an automated assistant. How can I help?", { firstWord: 380, total: 1600 }),
    turn("live-1", 1, "caller", "IDENTIFY", "Hi, this is Rosa Delgado. My water heater is leaking."),
    turn("live-1", 2, "agent", "TRIAGE", "Understood, a leaking water heater. Is much water coming out?", { firstWord: 410, total: 1500 }),
    turn("live-1", 3, "caller", "TRIAGE", "Just a little, but it's soaking the garage."),
    turn("live-1", 4, "agent", "SCHEDULE", "We can be there tomorrow between 2 and 6 PM. Does that work?", { firstWord: 520, total: 1800 }),
  ],
  slots: [
    { key: "caller_name", label: "Name", value: "Rosa Delgado", confidence: 0.96, confirmed: false },
    { key: "callback_phone", label: "Callback", value: "+1 (305) 555-7781", confidence: 1, confirmed: false },
    { key: "problem_description", label: "Problem", value: "Water heater leaking into the garage", confidence: 0.91, confirmed: false },
    { key: "urgency", label: "Urgency", value: "Same day", confidence: 0.88, confirmed: false },
    { key: "service_address", label: "Address", value: "1247 Calle Ocho, Miami, FL 33135", confidence: 0.79, confirmed: false },
  ],
};

/** Spells her surname. The read-back is what stops a mis-transcribed name reaching the CRM. */
const bookedSpelledName: DemoCall = {
  record: record("call-2", "2026-07-08T16:10:00.000Z", "BOOKED", ["en"], "+13055552210"),
  callerName: "Marisol Peña",
  summary: "No hot water since last night",
  state: "CLOSE",
  turns: [
    turn("call-2", 0, "agent", "GREETING", "Rivera Plumbing, you're speaking with an automated assistant. How can I help?", { firstWord: 340, total: 1500 }),
    turn("call-2", 1, "caller", "IDENTIFY", "There's been no hot water since last night."),
    turn("call-2", 2, "agent", "IDENTIFY", "Happy to help. Can I get your name?", { firstWord: 390, total: 1400 }),
    turn("call-2", 3, "caller", "IDENTIFY", "Marisol Peña. P-E-Ñ-A."),
    turn("call-2", 4, "agent", "QUALIFY", "Thank you. What's the service address?", { firstWord: 420, total: 1500 }),
    turn("call-2", 5, "caller", "QUALIFY", "It's 830 Southwest Eighth Street."),
    turn("call-2", 6, "agent", "CONFIRM", "Confirming: 830 SW 8th Street, Miami, 33130. Is that right?", { firstWord: 610, total: 1900, bargeIn: true }),
    turn("call-2", 7, "caller", "CONFIRM", "Yes, that's right."),
  ],
  slots: [
    { key: "caller_name", label: "Name", value: "Marisol Peña", confidence: 0.94, confirmed: true },
    { key: "callback_phone", label: "Callback", value: "+1 (305) 555-2210", confidence: 1, confirmed: true },
    { key: "problem_description", label: "Problem", value: "No hot water since last night", confidence: 0.93, confirmed: false },
    { key: "urgency", label: "Urgency", value: "Same day", confidence: 0.9, confirmed: false },
    { key: "service_address", label: "Address", value: "830 SW 8th St, Miami, FL 33130", confidence: 0.88, confirmed: true },
    { key: "appointment_window", label: "Window", value: "Thu Jul 9, 2:00–6:00 PM", confidence: 0.97, confirmed: true },
  ],
};

const bookedEnglish: DemoCall = {
  record: record("call-3", "2026-07-08T15:02:00.000Z", "BOOKED", ["en"], "+17865550143"),
  callerName: "Daniel Okafor",
  summary: "Kitchen sink drain backing up",
  state: "CLOSE",
  turns: [
    turn("call-3", 0, "agent", "GREETING", "Rivera Plumbing, you're speaking with an automated assistant. How can I help?", { firstWord: 360, total: 1500 }),
    turn("call-3", 1, "caller", "TRIAGE", "My kitchen sink is backing up, it's pretty slow."),
    turn("call-3", 2, "agent", "IDENTIFY", "Got it. Can I get your name?", { firstWord: 300, total: 1200 }),
    turn("call-3", 3, "caller", "IDENTIFY", "Daniel Okafor."),
    turn("call-3", 4, "agent", "SCHEDULE", "We have Friday, 9 AM to noon. Does that work?", { firstWord: 440, total: 1600 }),
    turn("call-3", 5, "caller", "SCHEDULE", "Actually make it the afternoon if you can."),
    turn("call-3", 6, "agent", "CONFIRM", "Friday, 1 to 5 PM at 4120 Ponce de Leon. Correct?", { firstWord: 480, total: 1700 }),
  ],
  slots: [
    { key: "caller_name", label: "Name", value: "Daniel Okafor", confidence: 0.97, confirmed: false },
    { key: "callback_phone", label: "Callback", value: "+1 (786) 555-0143", confidence: 1, confirmed: true },
    { key: "problem_description", label: "Problem", value: "Kitchen sink drain backing up", confidence: 0.95, confirmed: false },
    { key: "urgency", label: "Urgency", value: "Routine", confidence: 0.92, confirmed: false },
    { key: "service_address", label: "Address", value: "4120 Ponce de Leon Blvd, Coral Gables, FL 33146", confidence: 0.93, confirmed: true },
    {
      key: "appointment_window",
      label: "Window",
      value: "Fri Jul 10, 1:00–5:00 PM",
      confidence: 0.96,
      confirmed: true,
      previous: "Fri Jul 10, 9:00 AM–12:00 PM",
    },
  ],
};

/**
 * The product is English-only. The emergency classifier is not, on purpose.
 * She reverted to her first language the moment she smelled gas, and we still
 * got her out of the house. See `plan.md` principle #4.
 */
const emergency: DemoCall = {
  record: record("call-4", "2026-07-08T14:38:00.000Z", "ESCALATED_EMERGENCY", ["en"], "+13055559902"),
  callerName: "Unknown caller",
  summary: "Caller reported a gas smell in the kitchen",
  state: "HANDOFF",
  escalationReason: "EMERGENCY_HAZARD",
  hazard: {
    category: "GAS_LEAK",
    action: "DIAL_911_GUIDANCE",
    matchedText: "huele a gas",
    ruleId: "gas.smell.cooccurrence",
  },
  turns: [
    turn("call-4", 0, "agent", "GREETING", "Rivera Plumbing, you're speaking with an automated assistant.", { firstWord: 350, total: 1500 }),
    turn("call-4", 1, "caller", "IDENTIFY", "Huele a gas en la cocina, no sé qué hacer."),
    turn("call-4", 2, "agent", "EMERGENCY", "Leave the house now and call 911. I'm connecting you to a person.", { firstWord: 290, total: 1300 }),
  ],
  slots: [
    { key: "problem_description", label: "Problem", value: "Gas smell in the kitchen", confidence: 0.82, confirmed: false },
  ],
};

const outOfArea: DemoCall = {
  record: record("call-5", "2026-07-08T13:20:00.000Z", "OUT_OF_SERVICE_AREA", ["en"], "+19545550077"),
  callerName: "Priya Raman",
  summary: "Address in Fort Lauderdale — outside the service polygon",
  state: "HANDOFF",
  escalationReason: "OUT_OF_SERVICE_AREA",
  turns: [
    turn("call-5", 0, "agent", "GREETING", "Rivera Plumbing, you're speaking with an automated assistant.", { firstWord: 330, total: 1400 }),
    turn("call-5", 1, "caller", "QUALIFY", "I'm at 1500 Las Olas Boulevard in Fort Lauderdale."),
    turn("call-5", 2, "agent", "HANDOFF", "That's outside our service area — I'm sorry. Let me give you a number that covers Broward.", { firstWord: 700, total: 1900 }),
  ],
  slots: [
    { key: "caller_name", label: "Name", value: "Priya Raman", confidence: 0.95, confirmed: false },
    { key: "service_address", label: "Address", value: "1500 E Las Olas Blvd, Fort Lauderdale, FL 33301", confidence: 0.94, confirmed: false },
  ],
};

/** The one call that went badly: the agent was slow, and the caller left. */
const hungUp: DemoCall = {
  record: record("call-6", "2026-07-08T12:04:00.000Z", "CALLER_HUNG_UP", ["en"], "+13055554417"),
  callerName: "Unknown caller",
  summary: "Hung up during a slow greeting",
  state: "CLOSE",
  turns: [
    turn("call-6", 0, "agent", "GREETING", "Rivera Plumbing, you're speaking with an automated assistant.", { firstWord: 1_450, total: 3_200 }),
  ],
  slots: [],
};

/* -------------------------------------------------------------------------- */
/* The routine bookings that make up most of a day                             */
/* -------------------------------------------------------------------------- */

interface RoutineSpec {
  readonly id: string;
  readonly at: string;
  readonly name: string;
  readonly summary: string;
  readonly from: string;
  readonly address: string;
  readonly window: string;
  readonly timings: readonly Timing[];
}

/**
 * Three turns each: greet, capture, confirm. Enough to be counted honestly in
 * the latency and turn-taking figures without pretending we transcribed a
 * novel.
 */
function routine(spec: RoutineSpec): DemoCall {
  const [greet, capture, confirm] = spec.timings;
  return {
    record: record(spec.id, spec.at, "BOOKED", ["en"], spec.from),
    callerName: spec.name,
    summary: spec.summary,
    state: "CLOSE",
    turns: [
      turn(spec.id, 0, "agent", "GREETING", "Rivera Plumbing, you're speaking with an automated assistant.", greet),
      turn(spec.id, 1, "caller", "TRIAGE", spec.summary),
      turn(spec.id, 2, "agent", "QUALIFY", "Understood. What's the service address?", capture),
      turn(spec.id, 3, "caller", "QUALIFY", spec.address),
      turn(spec.id, 4, "agent", "CONFIRM", `Confirming ${spec.address}, ${spec.window}. Correct?`, confirm),
      turn(spec.id, 5, "caller", "CONFIRM", "That's right."),
    ],
    slots: [
      { key: "caller_name", label: "Name", value: spec.name, confidence: 0.96, confirmed: false },
      { key: "callback_phone", label: "Callback", value: spec.from, confidence: 1, confirmed: true },
      { key: "problem_description", label: "Problem", value: spec.summary, confidence: 0.94, confirmed: false },
      { key: "urgency", label: "Urgency", value: "Routine", confidence: 0.93, confirmed: false },
      { key: "service_address", label: "Address", value: spec.address, confidence: 0.92, confirmed: true },
      { key: "appointment_window", label: "Window", value: spec.window, confidence: 0.96, confirmed: true },
    ],
  };
}

const ROUTINE: readonly DemoCall[] = [
  routine({
    id: "call-7", at: "2026-07-08T17:05:00.000Z", name: "Ibrahim Sow",
    summary: "Sump pump isn't kicking on", from: "+13055556620",
    address: "745 NE 79th St, Miami, FL 33138", window: "Fri Jul 10, 8:00–11:00 AM",
    timings: [{ firstWord: 355, total: 1450 }, { firstWord: 420, total: 1600 }, { firstWord: 505, total: 1750 }],
  }),
  routine({
    id: "call-8", at: "2026-07-08T16:35:00.000Z", name: "Hannah Cole",
    summary: "Annual maintenance visit", from: "+13055551188",
    address: "218 Malaga Ave, Coral Gables, FL 33134", window: "Mon Jul 13, 1:00–4:00 PM",
    timings: [{ firstWord: 322, total: 1310 }, { firstWord: 388, total: 1520 }, { firstWord: 610, total: 1880, bargeIn: true }],
  }),
  routine({
    id: "call-9", at: "2026-07-08T15:40:00.000Z", name: "Javier Ortiz",
    summary: "Low water pressure upstairs", from: "+13055557734",
    address: "3410 SW 22nd St, Miami, FL 33145", window: "Thu Jul 9, 9:00 AM–12:00 PM",
    // The one turn all day where the agent simply did not answer.
    timings: [{ firstWord: 341, total: 1400 }, { firstWord: 0, total: 0, missed: true }, { firstWord: 470, total: 1690 }],
  }),
  routine({
    id: "call-10", at: "2026-07-08T14:12:00.000Z", name: "Beatrice Adeyemi",
    summary: "Leaking outdoor spigot", from: "+17865559041",
    address: "1290 NW 54th St, Miami, FL 33142", window: "Fri Jul 10, 1:00–4:00 PM",
    timings: [{ firstWord: 368, total: 1470 }, { firstWord: 402, total: 1580 }, { firstWord: 533, total: 1810 }],
  }),
  routine({
    id: "call-11", at: "2026-07-08T13:55:00.000Z", name: "Carlos Mendoza",
    summary: "Garbage disposal is jammed", from: "+13055553390",
    address: "922 SW 12th Ave, Miami, FL 33130", window: "Thu Jul 9, 3:00–6:00 PM",
    timings: [{ firstWord: 349, total: 1420 }, { firstWord: 915, total: 1900, bargeIn: true }, { firstWord: 488, total: 1720 }],
  }),
  routine({
    id: "call-12", at: "2026-07-08T12:31:00.000Z", name: "Nguyen Thi Lan",
    summary: "Slow bathroom drain", from: "+13055558812",
    address: "6100 Biscayne Blvd, Miami, FL 33137", window: "Mon Jul 13, 8:00–11:00 AM",
    timings: [{ firstWord: 334, total: 1380 }, { firstWord: 396, total: 1550 }, { firstWord: 512, total: 1770 }],
  }),
  routine({
    id: "call-13", at: "2026-07-08T11:48:00.000Z", name: "Greg Whitman",
    summary: "Water heater pilot won't stay lit", from: "+17865552204",
    address: "455 Grand Bay Dr, Key Biscayne, FL 33149", window: "Thu Jul 9, 1:00–4:00 PM",
    timings: [{ firstWord: 377, total: 1490 }, { firstWord: 441, total: 1630 }, { firstWord: 1_000, total: 1_895, bargeIn: true }],
  }),
  routine({
    id: "call-14", at: "2026-07-08T11:15:00.000Z", name: "Alicia Fuentes",
    summary: "Toilet running constantly", from: "+13055550098",
    address: "1580 NW 27th Ave, Miami, FL 33125", window: "Fri Jul 10, 8:00–11:00 AM",
    timings: [{ firstWord: 361, total: 1440 }, { firstWord: 409, total: 1590 }, { firstWord: 496, total: 1740 }],
  }),
];

/** Newest first — the order a dispatcher reads them in. */
export const CALLS: readonly DemoCall[] = [
  live,
  bookedSpelledName,
  bookedEnglish,
  emergency,
  outOfArea,
  hungUp,
  ...ROUTINE,
].sort((a, b) => Date.parse(b.record.startedAt) - Date.parse(a.record.startedAt));

export const byId = (id: string): DemoCall | undefined =>
  CALLS.find((c) => c.record.id === id);

/* -------------------------------------------------------------------------- */
/* Derived                                                                     */
/* -------------------------------------------------------------------------- */

export const LIVE_CALLS = CALLS.filter((c) => c.record.outcome === null);
export const BOOKED = CALLS.filter((c) => c.record.outcome === "BOOKED");
export const FINISHED = CALLS.filter((c) => c.record.outcome !== null).length;
export const HANDLED_WITHOUT_HUMAN = BOOKED.length;

/** Calls a human still owes something to. The only actionable queue. */
export const NEEDS_ATTENTION = CALLS.filter(
  (c) =>
    c.record.outcome === "ESCALATED_EMERGENCY" ||
    c.record.outcome === "ESCALATED_OTHER" ||
    c.record.outcome === "AGENT_ERROR",
);

/**
 * Ground truth: of the ten jobs we created, the contractor had to fix one
 * address after dispatch.
 *
 * This is the only reliability number that matters, and it is why the dashboard
 * shows a correction rate rather than a satisfaction score.
 */
const OUTCOMES: readonly BookingOutcome[] = BOOKED.map((call, index) => ({
  bookingId: `booking-${call.record.id}`,
  cancelled: false,
  correctedFields:
    index === 1 ? { service_address: "4120 Ponce de Leon Blvd Apt 2" } : {},
  // We poll rather than trust a webhook: a missed webhook reports a 0%
  // correction rate, which is exactly the number a dishonest vendor publishes.
  source: index === 1 ? "CONTRACTOR_DASHBOARD" : "CRM_POLL",
  // Step 6's nightly pass looked at the one correction and called it ours; the
  // weekly human audit looked at the same diff and agreed. It changes nothing
  // about what we publish yet — one audited label is not evidence, and
  // `publishedCorrectionRate()` says so out loud rather than quietly using it.
  classification: index === 1 ? "agent_error" : null,
  humanLabel: index === 1 ? "agent_error" : null,
  observedAt: "2026-07-08T18:30:00.000Z",
}));

export const METRICS = computeMetrics({
  calls: CALLS.map((c) => c.record),
  turns: CALLS.flatMap((c) => [...c.turns]),
  outcomes: OUTCOMES,
  committedBookings: BOOKED.length,
});

/**
 * The number we are *entitled* to show, and why (plan, Step 6.3).
 *
 * With one audited correction, the answer is the raw rate: the classifier has not
 * earned the right to lower it. The dashboard prints the reason next to the
 * figure, because a contractor being shown a reliability number deserves to know
 * which one it is.
 */
export const PUBLISHED = publishedCorrectionRate(METRICS);

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

export function clockTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TENANT.timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export const pct = (value: number): string => `${Math.round(value * 100)}%`;

export const ms = (value: number): string =>
  value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;

export const ESCALATION_COPY: Record<EscalationReason, string> = {
  EMERGENCY_HAZARD: "Emergency — transferred to a human",
  OUT_OF_SERVICE_AREA: "Outside the service area",
  CALLER_REQUESTED_HUMAN: "Caller asked for a person",
  REPEATED_EXTRACTION_FAILURE: "Agent could not understand the caller",
  AGENT_ERROR: "Agent error",
};
