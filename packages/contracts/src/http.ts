/**
 * A transport port, so adapters are testable without a network and swappable
 * without touching their mapping logic.
 *
 * This lives in `contracts` rather than in `crm` because two packages now speak
 * HTTP to a vendor: `crm` (Housecall Pro, Jobber) and `validators`
 * (Google Address Validation, Step 4.7). A port that crosses a package boundary
 * belongs in the spine, exactly as `Effect` did in Step 3 — and the alternative,
 * `validators` depending on `crm`, points the dependency graph backwards.
 *
 * `FetchTransport` performs real I/O from `contracts`, which is the same licence
 * `systemClock` and `realSleep` already take: the port and its honest
 * implementation ship together, and every consumer injects the one it wants.
 */
export interface HttpRequest {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface HttpTransport {
  send(request: HttpRequest): Promise<HttpResponse>;
}

export type FakeHandler = (
  request: HttpRequest,
  callIndex: number,
) => HttpResponse | Promise<HttpResponse>;

/**
 * Records every request and answers from a handler. Tests assert on
 * `requests` rather than on our own mocks of ourselves.
 */
export class FakeTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];

  constructor(private readonly handler: FakeHandler) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    const index = this.requests.length;
    this.requests.push(request);
    return this.handler(request, index);
  }

  /** Requests whose path contains `fragment`, for readable assertions. */
  matching(fragment: string): HttpRequest[] {
    return this.requests.filter((r) => r.path.includes(fragment));
  }
}

/** Real transport, kept trivial: adapters own all the mapping. */
export class FetchTransport implements HttpTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly defaultHeaders: Readonly<Record<string, string>> = {},
  ) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    const response = await fetch(`${this.baseUrl}${request.path}`, {
      method: request.method,
      headers: {
        "content-type": "application/json",
        ...this.defaultHeaders,
        ...request.headers,
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });

    const text = await response.text();
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, body };
  }
}
