import {
  UpstreamError,
  err,
  ok,
  type Clock,
  type DomainError,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type Repositories,
  type Result,
} from '@cid/core';

/**
 * A manually-advanced clock.
 *
 * Every timing behaviour in this package — backoff, breaker cooldowns, token
 * refill, cache TTL — is testable by moving this forward instead of sleeping.
 * Real sleeps would make the suite slow and flaky, and would make it impossible
 * to assert on a 10-minute cooldown at all.
 */
export class FakeClock implements Clock {
  #nowMs: number;

  constructor(start: Date | number = new Date('2026-01-01T00:00:00Z')) {
    this.#nowMs = typeof start === 'number' ? start : start.getTime();
  }

  now(): Date {
    return new Date(this.#nowMs);
  }

  monotonicMs(): number {
    return this.#nowMs;
  }

  advance(ms: number): void {
    this.#nowMs += ms;
  }

  set(at: Date | number): void {
    this.#nowMs = typeof at === 'number' ? at : at.getTime();
  }
}

/** A scripted `fetch` for driving the HTTP client's failure paths. */
export interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Throw instead of responding, to simulate a transport failure. */
  throws?: Error;
  /** Never settle, so the client's own timeout fires. */
  hang?: boolean;
}

export interface FetchStub {
  fetch: typeof fetch;
  /** URLs requested, in order. */
  calls: string[];
}

/**
 * Build a `fetch` that returns the given responses in sequence. The final
 * response repeats once the script is exhausted, which keeps retry tests
 * readable (`[fail, fail, ok]` rather than padding to the retry count).
 */
export function createFetchStub(responses: readonly StubResponse[]): FetchStub {
  const calls: string[] = [];
  let index = 0;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    const spec = responses[Math.min(index, responses.length - 1)] ?? {};
    index++;

    if (spec.throws) throw spec.throws;
    if (spec.hang) {
      // Never respond, but DO honour the abort signal — real `fetch` rejects
      // with an AbortError when its signal fires, and a stub that ignores the
      // signal would make the client's timeout path untestable (the await
      // simply never returns).
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted.', 'AbortError')),
          { once: true },
        );
      });
    }

    const status = spec.status ?? 200;
    const isJson = spec.body !== undefined && typeof spec.body !== 'string';
    const headers = new Headers({
      'content-type': isJson ? 'application/json' : 'text/plain',
      ...spec.headers,
    });
    const body =
      spec.body === undefined ? '' : isJson ? JSON.stringify(spec.body) : String(spec.body);

    return new Response(body, { status, headers });
  }) as unknown as typeof fetch;

  return { fetch: fetchImpl, calls };
}

// ─── Fake HttpClient ─────────────────────────────────────────────────────────

/**
 * A route in the fake client's script: either a payload to return or an error to
 * fail with.
 */
export interface StubRoute {
  /** Substring or pattern the request URL must match. */
  match: string | RegExp;
  /** Parsed body to hand back. Ignored when `error` is set. */
  body?: unknown;
  status?: number;
  error?: DomainError;
  /** Text payload for `getText` (RSS/Atom). */
  text?: string;
}

export interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string> | undefined;
  query: HttpRequest['query'];
  /** URL with the query string appended, as the real client would build it. */
  fullUrl: string;
}

/** Serialise a query object the way the real client does, skipping absent values. */
function appendQuery(url: string, query: HttpRequest['query']): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const serialised = params.toString();
  if (serialised === '') return url;
  return `${url}${url.includes('?') ? '&' : '?'}${serialised}`;
}

/**
 * An `HttpClient` that answers from a script instead of the network.
 *
 * Connectors and LLM providers are almost entirely *mapping* logic — take a
 * provider's JSON, produce domain records — and that logic is where the bugs
 * live: a missing field, a string where a number was expected, an out-of-order
 * batch. Testing it needs a client that returns exact payloads, not a live API
 * whose responses change daily and whose rate limit makes the suite slow and
 * flaky.
 *
 * Matching is first-route-wins on the URL, and requests are recorded so a test
 * can assert on what was actually asked for (which coins, which cursor, whether
 * a key was attached).
 */
export class FakeHttpClient implements HttpClient {
  readonly requests: RecordedRequest[] = [];
  readonly #routes: StubRoute[];

  constructor(routes: readonly StubRoute[] = []) {
    this.#routes = [...routes];
  }

  /** Append a route, so a test can extend the script after construction. */
  on(route: StubRoute): this {
    this.#routes.push(route);
    return this;
  }

  #resolve(url: string): StubRoute | null {
    return (
      this.#routes.find((route) =>
        typeof route.match === 'string' ? url.includes(route.match) : route.match.test(url),
      ) ?? null
    );
  }

  async request<T>(request: HttpRequest): Promise<Result<HttpResponse<T>, DomainError>> {
    const fullUrl = appendQuery(request.url, request.query);
    this.requests.push({
      url: request.url,
      method: request.method ?? 'GET',
      body: request.body,
      headers: request.headers,
      query: request.query,
      fullUrl,
    });

    // Match against the full URL: connectors put the interesting parameters
    // (symbol, address, cursor) in the query, so a route often needs to
    // distinguish two calls to the same path.
    const route = this.#resolve(fullUrl);
    if (!route) {
      // An unrouted URL is a test-authoring mistake, not a provider failure, so
      // it must be loud rather than a plausible-looking empty result.
      return err(new UpstreamError('fake', `no stub route matches ${request.url}`, 404));
    }
    if (route.error) return err(route.error);

    return ok({
      status: route.status ?? 200,
      headers: {},
      data: (route.text ?? route.body) as T,
      fromCache: false,
      durationMs: 1,
    });
  }

  async getJson<T>(
    url: string,
    options: Omit<HttpRequest, 'url' | 'method'> = {},
  ): Promise<Result<T, DomainError>> {
    const response = await this.request<T>({ ...options, url, method: 'GET' });
    return response.ok ? ok(response.value.data) : err(response.error);
  }

  async getText(
    url: string,
    options: Omit<HttpRequest, 'url' | 'method'> = {},
  ): Promise<Result<string, DomainError>> {
    const response = await this.request<string>({ ...options, url, method: 'GET' });
    return response.ok ? ok(String(response.value.data)) : err(response.error);
  }

  /** Every URL requested, query included, in order. */
  get urls(): string[] {
    return this.requests.map((request) => request.fullUrl);
  }

  /** The last request, for asserting on the outgoing payload. */
  get lastRequest(): RecordedRequest | undefined {
    return this.requests[this.requests.length - 1];
  }
}

// ─── Fake repositories ───────────────────────────────────────────────────────

/**
 * A `Repositories` aggregate with only the methods a test actually needs.
 *
 * The port aggregate is thirteen repositories wide, and the agent touches five
 * methods across four of them. Implementing the rest as no-ops would be pages of
 * noise that also quietly hides a call the code should not be making — so
 * anything unstubbed throws with the path it tried to reach.
 *
 * Repository *names* are checked (a typo fails to compile); method names and
 * signatures are not. That is the deliberate trade: a stub returning a whole
 * `Coin` or `MarketQuote` per call would be a fixture file, not a test, and these
 * assertions are about which methods get called and with what.
 */
export function fakeRepositories(overrides: RepositoryStubs): Repositories {
  const groups = new Map<string, Record<string, unknown>>(
    Object.entries(overrides as Record<string, Record<string, unknown>>),
  );

  return new Proxy({} as Repositories, {
    get(_target, repositoryName: string) {
      const group = groups.get(repositoryName) ?? {};
      return new Proxy(group, {
        get(methods, methodName: string) {
          const stub = (methods as Record<string, unknown>)[methodName];
          if (typeof stub === 'function') return stub;
          if (stub !== undefined) return stub;
          return () => {
            throw new Error(
              `fakeRepositories: ${repositoryName}.${methodName}() was called but not stubbed`,
            );
          };
        },
      });
    },
  });
}

/**
 * Stub map: known repository names, loosely-typed method bags. Also allows
 * methods the concrete adapter adds beyond its port (`search.hybridSearch`).
 */
export type RepositoryStubs = {
  [K in keyof Repositories]?: Record<string, unknown>;
};
