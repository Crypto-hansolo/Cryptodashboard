import { describe, expect, it, vi } from 'vitest';
import { InMemoryCache } from './cache.js';

describe('InMemoryCache', () => {
  it('round-trips values', async () => {
    const cache = new InMemoryCache();
    await cache.set('k', { a: 1 });
    expect(await cache.get<{ a: number }>('k')).toEqual({ a: 1 });
  });

  it('returns null for a missing key', async () => {
    expect(await new InMemoryCache().get('nope')).toBeNull();
  });

  it('expires entries after their TTL', async () => {
    vi.useFakeTimers();
    try {
      const cache = new InMemoryCache();
      await cache.set('k', 'v', 10);
      expect(await cache.get('k')).toBe('v');
      vi.advanceTimersByTime(10_001);
      expect(await cache.get('k')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a zero or absent TTL as no expiry', async () => {
    vi.useFakeTimers();
    try {
      const cache = new InMemoryCache();
      await cache.set('a', 'v');
      await cache.set('b', 'v', 0);
      vi.advanceTimersByTime(86_400_000);
      expect(await cache.get('a')).toBe('v');
      expect(await cache.get('b')).toBe('v');
    } finally {
      vi.useRealTimers();
    }
  });

  it('deletes keys', async () => {
    const cache = new InMemoryCache();
    await cache.set('k', 'v');
    await cache.del('k');
    expect(await cache.get('k')).toBeNull();
  });

  it('remember() computes once and caches the result', async () => {
    const cache = new InMemoryCache();
    const factory = vi.fn(async () => 'computed');

    expect(await cache.remember('k', 60, factory)).toBe('computed');
    expect(await cache.remember('k', 60, factory)).toBe('computed');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('remember() collapses concurrent callers onto one upstream call', async () => {
    // This is the property that stops 12 collectors stampeding a rate-limited API.
    const cache = new InMemoryCache();
    // The gate is created up front, not inside the factory: `remember` awaits a
    // cache read before it ever calls the factory, so a resolver captured from
    // inside would still be unassigned when the test tries to release it.
    let releaseGate!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      releaseGate = resolve;
    });
    const factory = vi.fn(() => gate);

    const all = Promise.all([
      cache.remember('k', 60, factory),
      cache.remember('k', 60, factory),
      cache.remember('k', 60, factory),
    ]);
    releaseGate('once');

    expect(await all).toEqual(['once', 'once', 'once']);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('remember() does not cache a rejection, and clears the in-flight entry', async () => {
    const cache = new InMemoryCache();
    const failing = vi.fn(async () => {
      throw new Error('upstream down');
    });
    await expect(cache.remember('k', 60, failing)).rejects.toThrow('upstream down');
    // A later call must be free to try again.
    expect(await cache.remember('k', 60, async () => 'recovered')).toBe('recovered');
  });

  it('invalidates by glob pattern', async () => {
    const cache = new InMemoryCache();
    await cache.set('coin:btc:quote', 1);
    await cache.set('coin:eth:quote', 2);
    await cache.set('news:latest', 3);

    expect(await cache.invalidate('coin:*')).toBe(2);
    expect(await cache.get('coin:btc:quote')).toBeNull();
    expect(await cache.get('news:latest')).toBe(3);
  });

  it('treats regex metacharacters in a pattern literally', async () => {
    const cache = new InMemoryCache();
    await cache.set('a.b', 1);
    await cache.set('axb', 2);
    expect(await cache.invalidate('a.b')).toBe(1);
    expect(await cache.get('axb')).toBe(2);
  });

  it('evicts the oldest entry when full', async () => {
    const cache = new InMemoryCache({ maxEntries: 2 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.set('c', 3);

    expect(cache.size).toBe(2);
    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('c')).toBe(3);
  });

  it('overwriting an existing key does not trigger eviction', async () => {
    const cache = new InMemoryCache({ maxEntries: 2 });
    await cache.set('a', 1);
    await cache.set('b', 2);
    await cache.set('a', 99);
    expect(cache.size).toBe(2);
    expect(await cache.get('b')).toBe(2);
    expect(await cache.get('a')).toBe(99);
  });
});
