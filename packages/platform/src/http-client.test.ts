import { describe, expect, it } from 'vitest';
import { RateLimitError } from '@cid/core';
import { ResilientHttpClient, backoffDelayMs, buildUrl } from './http-client.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { InMemoryCache } from './cache.js';
import { InMemoryRateLimiter } from './rate-limiter.js';
import { FakeClock, createFetchStub, type StubResponse } from './testing.js';

function client(responses: StubResponse[], overrides: Record<string, unknown> = {}) {
  const stub = createFetchStub(responses);
  const instance = new ResilientHttpClient({
    provider: 'test',
    fetchImpl: stub.fetch,
    // Keep retries fast; backoff timing is covered separately.
    maxRetries: 2,
    defaultTimeoutMs: 50,
    ...overrides,
  });
  return { instance, stub };
}

describe('buildUrl', () => {
  it('returns the base when there is no query', () => {
    expect(buildUrl('https://a.com/x')).toBe('https://a.com/x');
    expect(buildUrl('https://a.com/x', {})).toBe('https://a.com/x');
  });

  it('drops null and undefined params so callers can pass optionals', () => {
    expect(buildUrl('https://a.com/x', { a: 1, b: undefined, c: null, d: 'z' })).toBe(
      'https://a.com/x?a=1&d=z',
    );
  });

  it('respects an existing query string', () => {
    expect(buildUrl('https://a.com/x?a=1', { b: 2 })).toBe('https://a.com/x?a=1&b=2');
  });

  it('encodes keys and values', () => {
    expect(buildUrl('https://a.com/x', { 'q p': 'a&b' })).toBe('https://a.com/x?q%20p=a%26b');
  });

  it('serialises booleans', () => {
    expect(buildUrl('https://a.com/x', { flag: false })).toBe('https://a.com/x?flag=false');
  });
});

describe('backoffDelayMs', () => {
  it('grows exponentially and stays within the jitter window', () => {
    for (const attempt of [1, 2, 3, 4]) {
      const expected = Math.min(500 * 2 ** (attempt - 1), 30_000);
      const delay = backoffDelayMs(attempt, null, { random: () => 0.5 });
      expect(delay).toBeGreaterThanOrEqual(expected / 2);
      expect(delay).toBeLessThanOrEqual(expected);
    }
  });

  it('applies jitter so retries do not align', () => {
    const low = backoffDelayMs(3, null, { random: () => 0 });
    const high = backoffDelayMs(3, null, { random: () => 1 });
    expect(low).toBeLessThan(high);
  });

  it('honours Retry-After over its own backoff', () => {
    const error = new RateLimitError('test', 7);
    expect(backoffDelayMs(1, error)).toBe(7_000);
  });

  it('caps the honoured Retry-After', () => {
    const error = new RateLimitError('test', 9_999);
    expect(backoffDelayMs(1, error, { maxMs: 30_000 })).toBe(30_000);
  });

  it('respects the ceiling', () => {
    expect(backoffDelayMs(20, null, { random: () => 1 })).toBeLessThanOrEqual(30_000);
  });
});

describe('ResilientHttpClient', () => {
  it('returns parsed JSON on success', async () => {
    const { instance } = client([{ body: { price: 42 } }]);
    const result = await instance.getJson<{ price: number }>('https://api.test/price');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.price).toBe(42);
  });

  it('returns text for non-JSON responses', async () => {
    const { instance } = client([
      { body: '<rss></rss>', headers: { 'content-type': 'application/xml' } },
    ]);
    const result = await instance.getText('https://feed.test/rss');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('<rss></rss>');
  });

  it('treats an empty JSON body as null rather than throwing', async () => {
    const { instance } = client([
      { body: undefined, headers: { 'content-type': 'application/json' } },
    ]);
    const result = await instance.getJson('https://api.test/empty');
    expect(result.ok).toBe(true);
  });

  it('reports malformed JSON as a retryable upstream error', async () => {
    const { instance, stub } = client([
      { body: '<html>proxy error</html>', headers: { 'content-type': 'application/json' } },
    ]);
    const result = await instance.getJson('https://api.test/broken');
    expect(result.ok).toBe(false);
    // Retried, because an intercepting proxy is often transient.
    expect(stub.calls.length).toBeGreaterThan(1);
  });

  it('retries 5xx and succeeds on a later attempt', async () => {
    const { instance, stub } = client([{ status: 503 }, { status: 502 }, { body: { ok: true } }]);
    const result = await instance.getJson<{ ok: boolean }>('https://api.test/flaky');
    expect(result.ok).toBe(true);
    expect(stub.calls).toHaveLength(3);
  });

  it('does NOT retry a 404', async () => {
    const { instance, stub } = client([{ status: 404, body: 'missing' }]);
    const result = await instance.getJson('https://api.test/nope');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UPSTREAM');
    expect(stub.calls).toHaveLength(1);
  });

  it('maps 401/403 to a non-retryable UNAUTHORIZED', async () => {
    for (const status of [401, 403]) {
      const { instance, stub } = client([{ status }]);
      const result = await instance.getJson('https://api.test/private');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('UNAUTHORIZED');
        expect(result.error.retryable).toBe(false);
      }
      // A bad key will not fix itself; retrying only burns rate limit.
      expect(stub.calls).toHaveLength(1);
    }
  });

  it('maps 429 to a retryable RATE_LIMITED carrying Retry-After', async () => {
    const { instance } = client([{ status: 429, headers: { 'retry-after': '3' } }], {
      maxRetries: 0,
    });
    const result = await instance.getJson('https://api.test/limited');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('RATE_LIMITED');
      expect(result.error.retryable).toBe(true);
      expect((result.error as RateLimitError).retryAfterSeconds).toBe(3);
    }
  });

  it('retries the transient 4xx codes', async () => {
    const { instance, stub } = client([{ status: 408 }, { body: { ok: true } }]);
    const result = await instance.getJson('https://api.test/timeout');
    expect(result.ok).toBe(true);
    expect(stub.calls).toHaveLength(2);
  });

  it('times out a hanging request', async () => {
    const { instance } = client([{ hang: true }], { maxRetries: 0, defaultTimeoutMs: 30 });
    const result = await instance.getJson('https://api.test/hang');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('TIMEOUT');
  });

  it('treats a transport failure as retryable', async () => {
    const { instance, stub } = client([
      { throws: new TypeError('fetch failed') },
      { body: { ok: true } },
    ]);
    const result = await instance.getJson('https://api.test/dns');
    expect(result.ok).toBe(true);
    expect(stub.calls).toHaveLength(2);
  });

  it('gives up after maxRetries', async () => {
    const { instance, stub } = client([{ status: 500 }], { maxRetries: 2 });
    const result = await instance.getJson('https://api.test/down');
    expect(result.ok).toBe(false);
    expect(stub.calls).toHaveLength(3); // initial + 2 retries
  });

  it('serves a cached GET without a second network call', async () => {
    const cache = new InMemoryCache();
    const { instance, stub } = client([{ body: { n: 1 } }, { body: { n: 2 } }], { cache });

    const first = await instance.getJson<{ n: number }>('https://api.test/c', {
      cacheTtlSeconds: 60,
    });
    const second = await instance.getJson<{ n: number }>('https://api.test/c', {
      cacheTtlSeconds: 60,
    });

    expect(first.ok && first.value.n).toBe(1);
    expect(second.ok && second.value.n).toBe(1);
    expect(stub.calls).toHaveLength(1);
  });

  it('does not cache when no TTL is given', async () => {
    const cache = new InMemoryCache();
    const { instance, stub } = client([{ body: { n: 1 } }, { body: { n: 2 } }], { cache });
    await instance.getJson('https://api.test/u');
    await instance.getJson('https://api.test/u');
    expect(stub.calls).toHaveLength(2);
  });

  it('marks a cache hit and skips the rate limiter', async () => {
    const cache = new InMemoryCache();
    const clock = new FakeClock();
    const rateLimiter = new InMemoryRateLimiter({ clock });
    // Exactly one token: a second network call would block forever.
    rateLimiter.configure('test', { requestsPerMinute: 60, burst: 1 });

    const { instance } = client([{ body: { n: 1 } }], { cache, rateLimiter, clock });
    await instance.request({ url: 'https://api.test/rl', cacheTtlSeconds: 60 });
    const second = await instance.request({ url: 'https://api.test/rl', cacheTtlSeconds: 60 });

    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.fromCache).toBe(true);
  });

  it('opens its circuit after repeated failures and then fails fast', async () => {
    const clock = new FakeClock();
    const circuitBreaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000, clock });
    const { instance, stub } = client([{ status: 500 }], {
      circuitBreaker,
      clock,
      maxRetries: 0,
    });

    await instance.getJson('https://api.test/x');
    await instance.getJson('https://api.test/x');
    expect(circuitBreaker.state('test')).toBe('OPEN');

    const callsBefore = stub.calls.length;
    const rejected = await instance.getJson('https://api.test/x');
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe('CIRCUIT_OPEN');
    // No network call was made at all.
    expect(stub.calls).toHaveLength(callsBefore);
  });

  it('sends default and per-request headers', async () => {
    let captured: Headers | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      captured = new Headers(init?.headers);
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const instance = new ResilientHttpClient({
      provider: 'test',
      fetchImpl,
      defaultHeaders: { 'x-default': 'yes' },
      userAgent: 'cid-test/1.0',
    });
    await instance.getJson('https://api.test/h', { headers: { 'x-call': 'also' } });

    expect(captured?.get('x-default')).toBe('yes');
    expect(captured?.get('x-call')).toBe('also');
    expect(captured?.get('user-agent')).toBe('cid-test/1.0');
  });

  it('serialises a JSON body for POST and sets content-type', async () => {
    let capturedBody: string | undefined;
    let capturedMethod: string | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body as string;
      capturedMethod = init?.method;
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const instance = new ResilientHttpClient({ provider: 'test', fetchImpl });
    await instance.request({ url: 'https://api.test/p', method: 'POST', body: { a: 1 } });

    expect(capturedMethod).toBe('POST');
    expect(capturedBody).toBe('{"a":1}');
  });

  it('appends query parameters', async () => {
    const { instance, stub } = client([{ body: {} }]);
    await instance.request({ url: 'https://api.test/q', query: { ids: 'btc,eth', page: 2 } });
    expect(stub.calls[0]).toBe('https://api.test/q?ids=btc%2Ceth&page=2');
  });
});
