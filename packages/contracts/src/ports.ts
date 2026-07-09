/**
 * Ports shared across packages. Kept here so nobody reaches into a sibling
 * package for a two-line interface, and so tests never depend on ambient
 * global state.
 */

/** Injected so nothing in the system reads the wall clock directly. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso) });

/** Injected so retry backoff does not make the test suite slow. */
export type Sleep = (milliseconds: number) => Promise<void>;

export const realSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Records the delays it was asked for, then returns instantly. */
export function recordingSleep(): Sleep & { delays: number[] } {
  const delays: number[] = [];
  const sleep = (async (ms: number) => {
    delays.push(ms);
  }) as Sleep & { delays: number[] };
  sleep.delays = delays;
  return sleep;
}
