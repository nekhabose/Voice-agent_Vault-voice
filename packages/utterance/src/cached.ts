import type {
  Effect,
  SlotKey,
  Utterer,
  UtteranceContext,
} from "@ledgerline/contracts";
import { CATALOG, type UtteranceCatalog } from "./catalog.js";
import { MissingUtteranceValueError, fill, speakPhone, speakSlot } from "./render.js";

/**
 * What ships.
 *
 * Every sentence comes from the committed catalog; nothing is generated, so
 * `say()` performs no I/O and cannot be slow, rate-limited, or creative. The
 * `Promise` is the port's, not this class's — `line()` is the pure function the
 * tests assert on, exactly as `AnthropicExtractor.request()` is.
 */
export class CachedUtterer implements Utterer {
  constructor(private readonly catalog: UtteranceCatalog = CATALOG) {}

  async say(effect: Effect, ctx: UtteranceContext): Promise<string> {
    return this.line(effect, ctx);
  }

  line(effect: Effect, ctx: UtteranceContext): string {
    switch (effect.type) {
      case "GREET":
        return this.greet(ctx);
      case "ASK_FOR":
        return this.ask(effect.key, ctx);
      case "READ_BACK":
        return this.readBack(effect.key, ctx);
      case "ESCALATE":
        return this.escalate(effect, ctx);
      case "CREATE_PENDING_BOOKING":
        return this.close(ctx);
      case "SAY_FILLER":
        return this.catalog.faq.filler;
      case "ANSWER_FAQ":
        return this.answerFaq(effect);
    }
  }

  /**
   * The contractor's committed answer, spoken verbatim — or, when nothing they
   * wrote covers the question, the catalog's promise of a callback.
   *
   * `effect.answer` is the one string this class speaks that does not come from
   * `catalog.ts`, and it is still not generated: it is the contractor's own text,
   * retrieved and selected (plan, §6 call site #3). Wrapping it in words of ours
   * — "Sure! So," — would be us editing an answer about price or policy that
   * they signed off on, so we do not.
   */
  private answerFaq(effect: Extract<Effect, { type: "ANSWER_FAQ" }>): string {
    return effect.answer ?? this.catalog.faq.unknown;
  }

  /** Opening, then the disclosure verbatim, then the invitation. In that order. */
  private greet(ctx: UtteranceContext): string {
    const { opening, disclosure, invitation } = this.catalog.greeting;
    return join([
      fill(opening, { business: ctx.businessName }),
      disclosure,
      invitation,
    ]);
  }

  private ask(key: SlotKey, ctx: UtteranceContext): string {
    const forms = this.catalog.ask[key];
    const template = ctx.attempt > 0 ? forms.reprompt : forms.initial;
    return fill(template, { business: ctx.businessName });
  }

  private readBack(key: SlotKey, ctx: UtteranceContext): string {
    const value = ctx.values[key];
    if (value === undefined) throw new MissingUtteranceValueError(key);
    return fill(this.catalog.readBack[key], {
      value: speakSlot(key, value, ctx.timeZone),
    });
  }

  /**
   * Guidance first, then why, then the transfer. A caller who smells gas is
   * told to leave the building *before* they are told to hold — the ordering is
   * the point, and it is why `DIAL_911_GUIDANCE` is an action rather than a
   * hangup.
   */
  private escalate(
    effect: Extract<Effect, { type: "ESCALATE" }>,
    ctx: UtteranceContext,
  ): string {
    const reason = effect.hazard
      ? this.catalog.hazardGuidance[effect.hazard.category]
      : fill(this.catalog.escalation[effect.reason], {
          business: ctx.businessName,
        });

    return join([reason, this.catalog.transfer[effect.action]]);
  }

  private close(ctx: UtteranceContext): string {
    const phone = ctx.values.callback_phone;
    if (phone === undefined) {
      throw new MissingUtteranceValueError("callback_phone");
    }
    return fill(this.catalog.closing, {
      business: ctx.businessName,
      phone: speakPhone(phone),
    });
  }
}

const join = (parts: readonly string[]): string => parts.join(" ");
