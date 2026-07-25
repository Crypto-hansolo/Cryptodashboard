import { describe, expect, it } from 'vitest';
import { InMemoryRateLimiter } from './rate-limiter.js';
import { FakeClock } from './testing.js';

describe('InMemoryRateLimiter', () => {
  it('allows a full burst immediately, then refuses', async () => {
    const clock = new FakeClock();
    const limiter = new InMemoryRateLimiter({ clock });
    limiter.configure('cg', { requestsPerMinute: 60, burst: 5 });

    for (let i = 0; i < 5; i++) {
      expect(await limiter.tryAcquire('cg')).toBe(true);
    }
    expect(await limiter.tryAcquire('cg')).toBe(false);
  });

  it('refills continuously rather than on a window boundary', async () => {
    const clock = new FakeClock();
    const limiter = new InMemoryRateLimiter({ clock });
    // 60/min = one token per second.
    limiter.configure('cg', { requestsPerMinute: 60, burst: 2 });

    expect(await limiter.tryAcquire('cg')).toBe(true);
    expect(await limiter.tryAcquire('cg')).toBe(true);
    expect(await limiter.tryAcquire('cg')).toBe(false);

    clock.advance(1_000);
    expect(await limiter.tryAcquire('cg')).toBe(true);
    expect(await limiter.tryAcquire('cg')).toBe(false);

    clock.advance(500);
    // Half a token is not a token.
    expect(await limiter.tryAcquire('cg')).toBe(false);
    clock.advance(500);
    expect(await limiter.tryAcquire('cg')).toBe(true);
  });

  it('never exceeds capacity however long it idles', async () => {
    const clock = new FakeClock();
    const limiter = new InMemoryRateLimiter({ clock });
    limiter.configure('cg', { requestsPerMinute: 60, burst: 3 });

    clock.advance(3_600_000);
    expect(await limiter.remaining('cg')).toBe(3);
    for (let i = 0; i < 3; i++) expect(await limiter.tryAcquire('cg')).toBe(true);
    expect(await limiter.tryAcquire('cg')).toBe(false);
  });

  it('reports remaining tokens without consuming any', async () => {
    const clock = new FakeClock();
    const limiter = new InMemoryRateLimiter({ clock });
    limiter.configure('cg', { requestsPerMinute: 600, burst: 10 });

    expect(await limiter.remaining('cg')).toBe(10);
    expect(await limiter.remaining('cg')).toBe(10);
    await limiter.tryAcquire('cg');
    expect(await limiter.remaining('cg')).toBe(9);
  });

  it('keeps separate buckets per key', async () => {
    const clock = new FakeClock();
    const limiter = new InMemoryRateLimiter({ clock });
    limiter.configure('a', { requestsPerMinute: 60, burst: 1 });
    limiter.configure('b', { requestsPerMinute: 60, burst: 1 });

    expect(await limiter.tryAcquire('a')).toBe(true);
    expect(await limiter.tryAcquire('a')).toBe(false);
    expect(await limiter.tryAcquire('b')).toBe(true);
  });

  it('applies the default config to unconfigured keys', async () => {
    const limiter = new InMemoryRateLimiter({
      clock: new FakeClock(),
      defaultConfig: { requestsPerMinute: 2, burst: 2 },
    });
    expect(await limiter.tryAcquire('unknown')).toBe(true);
    expect(await limiter.tryAcquire('unknown')).toBe(true);
    expect(await limiter.tryAcquire('unknown')).toBe(false);
  });

  it('resets the bucket when a key is reconfigured', async () => {
    const limiter = new InMemoryRateLimiter({ clock: new FakeClock() });
    limiter.configure('cg', { requestsPerMinute: 60, burst: 1 });
    expect(await limiter.tryAcquire('cg')).toBe(true);
    expect(await limiter.tryAcquire('cg')).toBe(false);

    limiter.configure('cg', { requestsPerMinute: 60, burst: 5 });
    expect(await limiter.tryAcquire('cg')).toBe(true);
  });

  it('acquire() resolves immediately when tokens are available', async () => {
    const limiter = new InMemoryRateLimiter({ clock: new FakeClock() });
    limiter.configure('cg', { requestsPerMinute: 60, burst: 1 });
    await expect(limiter.acquire('cg')).resolves.toBeUndefined();
  });

  it('acquire() rejects when the signal is already aborted', async () => {
    const limiter = new InMemoryRateLimiter({ clock: new FakeClock() });
    limiter.configure('cg', { requestsPerMinute: 60, burst: 0 });
    const controller = new AbortController();
    controller.abort();
    await expect(limiter.acquire('cg', controller.signal)).rejects.toThrow();
  });

  it('acquire() waits for a refill using a real clock', async () => {
    // Real clock here on purpose: this asserts that acquire() actually waits
    // rather than spinning, which a fake clock cannot show.
    const limiter = new InMemoryRateLimiter();
    // 6000/min = one token per 10ms.
    limiter.configure('cg', { requestsPerMinute: 6_000, burst: 1 });

    await limiter.acquire('cg');
    const startedAt = Date.now();
    await limiter.acquire('cg');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(5);
  });
});
