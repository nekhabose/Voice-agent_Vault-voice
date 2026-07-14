import Groq from "groq-sdk";
import type { ChatCompletionCreateParamsNonStreaming } from "groq-sdk/resources/chat/completions";

/**
 * A transport fake for the Groq SDK, in the shape `@ledgerline/anthropic` uses its
 * own: it records what the collaborator *saw* and answers from a handler. Tests
 * assert on `requests`, never on a mocking framework.
 *
 * The seam is the SDK's injectable `fetch`, for the same reason as the Anthropic
 * one: the things that go wrong with a model binding are properties of the bytes
 * on the wire — a reasoning model left reasoning, a request built in a mode this
 * model rejects, a schema that is not the one the contract describes — and a
 * hand-rolled port would let us assert on the arguments we passed to ourselves.
 *
 * Zero live model calls in `npm test`. A suite whose green depends on a third
 * party's uptime teaches the team to ignore red.
 *
 * **The bodies these helpers build are transcribed from real responses**, unlike
 * every Anthropic fixture in this repo, which was hand-authored before a
 * credential existed and has never been checked against the wire. That is a small
 * upgrade in honesty and it is worth naming.
 */

export interface RecordedRequest {
  readonly url: string;
  readonly body: ChatCompletionCreateParamsNonStreaming;
}

export type Reply =
  | { readonly status?: number; readonly json: unknown }
  /** The socket died. Becomes `APIConnectionError` inside the SDK. */
  | { readonly throws: Error };

export type Handler = (
  body: ChatCompletionCreateParamsNonStreaming,
  index: number,
) => Reply;

export class RecordingTransport {
  readonly requests: RecordedRequest[] = [];

  constructor(private readonly handler: Handler) {}

  /** Pass to `new Groq({ fetch })`. */
  readonly fetch = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const body = JSON.parse(
      String(init?.body ?? "{}"),
    ) as ChatCompletionCreateParamsNonStreaming;
    const index = this.requests.length;
    this.requests.push({ url: String(url), body });

    const reply = this.handler(body, index);
    if ("throws" in reply) throw reply.throws;

    return new Response(JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };

  /** The one request, when a test made exactly one. */
  get only(): ChatCompletionCreateParamsNonStreaming {
    if (this.requests.length !== 1) {
      throw new Error(`expected 1 request, saw ${this.requests.length}`);
    }
    return this.requests[0]!.body;
  }
}

/**
 * A client wired to `transport`. `maxRetries: 0` because the retry policy is the
 * SDK's business and a test that waits for backoff is a test nobody runs.
 */
export function testClient(transport: RecordingTransport): Groq {
  return new Groq({
    apiKey: "gsk-test",
    baseURL: "https://api.groq.com",
    maxRetries: 0,
    fetch: transport.fetch,
  });
}

/** Replies with each body in turn, then repeats the last. */
export function replay(...bodies: readonly unknown[]): Handler {
  return (_body, index) => ({
    json: bodies[Math.min(index, bodies.length - 1)],
  });
}

const USAGE = { prompt_tokens: 420, completion_tokens: 24, total_tokens: 444 };

/** A `tools`-mode completion: the object arrives as a JSON string in `arguments`. */
export function toolCallBody(
  toolName: string,
  args: unknown,
  model = "llama-3.3-70b-versatile",
): unknown {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_760_000_000,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_test",
              type: "function",
              function: { name: toolName, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: USAGE,
  };
}

/** A `json_schema`-mode completion: the object arrives as a JSON string in `content`. */
export function jsonBody(value: unknown, model = "openai/gpt-oss-120b"): unknown {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1_760_000_000,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(value) },
        finish_reason: "stop",
      },
    ],
    usage: USAGE,
  };
}

/**
 * The `400` a model returns when it could not fill the schema it was forced into.
 *
 * Transcribed from the real thing: `openai/gpt-oss-120b`, handed
 * `record_service_address`, flattened the four-field address into
 * `{"value": {"address": "1247 Calle Ocho, Miami Florida, 33135"}}` and Groq
 * turned that into this. `failed_generation` carries the text the model actually
 * produced, which is how we know.
 */
export function modelFailureReply(
  code: "tool_use_failed" | "json_validate_failed" = "tool_use_failed",
  failedGeneration = '{"value": {"address": "1247 Calle Ocho, Miami Florida, 33135"}}',
): Reply {
  return {
    status: 400,
    json: {
      error: {
        message: `Failed to call a function. Please adjust your prompt. See 'failed_generation' for more details.`,
        type: "invalid_request_error",
        code,
        failed_generation: failedGeneration,
      },
    },
  };
}
