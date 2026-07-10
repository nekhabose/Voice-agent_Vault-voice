import type { Effect, Utterer, UtteranceContext } from "@ledgerline/contracts";
import type { Phraser } from "./llm.js";

export interface SpokenLine {
  readonly effect: Effect;
  readonly ctx: UtteranceContext;
  readonly line: string;
}

/**
 * A deterministic, machine-readable utterer for tests that care *which* effect
 * was spoken rather than how it sounded.
 *
 * `eval` binds this rather than `CachedUtterer`: a scenario asserting on real
 * customer prose fails the day someone improves a comma, which teaches the team
 * to ignore red. Assertions go against `spoken`, in the repo's convention —
 * what the collaborator saw, never a mocking framework.
 */
export class TemplateUtterer implements Utterer {
  readonly spoken: SpokenLine[] = [];

  async say(effect: Effect, ctx: UtteranceContext): Promise<string> {
    const line = render(effect);
    this.spoken.push({ effect, ctx, line });
    return line;
  }

  get lines(): string[] {
    return this.spoken.map((s) => s.line);
  }
}

function render(effect: Effect): string {
  switch (effect.type) {
    case "GREET":
      return "[GREET]";
    case "ASK_FOR":
      return `[ASK_FOR ${effect.key}]`;
    case "READ_BACK":
      return `[READ_BACK ${effect.key}]`;
    case "ESCALATE":
      return `[ESCALATE ${effect.reason} ${effect.action}]`;
    case "CREATE_PENDING_BOOKING":
      return "[CREATE_PENDING_BOOKING]";
  }
}

/** Scripted lines, in order, then it repeats the last one. Records the prompts. */
export class FakePhraser implements Phraser {
  readonly prompts: string[] = [];

  constructor(private readonly lines: readonly string[] = [], private readonly failWith?: Error) {}

  async phrase(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    if (this.failWith) throw this.failWith;
    const index = Math.min(this.prompts.length - 1, this.lines.length - 1);
    return this.lines[index] ?? "";
  }
}
