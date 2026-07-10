import Anthropic from "@anthropic-ai/sdk";
import type { MessageBody } from "./fixtures.js";

/**
 * A transport fake for the Anthropic SDK, in the shape the rest of this repo
 * uses its ports: it records what the collaborator *saw*, and answers from a
 * handler. Tests assert on `requests`, never on a mocking framework.
 *
 * The seam is the SDK's injectable `fetch`, deliberately, rather than a port of
 * our own wrapped around it. Two of the three things that can go wrong with this
 * extractor — adaptive thinking left on, and a cache prefix that differs between
 * turns — are properties of the bytes on the wire. A hand-rolled port would let
 * us assert on the arguments we passed to ourselves.
 */

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
