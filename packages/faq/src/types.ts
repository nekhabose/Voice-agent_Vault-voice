import type { FaqEntry } from "@ledgerline/contracts";

/**
 * The two ports retrieval needs, and neither of them is a model SDK.
 *
 * `packages/utterance` set this precedent with `Phraser`: a package that needs a
 * model reaches it through a local port, and only the package whose *job* is
 * that model call constructs a client. Here the model call is the selection, and
 * `AnthropicFaqAnswerer` owns it. Embedding and vector search are somebody
 * else's infrastructure, so they are ports.
 */

/** An entry with the vector `pgvector` searches on. */
export interface IndexedFaqEntry extends FaqEntry {
  /** Exactly `FAQ_EMBEDDING_DIMENSIONS` numbers. See `contracts/faq.ts`. */
  readonly embedding: readonly number[];
}

export interface RetrievedFaqEntry {
  readonly entry: FaqEntry;
  /** Cosine similarity, `-1..1`. Higher is closer. */
  readonly score: number;
}

/**
 * Turns a caller's question into a vector.
 *
 * **Nothing in this repo binds a real one.** Anthropic has no embeddings
 * endpoint, and picking a vendor here without a credential to test against would
 * be guessing at a wire format — the failure mode `CLAUDE.md` names for the
 * Google geocoder and the CRM adapters. `HashingEmbedder` is what the tests and
 * the dashboard use; the production binding lands with the database (Step 7),
 * because a retrieval index with nowhere to live is not a retrieval index.
 */
export interface Embedder {
  embed(text: string): Promise<readonly number[]>;
}

/**
 * Vector search over one tenant's FAQ.
 *
 * `InMemoryFaqIndex` is the tested implementation; the `pgvector` one is Step 7,
 * and this port is the seam it slots into. Tenant-scoped in the signature rather
 * than in a `WHERE` clause somebody remembers to write: an FAQ answer leaking
 * across tenants would speak one contractor's prices to another's caller.
 */
export interface FaqIndex {
  search(
    tenantId: string,
    embedding: readonly number[],
    limit: number,
  ): Promise<readonly RetrievedFaqEntry[]>;
}
