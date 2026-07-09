import { realSleep, type Sleep } from "@ledgerline/contracts";
import { CrmError } from "@ledgerline/crm";

/**
 * A durable, step-based transaction with compensating rollback.
 *
 * This is the "verification, retries, state rollback" middleware that
 * `idea.md` §2.1 says the benchmark gap calls for. The LLM never orchestrates
 * it — by the time this runs the call is over and every slot is validated.
 *
 * The engine is deliberately independent of Vercel WDK: `Journal` is the seam.
 * An in-memory journal makes the whole thing testable in microseconds, and a
 * WDK- or Postgres-backed journal makes it survive a crash. Nothing else
 * changes.
 */

export interface JournalEntry {
  readonly step: string;
  readonly output: unknown;
}

export interface Journal {
  /** Output of `step` if it already completed, else `undefined`. */
  completed(step: string): Promise<{ output: unknown } | undefined>;
  record(entry: JournalEntry): Promise<void>;
  /** Steps whose compensation has run, so rollback is itself idempotent. */
  markCompensated(step: string): Promise<void>;
  isCompensated(step: string): Promise<boolean>;
}

export class InMemoryJournal implements Journal {
  private readonly outputs = new Map<string, unknown>();
  private readonly compensated = new Set<string>();

  async completed(step: string): Promise<{ output: unknown } | undefined> {
    return this.outputs.has(step) ? { output: this.outputs.get(step) } : undefined;
  }

  async record(entry: JournalEntry): Promise<void> {
    this.outputs.set(entry.step, entry.output);
  }

  async markCompensated(step: string): Promise<void> {
    this.compensated.add(step);
  }

  async isCompensated(step: string): Promise<boolean> {
    return this.compensated.has(step);
  }

  /** Test/debug view of what actually ran. */
  get steps(): string[] {
    return [...this.outputs.keys()];
  }
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
};

/**
 * Only transient failures are retried. Retrying a 400 burns the contractor's
 * rate limit to no purpose; giving up on a 429 loses a booked job.
 */
export function isTransient(error: unknown): boolean {
  return error instanceof CrmError && error.retryable;
}

/** Compensation failed, so the CRM is in an unknown state. A human must look. */
export class RollbackFailure extends Error {
  constructor(
    readonly step: string,
    override readonly cause: unknown,
    /** The failure that triggered the rollback, distinct from why undo failed. */
    readonly original: unknown,
  ) {
    super(`compensation for "${step}" failed`);
    this.name = "RollbackFailure";
  }
}

interface Compensation {
  readonly step: string;
  readonly run: () => Promise<void>;
}

export interface SagaOptions {
  readonly journal: Journal;
  readonly retry?: RetryPolicy;
  readonly sleep?: Sleep;
}

export class Saga {
  private readonly compensations: Compensation[] = [];
  private readonly journal: Journal;
  private readonly retry: RetryPolicy;
  private readonly sleep: Sleep;

  constructor(options: SagaOptions) {
    this.journal = options.journal;
    this.retry = options.retry ?? DEFAULT_RETRY;
    this.sleep = options.sleep ?? realSleep;
  }

  /**
   * Run `execute` unless the journal says it already succeeded, in which case
   * return the recorded output without touching the network. This is what makes
   * a crashed workflow safe to re-run: the customer created before the crash is
   * not created twice.
   *
   * `compensate` is registered *after* the step succeeds, so we never try to
   * undo work that never happened.
   */
  async step<T>(
    name: string,
    execute: () => Promise<T>,
    compensate?: (output: T) => Promise<void>,
  ): Promise<T> {
    const already = await this.journal.completed(name);
    if (already) {
      const output = already.output as T;
      if (compensate) {
        this.compensations.push({ step: name, run: () => compensate(output) });
      }
      return output;
    }

    const output = await this.attempt(name, execute);
    await this.journal.record({ step: name, output });

    if (compensate) {
      this.compensations.push({ step: name, run: () => compensate(output) });
    }
    return output;
  }

  private async attempt<T>(name: string, execute: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
      try {
        return await execute();
      } catch (error) {
        lastError = error;
        if (!isTransient(error) || attempt === this.retry.maxAttempts) break;

        // Exponential backoff, capped. No jitter: the delays are asserted in
        // tests, and a single booking is not a thundering herd.
        const delay = Math.min(
          this.retry.baseDelayMs * 2 ** (attempt - 1),
          this.retry.maxDelayMs,
        );
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  /**
   * Undo completed steps in reverse order.
   *
   * Rollback is itself idempotent and crash-safe: a compensation already
   * recorded in the journal is skipped, so re-running a half-rolled-back
   * workflow does not cancel a job twice.
   */
  async rollback(original: unknown): Promise<void> {
    for (const compensation of [...this.compensations].reverse()) {
      if (await this.journal.isCompensated(compensation.step)) continue;

      try {
        await compensation.run();
      } catch (error) {
        // Stop at the first failure. Continuing would compound an unknown CRM
        // state, and the steps below us are the ones we understand least.
        throw new RollbackFailure(compensation.step, error, original);
      }
      await this.journal.markCompensated(compensation.step);
    }
  }
}
