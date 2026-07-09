import type { TimeWindow } from "@ledgerline/contracts";
import { accepted, rejected, type Clock, type Validation } from "./types.js";

/** One opening interval, in the tenant's local time. `dow`: 0 = Sunday. */
export interface BusinessHours {
  readonly dow: number;
  /** `"08:00"`, local. */
  readonly open: string;
  /** `"18:00"`, local. */
  readonly close: string;
}

export interface WindowPolicy {
  readonly clock: Clock;
  /** IANA zone, e.g. `America/New_York`. Tenants are not all in one zone. */
  readonly timeZone: string;
  readonly hours: readonly BusinessHours[];
  /** Do not book a truck less than this far out. */
  readonly minLeadMinutes?: number;
  readonly maxDaysAhead?: number;
  readonly minDurationMinutes?: number;
  /** Emergencies may be booked outside opening hours. */
  readonly allowAfterHours?: boolean;
}

const DEFAULTS = {
  minLeadMinutes: 60,
  maxDaysAhead: 60,
  minDurationMinutes: 30,
  allowAfterHours: false,
} as const;

/**
 * Local wall-clock parts of an instant, in a given zone.
 *
 * Uses `Intl` rather than a date library: DST, zone abbreviations, and the
 * offset history are already in the platform, and a bad appointment window is
 * a truck arriving on the wrong day.
 */
export function zonedParts(date: Date, timeZone: string): {
  readonly dow: number;
  readonly minutes: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new Error(`missing ${type} for zone ${timeZone}`);
    return Number(found.value);
  };

  // Some ICU builds render midnight as hour 24 under hour12:false.
  const hour = get("hour") % 24;
  const dow = new Date(Date.UTC(get("year"), get("month") - 1, get("day"))).getUTCDay();

  return { dow, minutes: hour * 60 + get("minute") };
}

export function parseHhMm(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`expected HH:MM, got "${value}"`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`"${value}" is not a real time`);
  return hours * 60 + minutes;
}

/**
 * Is this appointment window one we can actually staff?
 *
 * Runs before the window is read back to the caller, so we never confirm a slot
 * we cannot honour.
 */
export function validateWindow(
  window: TimeWindow,
  policy: WindowPolicy,
): Validation<TimeWindow> {
  const config = { ...DEFAULTS, ...policy };
  const start = new Date(window.startsAt);
  const end = new Date(window.endsAt);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return rejected("appointment window is not a real time");
  }

  const durationMinutes = (end.getTime() - start.getTime()) / 60_000;
  if (durationMinutes <= 0) {
    return rejected("appointment window ends before it starts");
  }
  if (durationMinutes < config.minDurationMinutes) {
    return rejected(`window must be at least ${config.minDurationMinutes} minutes`);
  }

  const now = config.clock.now();
  const leadMinutes = (start.getTime() - now.getTime()) / 60_000;
  if (leadMinutes < 0) return rejected("appointment window is in the past");
  if (leadMinutes < config.minLeadMinutes) {
    return rejected(`we need at least ${config.minLeadMinutes} minutes' notice`);
  }

  const daysAhead = (start.getTime() - now.getTime()) / 86_400_000;
  if (daysAhead > config.maxDaysAhead) {
    return rejected(`we do not book more than ${config.maxDaysAhead} days out`);
  }

  if (config.allowAfterHours) return accepted(window);

  const localStart = zonedParts(start, config.timeZone);
  const localEnd = zonedParts(end, config.timeZone);

  // A window that runs past local midnight can never sit inside one opening.
  if (localEnd.dow !== localStart.dow) {
    return rejected("appointment window crosses midnight");
  }

  const opening = config.hours.find(
    (h) =>
      h.dow === localStart.dow &&
      localStart.minutes >= parseHhMm(h.open) &&
      localEnd.minutes <= parseHhMm(h.close),
  );

  if (!opening) return rejected("we are closed during that window");
  return accepted(window);
}

/** Convenience for seeds and tests: the same hours Monday through Friday. */
export function weekdayHours(open: string, close: string): BusinessHours[] {
  return [1, 2, 3, 4, 5].map((dow) => ({ dow, open, close }));
}
