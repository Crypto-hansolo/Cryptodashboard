import {
  CircuitOpenError,
  RateLimitError,
  TimeoutError,
  UnauthorizedError,
  UpstreamError,
  err,
  ok,
  toDomainError,
  noopLogger,
  systemClock,
  type Cache,
  type Clock,
  type DomainError,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  type Logger,
  type RateLimiter,
  type Result,
} from '@cid/core';
import { CircuitBreaker } from './circuit-breaker.js';
import { sleep } from './rate-limiter.js';
import { metrics } from './metrics.js';

/**
 * The HTTP client every connector uses.
 *
 * Layers, outermost first: cache -> circuit breaker -> rate limiter -> retry
 * with jittered backoff -> fetch with timeout. That ordering is deliberate:
 * a cache hit should not consume a rate-limit token, and an open circuit should
 * not wait on the rate limiter before failing fast.
 *
 * Returns `Result` rather than throwing — see `@cid/core`'s Result docs.
 */

export interface HttpClientOptions {
  /** Prefixes cache keys and rate-limit buckets. Usually the connector key. */
  provider: string;
  cache?: Cache;
  rateLimiter?: RateLimiter;
  circuitBreaker?: CircuitBreaker;
  logger?: Logger;
  clock?: Clock;
  defaultTimeoutMs?: number;
  maxRetries?: number;
  /** Sent on every request unless overridden per-call. */
  defaultHeaders?: Record<string, string>;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

/** Statuses worth retrying. 408/425/429 plus the 5xx family. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

export class ResilientHttpClient implements HttpClient {
  readonly #provider: string;
  readonly #cache: Cache | undefined;
  readonly #rateLimiter: RateLimiter | undefined;
  readonly #breaker: CircuitBreaker;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #defaultTimeoutMs: number;
  readonly #maxRetries: number;
  readonly #defaultHeaders: Record<string, string>;
  readonly #fetch: typeof fetch;

  constructor(options: HttpClientOptions) {
    this.#provider = options.provider;
    this.#cache = options.cache;
    this.#rateLimiter = options.rateLimiter;
    this.#breaker = options.circuitBreaker ?? new CircuitBreaker({ clock: options.clock });
    this.#logger = (options.logger ?? noopLogger).child({ provider: options.provider });
    this.#clock = options.clock ?? systemClock;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#defaultHeaders = {
      accept: 'application/json',
      'user-agent': options.userAgent ?? 'crypto-intelligence-dashboard/1.0',
      ...options.defaultHeaders,
    };
  }

  get circuitBreaker(): CircuitBreaker {
    return this.#breaker;
  }

  async request<T>(request: HttpRequest): Promise<Result<HttpResponse<T>, DomainError>> {
    const url = buildUrl(request.url, request.query);
    const method = request.method ?? 'GET';
    const cacheable = method === 'GET' && (request.cacheTtlSeconds ?? 0) > 0;
    const cacheKey = cacheable ? `${this.#provider}:${url}` : null;

    // ── Cache ──
    if (cacheKey && this.#cache) {
      const cached = await this.#cache.get<{
        status: number;
        headers: Record<string, string>;
        data: T;
      }>(cacheKey);
      if (cached !== null) {
        metrics.increment('http_cache_hit', { provider: this.#provider });
        return ok({ ...cached, fromCache: true, durationMs: 0 });
      }
    }

    // ── Circuit breaker ──
    if (!this.#breaker.canRequest(this.#provider)) {
      metrics.increment('http_circuit_rejected', { provider: this.#provider });
      const reopensAt = this.#breaker.reopensAt(this.#provider) ?? this.#clock.now();
      return err(new CircuitOpenError(this.#provider, reopensAt));
    }

    // ── Rate limiter ──
    if (this.#rateLimiter) {
      try {
        await this.#rateLimiter.acquire(this.#provider, request.signal);
      } catch (error) {
        return err(toDomainError(error, 'rate limit wait aborted'));
      }
    }

    const startedAt = this.#clock.monotonicMs();
    let lastError: DomainError | null = null;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      if (attempt > 0) {
        const delayMs = backoffDelayMs(attempt, lastError);
        this.#logger.debug({ url, attempt, delayMs }, 'retrying request');
        try {
          await sleep(delayMs, request.signal);
        } catch {
          break; // aborted while waiting
        }
        // Retries consume rate-limit budget too.
        if (this.#rateLimiter) {
          try {
            await this.#rateLimiter.acquire(this.#provider, request.signal);
          } catch {
            break;
          }
        }
      }

      const outcome = await this.#attempt<T>(url, method, request);

      if (outcome.ok) {
        this.#breaker.recordSuccess(this.#provider);
        const durationMs = this.#clock.monotonicMs() - startedAt;
        metrics.observe('http_request_ms', durationMs, { provider: this.#provider });
        metrics.increment('http_request_success', { provider: this.#provider });

        if (cacheKey && this.#cache) {
          await this.#cache.set(
            cacheKey,
            {
              status: outcome.value.status,
              headers: outcome.value.headers,
              data: outcome.value.data,
            },
            request.cacheTtlSeconds,
          );
        }
        return ok({ ...outcome.value, fromCache: false, durationMs });
      }

      lastError = outcome.error;
      if (!outcome.error.retryable) break;
    }

    this.#breaker.recordFailure(this.#provider);
    metrics.increment('http_request_failure', { provider: this.#provider });
    this.#logger.warn(
      { url, err: lastError?.message, code: lastError?.code },
      'request failed after retries',
    );
    return err(lastError ?? new UpstreamError(this.#provider, 'request failed'));
  }

  /** One attempt: fetch, timeout, status mapping, body parsing. */
  async #attempt<T>(
    url: string,
    method: string,
    request: HttpRequest,
  ): Promise<Result<Omit<HttpResponse<T>, 'fromCache' | 'durationMs'>, DomainError>> {
    const timeoutMs = request.timeoutMs ?? this.#defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Propagate an externally-supplied abort into our controller.
    const onExternalAbort = (): void => controller.abort();
    request.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const headers: Record<string, string> = { ...this.#defaultHeaders, ...request.headers };
      let body: string | undefined;
      if (request.body !== undefined && method !== 'GET') {
        body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
        headers['content-type'] ??= 'application/json';
      }

      const response = await this.#fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value;
      });

      if (!response.ok) {
        // Read a bounded slice of the error body: some providers put the real
        // reason there, but an HTML error page can be megabytes.
        const text = await response.text().catch(() => '');
        const detail = text.slice(0, 500);

        if (response.status === 429) {
          const retryAfter = Number.parseInt(responseHeaders['retry-after'] ?? '', 10);
          return err(
            new RateLimitError(
              this.#provider,
              Number.isFinite(retryAfter) ? retryAfter : undefined,
            ),
          );
        }
        if (response.status === 401 || response.status === 403) {
          return err(new UnauthorizedError(this.#provider, detail || `HTTP ${response.status}`));
        }
        const error = new UpstreamError(
          this.#provider,
          `HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
          response.status,
        );
        // UpstreamError treats all >=500 as retryable; extend that to the
        // specific 4xx codes that are genuinely transient.
        if (RETRYABLE_STATUSES.has(response.status) && !error.retryable) {
          return err(
            new UpstreamError(
              this.#provider,
              `HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
              503,
            ),
          );
        }
        return err(error);
      }

      const contentType = responseHeaders['content-type'] ?? '';
      let data: T;
      if (contentType.includes('json')) {
        const text = await response.text();
        if (text.trim() === '') {
          data = null as T;
        } else {
          try {
            data = JSON.parse(text) as T;
          } catch (error) {
            // A JSON content-type with a non-JSON body usually means an
            // intercepting proxy or an error page; retrying sometimes helps.
            return err(
              new UpstreamError(
                this.#provider,
                `malformed JSON response: ${(error as Error).message}`,
                502,
              ),
            );
          }
        }
      } else {
        data = (await response.text()) as T;
      }

      return ok({ status: response.status, headers: responseHeaders, data });
    } catch (error) {
      if (controller.signal.aborted && !request.signal?.aborted) {
        return err(new TimeoutError(`${this.#provider} ${url}`, timeoutMs));
      }
      // Transport-level failure (DNS, TLS, connection reset): retryable.
      return err(new UpstreamError(this.#provider, (error as Error).message ?? 'network error'));
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  async getJson<T>(
    url: string,
    options: Omit<HttpRequest, 'url' | 'method'> = {},
  ): Promise<Result<T, DomainError>> {
    const result = await this.request<T>({ ...options, url, method: 'GET' });
    return result.ok ? ok(result.value.data) : err(result.error);
  }

  async getText(
    url: string,
    options: Omit<HttpRequest, 'url' | 'method'> = {},
  ): Promise<Result<string, DomainError>> {
    const result = await this.request<string>({
      ...options,
      url,
      method: 'GET',
      headers: {
        accept: 'application/xml, text/xml, application/rss+xml, text/html, */*',
        ...options.headers,
      },
    });
    return result.ok ? ok(String(result.value.data)) : err(result.error);
  }
}

/** Append query params, dropping null/undefined so callers can pass optionals. */
export function buildUrl(
  base: string,
  query?: Record<string, string | number | boolean | undefined | null>,
): string {
  if (!query) return base;
  const entries = Object.entries(query).filter(
    (entry): entry is [string, string | number | boolean] =>
      entry[1] !== undefined && entry[1] !== null,
  );
  if (entries.length === 0) return base;

  const separator = base.includes('?') ? '&' : '?';
  const params = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return `${base}${separator}${params}`;
}

/**
 * Exponential backoff with full jitter, honouring `Retry-After` when the
 * provider sent one. Jitter matters because ~30 connectors failing on the same
 * tick would otherwise retry in lockstep forever.
 */
export function backoffDelayMs(
  attempt: number,
  lastError: DomainError | null,
  options: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const baseMs = options.baseMs ?? 500;
  const maxMs = options.maxMs ?? 30_000;
  const random = options.random ?? Math.random;

  if (lastError instanceof RateLimitError && lastError.retryAfterSeconds !== undefined) {
    return Math.min(lastError.retryAfterSeconds * 1000, maxMs);
  }

  const exponential = Math.min(baseMs * 2 ** (attempt - 1), maxMs);
  // Full jitter over [exponential/2, exponential].
  return Math.round(exponential / 2 + random() * (exponential / 2));
}
