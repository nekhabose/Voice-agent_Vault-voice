import type {
  Embedder,
  FaqIndex,
  IndexedFaqEntry,
  RetrievedFaqEntry,
} from "@ledgerline/contracts";

/**
 * The two ports retrieval needs, and neither of them is a model SDK.
 *
 * `packages/utterance` set this precedent with `Phraser`: a package that needs a
 * model reaches it through a local port, and only the package whose *job* is that
 * model call constructs a client. Here the model call is the selection, and
 * `AnthropicFaqAnswerer` owns it. Embedding and vector search are somebody else's
 * infrastructure, so they are ports.
 *
 * **They moved into `contracts` in Step 7.** `packages/db` implements `FaqIndex` over
 * `pgvector`, and it cannot see a port defined here without depending on this package
 * — the same argument that moved `Effect` into the spine in Step 3 and `HttpTransport`
 * in Step 4. They are re-exported from here, where they are used, so nothing that
 * imports `@ledgerline/faq` had to change.
 */
export type { Embedder, FaqIndex, IndexedFaqEntry, RetrievedFaqEntry };
