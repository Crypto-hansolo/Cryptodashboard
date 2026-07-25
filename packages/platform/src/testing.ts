import type { Clock } from '@cid/core';

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
