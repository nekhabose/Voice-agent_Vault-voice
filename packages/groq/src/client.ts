import Groq from "groq-sdk";

/**
 * The client factory, and the one trap it exists to neutralise.
 *
 * `groq-sdk` builds every request path as `${baseURL}/openai/v1/chat/completions`.
 * The base URL it wants is therefore the **host**, `https://api.groq.com` — and
 * the URL printed on every page of Groq's own documentation, the one anybody
 * copying an OpenAI-compatible config will paste, is
 * `https://api.groq.com/openai/v1`. Set that and the SDK appends its own path to
 * yours: `POST /openai/v1/openai/v1/chat/completions`, which comes back `404
 * unknown_url` for *every* call, including the ones that would have worked.
 *
 * Worse, the SDK reads `GROQ_BASE_URL` from the environment on its own when you
 * do not pass one, so a `.env` written the documented way poisons a client that
 * never mentioned a base URL. So this factory always passes an explicit,
 * normalised value, and normalisation is idempotent: host or full path, either
 * works, and neither can double-append.
 *
 * We found this by measurement — every SDK call 404'd while a raw `fetch` to the
 * same endpoint succeeded — which is the only way anybody finds it, because the
 * failure looks like a wrong endpoint rather than a wrong configuration.
 */

export const GROQ_HOST = "https://api.groq.com";

/** Strip the OpenAI-compat path the SDK is about to append itself. */
export function normalizeBaseUrl(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return GROQ_HOST;
  return trimmed.replace(/\/+$/, "").replace(/\/openai\/v1$/, "") || GROQ_HOST;
}

export interface GroqClientOptions {
  readonly apiKey: string;
  /** Defaults to `GROQ_BASE_URL`, normalised. Either form is accepted. */
  readonly baseURL?: string;
  readonly maxRetries?: number;
}

export function groqClient(options: GroqClientOptions): Groq {
  return new Groq({
    apiKey: options.apiKey,
    baseURL: normalizeBaseUrl(options.baseURL ?? process.env["GROQ_BASE_URL"]),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
  });
}
