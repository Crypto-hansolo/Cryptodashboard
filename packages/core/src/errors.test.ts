import { describe, expect, it } from 'vitest';
import {
  CircuitOpenError,
  ConfigError,
  ConflictError,
  DomainError,
  NotFoundError,
  RateLimitError,
  TimeoutError,
  UnauthorizedError,
  UnsupportedError,
  UpstreamError,
  ValidationError,
  isRetryable,
  toDomainError,
} from './errors.js';

/**
 * The `retryable` flag is the contract between connectors and the scheduler, and
 * it is expensive in both directions: retrying a 401 forever burns the rate
 * limit, and dropping a 503 loses data. So every subclass's answer is pinned
 * here rather than left to whoever reads the constructor next.
 */

describe('DomainError', () => {
  it('defaults to not retryable — a new failure mode must opt in', () => {
    const error = new DomainError('INTERNAL', 'something broke');
    expect(error.retryable).toBe(false);
  });

  it('reports its own subclass name, so logs identify the failure', () => {
    expect(new DomainError('INTERNAL', 'x').name).toBe('DomainError');
    expect(new ValidationError('x').name).toBe('ValidationError');
    expect(new UpstreamError('binance', 'x', 500).name).toBe('UpstreamError');
  });

  it('is an Error, so existing catch blocks and stack traces still work', () => {
    const error = new DomainError('INTERNAL', 'x');
    expect(error).toBeInstanceOf(Error);
    expect(error.stack).toBeDefined();
  });

  it('freezes its context so a caller cannot mutate a logged error', () => {
    const context = { coinId: 'btc' };
    const error = new DomainError('INTERNAL', 'x', { context });
    expect(error.context).toEqual({ coinId: 'btc' });
    expect(Object.isFrozen(error.context)).toBe(true);
    // A later mutation of the source object must not leak in.
    context.coinId = 'eth';
    expect(error.context.coinId).toBe('btc');
  });

  it('keeps an empty context rather than undefined when none is given', () => {
    expect(new DomainError('INTERNAL', 'x').context).toEqual({});
  });

  it('preserves a cause', () => {
    const cause = new Error('socket hang up');
    expect(new DomainError('UPSTREAM', 'x', { cause }).cause).toBe(cause);
  });

  it('serialises the fields a log needs and nothing else', () => {
    const error = new DomainError('RATE_LIMITED', 'slow down', {
      retryable: true,
      context: { provider: 'coingecko' },
    });
    expect(error.toJSON()).toEqual({
      name: 'DomainError',
      code: 'RATE_LIMITED',
      message: 'slow down',
      retryable: true,
      context: { provider: 'coingecko' },
    });
  });
});

describe('subclass retryability', () => {
  it('never retries client-side and configuration faults', () => {
    // None of these fix themselves, so retrying only wastes quota.
    expect(new ValidationError('bad input').retryable).toBe(false);
    expect(new NotFoundError('Coin', 'xyz').retryable).toBe(false);
    expect(new ConflictError('duplicate').retryable).toBe(false);
    expect(new UnauthorizedError('etherscan').retryable).toBe(false);
    expect(new UnsupportedError('no such domain').retryable).toBe(false);
    expect(new ConfigError('missing DATABASE_URL').retryable).toBe(false);
  });

  it('retries transient transport faults', () => {
    expect(new RateLimitError('coingecko').retryable).toBe(true);
    expect(new TimeoutError('fetch markets', 20_000).retryable).toBe(true);
    expect(new CircuitOpenError('theblock', new Date()).retryable).toBe(true);
  });
});

describe('UpstreamError', () => {
  it('retries 5xx, because the server may recover', () => {
    expect(new UpstreamError('binance', 'bad gateway', 502).retryable).toBe(true);
    expect(new UpstreamError('binance', 'server error', 500).retryable).toBe(true);
    expect(new UpstreamError('binance', 'unavailable', 503).retryable).toBe(true);
  });

  it('does not retry 4xx, because the request itself is wrong', () => {
    expect(new UpstreamError('binance', 'bad request', 400).retryable).toBe(false);
    expect(new UpstreamError('binance', 'not found', 404).retryable).toBe(false);
    expect(new UpstreamError('binance', 'teapot', 418).retryable).toBe(false);
  });

  it('retries when there is no status at all — a transport failure', () => {
    // DNS blip, connection reset, malformed body: no HTTP status was ever seen.
    const error = new UpstreamError('coindesk', 'malformed JSON');
    expect(error.status).toBeUndefined();
    expect(error.retryable).toBe(true);
  });

  it('prefixes the provider so a log line identifies the source', () => {
    expect(new UpstreamError('coingecko', 'rate limited', 429).message).toBe(
      'coingecko: rate limited',
    );
  });
});

describe('error message shapes', () => {
  it('NotFoundError names the resource and identifier', () => {
    const error = new NotFoundError('Coin', 'not-a-coin');
    expect(error.message).toBe('Coin not found: not-a-coin');
    expect(error.context).toEqual({ resource: 'Coin', identifier: 'not-a-coin' });
  });

  it('UnauthorizedError names the provider and takes a custom reason', () => {
    expect(new UnauthorizedError('etherscan').message).toBe(
      'etherscan: missing or rejected credentials',
    );
    expect(new UnauthorizedError('nansen', 'plan does not include this endpoint').message).toBe(
      'nansen: plan does not include this endpoint',
    );
  });

  it('TimeoutError names the operation and the budget it exceeded', () => {
    const error = new TimeoutError('coingecko markets', 20_000);
    expect(error.message).toBe('coingecko markets timed out after 20000ms');
    expect(error.context).toEqual({ operation: 'coingecko markets', timeoutMs: 20_000 });
  });

  it('CircuitOpenError says when it reopens, in the message and the context', () => {
    const reopensAt = new Date('2026-07-25T12:00:00.000Z');
    const error = new CircuitOpenError('theblock', reopensAt);
    expect(error.message).toContain('2026-07-25T12:00:00.000Z');
    expect(error.context).toEqual({
      provider: 'theblock',
      reopensAt: '2026-07-25T12:00:00.000Z',
    });
  });
});

describe('RateLimitError', () => {
  it('exposes Retry-After when the upstream supplied one', () => {
    const error = new RateLimitError('coingecko', 30);
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.context.retryAfterSeconds).toBe(30);
  });

  it('leaves it undefined when the upstream said nothing', () => {
    expect(new RateLimitError('coingecko').retryAfterSeconds).toBeUndefined();
  });
});

describe('isRetryable', () => {
  it('reads the flag off a DomainError', () => {
    expect(isRetryable(new RateLimitError('x'))).toBe(true);
    expect(isRetryable(new ValidationError('x'))).toBe(false);
  });

  it('assumes an unknown throw is retryable', () => {
    /*
     * Deliberately optimistic: an unrecognised failure is far more likely to be
     * a transient bug or a transport hiccup than a permanent condition, and the
     * circuit breaker bounds the cost of being wrong.
     */
    expect(isRetryable(new Error('who knows'))).toBe(true);
    expect(isRetryable('a string')).toBe(true);
    expect(isRetryable(undefined)).toBe(true);
  });
});

describe('toDomainError', () => {
  it('passes a DomainError through unchanged, preserving its code', () => {
    const original = new UpstreamError('binance', 'bad gateway', 502);
    expect(toDomainError(original)).toBe(original);
  });

  it('wraps a plain Error as INTERNAL, keeping the message and the cause', () => {
    const cause = new Error('unexpected undefined');
    const wrapped = toDomainError(cause);
    expect(wrapped.code).toBe('INTERNAL');
    expect(wrapped.message).toBe('unexpected undefined');
    expect(wrapped.cause).toBe(cause);
    expect(wrapped.retryable).toBe(true);
  });

  it('falls back to the supplied message when the Error has none', () => {
    expect(toDomainError(new Error(''), 'enrichment failed').message).toBe('enrichment failed');
  });

  it('captures a non-Error throw as context rather than losing it', () => {
    const wrapped = toDomainError({ status: 500 }, 'provider threw');
    expect(wrapped.code).toBe('INTERNAL');
    expect(wrapped.message).toBe('provider threw');
    expect(wrapped.context.raw).toBe('[object Object]');
  });
});
