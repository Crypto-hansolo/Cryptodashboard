import type { Cache } from '@cid/core';
import type Redis from 'ioredis';
import type { Logger } from '@cid/core';
import { noopLogger } from '@cid/core';

/**
 * Caching with single-flight.
 *
 * `remember()` is the important part. Without it, 12 collectors starting at the
 * same tick all miss the cache for the same CoinGecko URL and all call upstream,
 * which is both a rate-limit violation and a waste. The in-flight map collapses
 * concurrent callers for one key onto a single promise.
 *
 * Note the single-flight map is per-process: two worker replicas can still each
 * make one call. That is acceptable (the rate limiter is the cross-process
 * guard) and avoids needing distributed locks on the hot path.
 */

export class RedisCache implements Cache {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #defaultTtl: number;
  readonly #logger: Logger;
  readonly #inFlight = new Map<string, Promise<unknown>>();

  constructor(
    redis: Redis,
    options: { prefix?: string; defaultTtlSeconds?: number; logger?: Logger } = {},
  ) {
    this.#redis = redis;
    this.#prefix = options.prefix ?? 'cid:cache:';
    this.#defaultTtl = options.defaultTtlSeconds ?? 30;
    this.#logger = options.logger ?? noopLogger;
  }

  #key(key: string): string {
    return `${this.#prefix}${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.#redis.get(this.#key(key));
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch (error) {
      // A cache miss is always survivable; a cache error must not be.
      this.#logger.warn({ key, err: error }, 'cache read failed, treating as miss');
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? this.#defaultTtl;
    try {
      const payload = JSON.stringify(value);
      if (ttl > 0) await this.#redis.set(this.#key(key), payload, 'EX', ttl);
      else await this.#redis.set(this.#key(key), payload);
    } catch (error) {
      this.#logger.warn({ key, err: error }, 'cache write failed');
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.#redis.del(this.#key(key));
    } catch (error) {
      this.#logger.warn({ key, err: error }, 'cache delete failed');
    }
  }

  async remember<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const existing = this.#inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = (async () => {
      try {
        const value = await factory();
        await this.set(key, value, ttlSeconds);
        return value;
      } finally {
        this.#inFlight.delete(key);
      }
    })();

    this.#inFlight.set(key, promise);
    return promise;
  }

  /**
   * Delete by glob pattern using SCAN, never KEYS — KEYS blocks the Redis event
   * loop, and this runs against a database that also carries the job queues.
   */
  async invalidate(pattern: string): Promise<number> {
    let cursor = '0';
    let deleted = 0;
    const match = this.#key(pattern);
    try {
      do {
        const [next, keys] = await this.#redis.scan(cursor, 'MATCH', match, 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) deleted += await this.#redis.del(...keys);
      } while (cursor !== '0');
    } catch (error) {
      this.#logger.warn({ pattern, err: error }, 'cache invalidate failed');
    }
    return deleted;
  }
}

/**
 * In-memory cache for tests and for the "no Redis" path.
 * Bounded so a long-running process cannot leak unboundedly.
 */
export class InMemoryCache implements Cache {
  readonly #store = new Map<string, { value: unknown; expiresAtMs: number | null }>();
  readonly #inFlight = new Map<string, Promise<unknown>>();
  readonly #maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    this.#maxEntries = options.maxEntries ?? 10_000;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.#store.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
      this.#store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    if (this.#store.size >= this.#maxEntries && !this.#store.has(key)) {
      // Cheap eviction: drop the oldest insertion. Map preserves insertion order.
      const oldest = this.#store.keys().next();
      if (!oldest.done) this.#store.delete(oldest.value);
    }
    this.#store.set(key, {
      value,
      expiresAtMs:
        ttlSeconds !== undefined && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null,
    });
  }

  async del(key: string): Promise<void> {
    this.#store.delete(key);
  }

  async remember<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const existing = this.#inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = (async () => {
      try {
        const value = await factory();
        await this.set(key, value, ttlSeconds);
        return value;
      } finally {
        this.#inFlight.delete(key);
      }
    })();
    this.#inFlight.set(key, promise);
    return promise;
  }

  async invalidate(pattern: string): Promise<number> {
    // Translate a glob into a RegExp: `*` -> `.*`, everything else literal.
    const regex = new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
    );
    let deleted = 0;
    for (const key of [...this.#store.keys()]) {
      if (regex.test(key)) {
        this.#store.delete(key);
        deleted++;
      }
    }
    return deleted;
  }

  get size(): number {
    return this.#store.size;
  }
}
