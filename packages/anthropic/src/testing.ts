import Anthropic from "@anthropic-ai/sdk";

/**
 * A transport fake for the Anthropic SDK, in the shape the rest of this repo
 * uses its ports: it records what the collaborator *saw*, and answers from a
 * handler. Tests assert on `requests`, never on a mocking framework.
 *
 * The seam is the SDK's injectable `fetch`, deliberately, rather than a port of
 * our own wrapped around it. The things that go wrong with a model binding —
 * adaptive thinking left on, a cache prefix that differs between turns, a tool
 * schema that is not the one the contract describes — are properties of the
 * bytes on the wire. A hand-rolled port would let us assert on the arguments we
 * passed to ourselves.
 *
 * This is how every model binding in the tree is proven **offline**: extraction's
 * replay suite, the eval's nightly `AnthropicExtractor` arm, the FAQ selector,
 * and the correction triager. Zero live model calls in `npm test` — a suite whose
 * green depends on a third party's uptime teaches the team to ignore red.
 */

/** The JSON body of a `POST /v1/messages` response, as far as we read it. */
export interface MessageBody {
  readonly id: string;
  readonly type: "message";
  readonly role: "assistant";
  readonly model: string;
  readonly content: readonly unknown[];
  readonly stop_reason: string;
  readonly stop_sequence: null;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_creation_input_tokens: number;
    readonly cache_read_input_tokens: number;
  };
}

export interface RecordedRequest {
  readonly url: string;
  readonly body: Anthropic.MessageCreateParams;
}

export type Reply =
  | { readonly status?: number; readonly json: unknown }
  /** The socket died. Becomes `APIConnectionError` inside the SDK. */
  | { readonly throws: Error };

export type Handler = (
  body: Anthropic.MessageCreateParams,
  index: number,
) => Reply;

export class RecordingTransport {
  readonly requests: RecordedRequest[] = [];

  constructor(private readonly handler: Handler) {}

  /** Pass to `new Anthropic({ fetch })`. */
  readonly fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Anthropic.MessageCreateParams;
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
  get only(): Anthropic.MessageCreateParams {
    if (this.requests.length !== 1) {
      throw new Error(`expected 1 request, saw ${this.requests.length}`);
    }
    return this.requests[0]!.body;
  }
}

/**
 * A client wired to `transport`. `maxRetries: 0` because the retry policy is
 * the SDK's business and a test that waits for backoff is a test nobody runs.
 */
export function testClient(transport: RecordingTransport): Anthropic {
  return new Anthropic({
    apiKey: "sk-ant-test",
    maxRetries: 0,
    fetch: transport.fetch,
  });
}

/** Replies with each body in turn, then repeats the last. */
export function replay(...bodies: readonly MessageBody[]): Handler {
  return (_body, index) => ({ json: bodies[Math.min(index, bodies.length - 1)] });
}
