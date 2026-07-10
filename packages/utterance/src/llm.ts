import type {
  Effect,
  SlotKey,
  Utterer,
  UtteranceContext,
} from "@ledgerline/contracts";
import { SLOT_SPECS } from "@ledgerline/contracts";
import { CATALOG, type UtteranceCatalog } from "./catalog.js";
import { CachedUtterer } from "./cached.js";

/**
 * Somewhere to draft new phrasings. **Not what ships.**
 *
 * `LlmUtterer` exists so an engineer can hear twenty ways of asking for a ZIP
 * code before choosing one and committing it to `catalog.ts`. In production it
 * would put a model in the audio path — the thing §10.2 exists to prevent.
 */

/**
 * A local port, in the repo's convention: this package never imports a model
 * SDK. The only `@anthropic-ai/sdk` in the tree lives in `packages/extraction`,
 * and it stays there.
 */
export interface Phraser {
  phrase(prompt: string): Promise<string>;
}

/** The model §10.2 names for build-time wording. Correctness over latency. */
export const UTTERANCE_MODEL = "claude-opus-4-8";

/** Longer than this is a model monologuing, not asking a question. */
const MAX_SPOKEN_CHARS = 200;

export interface LlmUttererOptions {
  readonly phraser: Phraser;
  readonly catalog?: UtteranceCatalog;
}

export class LlmUtterer implements Utterer {
  private readonly phraser: Phraser;
  private readonly catalog: UtteranceCatalog;
  private readonly cached: CachedUtterer;

  constructor(options: LlmUttererOptions) {
    this.phraser = options.phraser;
    this.catalog = options.catalog ?? CATALOG;
    this.cached = new CachedUtterer(this.catalog);
  }

  /**
   * **Only `ASK_FOR` may be paraphrased.** Not by policy — by construction, so
   * that a well-meaning edit to widen it has to delete this comment first.
   *
   * - `GREET` carries the AI disclosure, which is legal text. A model that
   *   rewords it has invented a disclosure nobody reviewed.
   * - `READ_BACK` is the verification step. A model that "naturally" rephrases
   *   `1247 Calle Ocho` as `1247 SW 8th St` gets a yes to an address the caller
   *   never gave, and books a truck to it.
   * - `ESCALATE` carries life-safety guidance. It is read to someone who may be
   *   standing in a room filling with gas.
   * - `CREATE_PENDING_BOOKING` promises an SMS to a specific number.
   *
   * Each of those is a sentence whose *content* is load-bearing. The wording of
   * "what's your name?" is not.
   */
  async say(effect: Effect, ctx: UtteranceContext): Promise<string> {
    if (effect.type !== "ASK_FOR") return this.cached.say(effect, ctx);

    const baseline = this.cached.line(effect, ctx);
    let drafted: string;
    try {
      drafted = await this.phraser.phrase(this.prompt(effect.key, ctx, baseline));
    } catch {
      // A dev-time convenience must not fail a dev-time call.
      return baseline;
    }
    return usable(drafted) ? drafted.trim() : baseline;
  }

  prompt(key: SlotKey, ctx: UtteranceContext, baseline: string): string {
    return [
      `You are drafting one line for a phone agent answering calls for ${ctx.businessName},`,
      `a US home-services contractor. The agent needs the caller's ${SLOT_SPECS[key].label}.`,
      ctx.attempt > 0
        ? `The caller has already been asked ${ctx.attempt} time(s) and it did not come through.`
        : `This is the first time the agent asks.`,
      `The committed wording is: "${baseline}"`,
      `Reply with one spoken sentence and nothing else. No quotes, no placeholders, no line breaks.`,
    ].join("\n");
  }
}

/**
 * A drafted line is either speakable or it is discarded. We never repair one —
 * a model that returned `{value}` or three paragraphs was not doing the task,
 * and the catalog line is right there.
 */
function usable(drafted: string): boolean {
  const line = drafted.trim();
  if (line === "") return false;
  if (line.length > MAX_SPOKEN_CHARS) return false;
  if (line.includes("\n")) return false;
  return !/[{}]/.test(line);
}
