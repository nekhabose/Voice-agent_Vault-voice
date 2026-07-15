import { z } from "zod";

/**
 * The contractor's own answers to the questions callers actually ask: what a
 * service call costs, whether the estimate is free, which brands they service,
 * whether they take card.
 *
 * **The answer is a committed string, and a model never writes one** (plan, §6
 * call site #3). Retrieval finds candidates, a model *selects* the one that
 * responds to the question, and the caller hears the contractor's own words
 * verbatim. The alternative — a model composing an answer from retrieved
 * context — is a model quoting a price nobody approved, on a recorded line, to
 * someone who will hold us to it. Selection is a classification; composition is
 * a liability.
 */
export const FaqEntrySchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  /** What a caller asks, as the contractor imagines them asking it. */
  question: z.string().min(1),
  /** What the agent says back, word for word. Reviewed by the contractor. */
  answer: z.string().min(1),
});
export type FaqEntry = z.infer<typeof FaqEntrySchema>;

/**
 * The width of the retrieval vector, defined once because two packages must
 * agree on it and disagreeing is a runtime error nobody sees until an insert
 * fails: `packages/db`'s `faq_entries.embedding` is a `vector(n)` column, and
 * `packages/faq`'s `Embedder` must emit exactly `n` numbers.
 */
export const FAQ_EMBEDDING_DIMENSIONS = 1024;
