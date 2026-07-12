import { FAQ_EMBEDDING_DIMENSIONS } from "@ledgerline/contracts";
import type { Embedder, FaqIndex, IndexedFaqEntry, RetrievedFaqEntry } from "./types.js";

/**
 * Retrieval without a database.
 *
 * `pgvector` is the production index (plan, §4), and it does not exist yet —
 * `packages/db` has a schema nobody has applied. This is the same brute-force
 * cosine search over the same vectors, which is what an HNSW index approximates,
 * so the *answerer* above it is exercised for real. When the Neon instance
 * exists, `PgVectorFaqIndex` implements the same port and this stays as the test
 * double.
 */
export class InMemoryFaqIndex implements FaqIndex {
  constructor(private readonly entries: readonly IndexedFaqEntry[]) {
    for (const entry of entries) {
      if (entry.embedding.length !== FAQ_EMBEDDING_DIMENSIONS) {
        // The dimension mismatch pgvector would reject at insert time, caught
        // where the fixture is written rather than where the query runs.
        throw new Error(
          `FAQ entry ${entry.id}: ${entry.embedding.length}-dimension embedding, expected ${FAQ_EMBEDDING_DIMENSIONS}`,
        );
      }
    }
  }

  async search(
    tenantId: string,
    embedding: readonly number[],
    limit: number,
  ): Promise<readonly RetrievedFaqEntry[]> {
    return this.entries
      .filter((entry) => entry.tenantId === tenantId)
      .map(({ embedding: vector, ...entry }) => ({
        entry,
        score: cosine(embedding, vector),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

/** `-1..1`. Zero for a zero vector: a question of pure stop-words matches nothing. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * A deterministic bag-of-words embedder: hash each token into one of
 * `FAQ_EMBEDDING_DIMENSIONS` buckets, count, normalise.
 *
 * **This is not the production embedder, and it is not pretending to be.** It has
 * no semantics — "how much do you charge" and "what does it cost" share no
 * tokens and score zero against each other, which a real embedder would never
 * do. It exists so that the retrieval → selection → verbatim-answer path can be
 * driven end to end, offline, with no credential and no vendor guess, exactly as
 * `FakeGeocoder` stands in for Google. Swap it for the real one in Step 7, when
 * there is a database to hold the vectors it produces.
 */
export class HashingEmbedder implements Embedder {
  async embed(text: string): Promise<readonly number[]> {
    const vector = new Array<number>(FAQ_EMBEDDING_DIMENSIONS).fill(0);
    for (const token of tokenize(text)) {
      vector[fnv1a(token) % FAQ_EMBEDDING_DIMENSIONS]! += 1;
    }
    return vector;
  }
}

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "");

/** FNV-1a, 32-bit. Any stable hash would do; this one is four lines. */
function fnv1a(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
