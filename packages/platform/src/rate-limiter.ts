import type { Clock, RateLimiter } from '@cid/core';
import { systemClock } from '@cid/core';
import type Redis from 'ioredis';

/**
 * Token-bucket rate limiting.
 *
 * Two implementations behind one port:
 *
 *  - {@link InMemoryRateLimiter} for a single process and for tests.
 *  - {@link RedisRateLimiter} for the real deployment, because provider limits
 *    are per *API key*, not per process. Two worker replicas each politely
 *    staying under 30 req/min will still get the key banned at 60 req/min.
 *
 * A bucket refills continuously rather than resetting on a window boundary,
 * which avoids the thundering herd you get at the top of every minute.
 */

export interface RateLimitConfig {
  requestsPerMinute: number;
  /** Max tokens available at once. Defaults to one minute's worth. */
  burst?: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
  capacity: number;
  refillPerMs: number;
}

export class InMemoryRateLimiter implements RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #configs = new Map<string, RateLimitConfig>();
  readonly #clock: Clock;
  readonly #defaultConfig: RateLimitConfig;

  constructor(options: { clock?: Clock; defaultConfig?: RateLimitConfig } = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#defaultConfig = options.defaultConfig ?? { requestsPerMinute: 60 };
  }

  /** Declare a per-key limit. Connectors do this from their descriptor. */
  configure(key: string, config: RateLimitConfig): void {
    this.#configs.set(key, config);
    this.#buckets.delete(key);
  }

  #bucket(key: string): Bucket {
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      const config = this.#configs.get(key) ?? this.#defaultConfig;
      const capacity = config.burst ?? config.requestsPerMinute;
      bucket = {
        tokens: capacity,
        lastRefillMs: this.#clock.now().getTime(),
        capacity,
        refillPerMs: config.requestsPerMinute / 60_000,
      };
      this.#buckets.set(key, bucket);
    }
    return bucket;
  }

  #refill(bucket: Bucket): void {
    const now = this.#clock.now().getTime();
    const elapsed = now - bucket.lastRefillMs;
    if (elapsed <= 0) return;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs);
    bucket.lastRefillMs = now;
  }

  async tryAcquire(key: string): Promise<boolean> {
    const bucket = this.#bucket(key);
    this.#refill(bucket);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  async remaining(key: string): Promise<number> {
    const bucket = this.#bucket(key);
    this.#refill(bucket);
    return Math.floor(bucket.tokens);
  }

  async acquire(key: string, signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new Error(`Rate limit wait aborted for "${key}"`);
      const bucket = this.#bucket(key);
      this.#refill(bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      // Sleep exactly as long as the next token needs, plus a small margin.
      const waitMs = Math.max(10, Math.ceil((1 - bucket.tokens) / bucket.refillPerMs));
      await sleep(Math.min(waitMs, 5_000), signal);
    }
  }
}

/**
 * Redis-backed token bucket, shared across processes.
 *
 * Implemented as a Lua script so refill-check-consume is atomic; doing it with
 * separate GET/SET calls races under concurrency and lets the limit drift.
 */
const BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1])
local ts = tonumber(bucket[2])

if tokens == nil then
  tokens = capacity
  ts = nowMs
end

local elapsed = math.max(0, nowMs - ts)
tokens = math.min(capacity, tokens + elapsed * refillPerMs)

local allowed = 0
if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
end

redis.call('HMSET', key, 'tokens', tokens, 'ts', nowMs)
-- Expire idle buckets so we do not accumulate keys for one-off requests.
redis.call('PEXPIRE', key, math.ceil(capacity / refillPerMs) + 60000)

return { allowed, tostring(tokens) }
`;

export class RedisRateLimiter implements RateLimiter {
  readonly #redis: Redis;
  readonly #configs = new Map<string, RateLimitConfig>();
  readonly #clock: Clock;
  readonly #defaultConfig: RateLimitConfig;
  readonly #prefix: string;

  constructor(
    redis: Redis,
    options: { clock?: Clock; defaultConfig?: RateLimitConfig; prefix?: string } = {},
  ) {
    this.#redis = redis;
    this.#clock = options.clock ?? systemClock;
    this.#defaultConfig = options.defaultConfig ?? { requestsPerMinute: 60 };
    this.#prefix = options.prefix ?? 'cid:ratelimit:';
  }

  configure(key: string, config: RateLimitConfig): void {
    this.#configs.set(key, config);
  }

  #params(key: string): { capacity: number; refillPerMs: number } {
    const config = this.#configs.get(key) ?? this.#defaultConfig;
    return {
      capacity: config.burst ?? config.requestsPerMinute,
      refillPerMs: config.requestsPerMinute / 60_000,
    };
  }

  async #consume(key: string, amount: number): Promise<{ allowed: boolean; tokens: number }> {
    const { capacity, refillPerMs } = this.#params(key);
    const raw = (await this.#redis.eval(
      BUCKET_SCRIPT,
      1,
      `${this.#prefix}${key}`,
      String(capacity),
      String(refillPerMs),
      String(this.#clock.now().getTime()),
      String(amount),
    )) as [number, string];

    return { allowed: raw[0] === 1, tokens: Number.parseFloat(raw[1]) };
  }

  async tryAcquire(key: string): Promise<boolean> {
    const { allowed } = await this.#consume(key, 1);
    return allowed;
  }

  async remaining(key: string): Promise<number> {
    // Consume 0 tokens: refills and reports without taking anything.
    const { tokens } = await this.#consume(key, 0);
    return Math.floor(tokens);
  }

  async acquire(key: string, signal?: AbortSignal): Promise<void> {
    const { refillPerMs } = this.#params(key);
    for (;;) {
      if (signal?.aborted) throw new Error(`Rate limit wait aborted for "${key}"`);
      const { allowed, tokens } = await this.#consume(key, 1);
      if (allowed) return;
      const waitMs = Math.max(25, Math.ceil((1 - tokens) / refillPerMs));
      await sleep(Math.min(waitMs, 5_000), signal);
    }
  }
}

/** Abortable sleep. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
