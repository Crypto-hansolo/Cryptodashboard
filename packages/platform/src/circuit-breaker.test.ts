import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.js';
import { FakeClock } from './testing.js';

describe('CircuitBreaker', () => {
  const build = () => {
    const clock = new FakeClock();
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 30_000,
      successThreshold: 2,
      maxCooldownMs: 240_000,
      clock,
    });
    return { clock, breaker };
  };

  it('starts closed and admits requests', () => {
    const { breaker } = build();
    expect(breaker.state('cg')).toBe('CLOSED');
    expect(breaker.canRequest('cg')).toBe(true);
  });

  it('opens after the failure threshold and then fails fast', () => {
    const { breaker } = build();
    for (let i = 0; i < 3; i++) breaker.recordFailure('cg');
    expect(breaker.state('cg')).toBe('OPEN');
    expect(breaker.canRequest('cg')).toBe(false);
  });

  it('does not open on scattered failures interrupted by successes', () => {
    const { breaker } = build();
    breaker.recordFailure('cg');
    breaker.recordFailure('cg');
    breaker.recordSuccess('cg');
    breaker.recordFailure('cg');
    breaker.recordFailure('cg');
    expect(breaker.state('cg')).toBe('CLOSED');
  });

  it('admits a single probe once the cooldown elapses', () => {
    const { breaker, clock } = build();
    for (let i = 0; i < 3; i++) breaker.recordFailure('cg');

    clock.advance(29_999);
    expect(breaker.canRequest('cg')).toBe(false);

    clock.advance(2);
    expect(breaker.canRequest('cg')).toBe(true);
    expect(breaker.state('cg')).toBe('HALF_OPEN');
    // Only one probe at a time: a concurrent caller is refused.
    expect(breaker.canRequest('cg')).toBe(false);
  });

  it('closes after enough consecutive probe successes', () => {
    const { breaker, clock } = build();
    for (let i = 0; i < 3; i++) breaker.recordFailure('cg');
    clock.advance(30_001);

    breaker.canRequest('cg');
    breaker.recordSuccess('cg');
    expect(breaker.state('cg')).toBe('HALF_OPEN');

    breaker.canRequest('cg');
    breaker.recordSuccess('cg');
    expect(breaker.state('cg')).toBe('CLOSED');
    expect(breaker.canRequest('cg')).toBe(true);
  });

  it('reopens with a doubled cooldown when a probe fails', () => {
    const { breaker, clock } = build();
    for (let i = 0; i < 3; i++) breaker.recordFailure('cg');
    const firstReopen = breaker.reopensAt('cg');

    clock.advance(30_001);
    breaker.canRequest('cg');
    breaker.recordFailure('cg');

    expect(breaker.state('cg')).toBe('OPEN');
    // Second window is 60s, not another 30s.
    clock.advance(30_001);
    expect(breaker.canRequest('cg')).toBe(false);
    clock.advance(30_001);
    expect(breaker.canRequest('cg')).toBe(true);
    expect(breaker.reopensAt('cg')).not.toEqual(firstReopen);
  });

  it('caps the escalating cooldown', () => {
    const { breaker, clock } = build();
    for (let i = 0; i < 3; i++) breaker.recordFailure('cg');
    // Keep failing probes; cooldown doubles 30s -> 60 -> 120 -> 240 (capped).
    for (let i = 0; i < 8; i++) {
      clock.advance(500_000);
      breaker.canRequest('cg');
      breaker.recordFailure('cg');
    }
    const reopensAt = breaker.reopensAt('cg');
    expect(reopensAt).not.toBeNull();
    expect(reopensAt!.getTime() - clock.now().getTime()).toBeLessThanOrEqual(240_000);
  });

  it('resets the escalated cooldown after a full recovery', () => {
    const { breaker, clock } = build();
    for (let i = 0; i < 3; i++) breaker.recordFailure('cg');
    clock.advance(30_001);
    breaker.canRequest('cg');
    breaker.recordFailure('cg'); // cooldown now 60s

    clock.advance(60_001);
    breaker.canRequest('cg');
    breaker.recordSuccess('cg');
    breaker.canRequest('cg');
    breaker.recordSuccess('cg');
    expect(breaker.state('cg')).toBe('CLOSED');

    // Fail again: back to the base 30s window, not the escalated one.
    for (let i = 0; i < 3; i++) breaker.recordFailure('cg');
    clock.advance(30_001);
    expect(breaker.canRequest('cg')).toBe(true);
  });

  it('tracks providers independently', () => {
    const { breaker } = build();
    for (let i = 0; i < 3; i++) breaker.recordFailure('cg');
    expect(breaker.canRequest('cg')).toBe(false);
    expect(breaker.canRequest('binance')).toBe(true);
  });

  it('exposes a diagnostic snapshot', () => {
    const { breaker } = build();
    for (let i = 0; i < 3; i++) breaker.recordFailure('cg');
    breaker.recordSuccess('binance');

    const snapshot = breaker.snapshot();
    expect(snapshot).toHaveLength(2);
    const cg = snapshot.find((s) => s.key === 'cg');
    expect(cg?.state).toBe('OPEN');
    expect(cg?.reopensAt).toBeInstanceOf(Date);
    expect(snapshot.find((s) => s.key === 'binance')?.state).toBe('CLOSED');
  });

  it('reports no reopen time for a closed circuit', () => {
    const { breaker } = build();
    expect(breaker.reopensAt('cg')).toBeNull();
  });

  it('can be reset', () => {
    const { breaker } = build();
    for (let i = 0; i < 3; i++) breaker.recordFailure('cg');
    breaker.reset('cg');
    expect(breaker.state('cg')).toBe('CLOSED');

    for (let i = 0; i < 3; i++) breaker.recordFailure('a');
    breaker.reset();
    expect(breaker.snapshot()).toHaveLength(0);
  });
});
