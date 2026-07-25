import type { Clock } from '@cid/core';
import { systemClock } from '@cid/core';

/**
 * Per-provider circuit breaker.
 *
 * With ~30 upstreams polled every 10-60s, one dead provider generates thousands
 * of failing requests per hour. Each one costs a socket, a timeout wait and a
 * log line, and on a shared rate limit it starves the providers that *are*
 * healthy. The breaker converts that into one probe per cooldown window.
 *
 * States: CLOSED (normal) -> OPEN (failing fast) -> HALF_OPEN (one trial
 * request) -> CLOSED or back to OPEN.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening. */
  failureThreshold?: number;
  /** How long to stay open before allowing a trial request. */
  cooldownMs?: number;
  /** Successes required in HALF_OPEN before fully closing. */
  successThreshold?: number;
  /** Cap on cooldown growth when a provider stays broken. */
  maxCooldownMs?: number;
  clock?: Clock;
}

interface CircuitEntry {
  state: CircuitState;
  failures: number;
  successes: number;
  openedAt: number | null;
  /** Doubles on each re-open, so a long outage is polled less and less. */
  cooldownMs: number;
  /** True while a HALF_OPEN trial request is in flight. */
  probeInFlight: boolean;
}

export interface CircuitSnapshot {
  key: string;
  state: CircuitState;
  failures: number;
  reopensAt: Date | null;
}

export class CircuitBreaker {
  readonly #failureThreshold: number;
  readonly #baseCooldownMs: number;
  readonly #successThreshold: number;
  readonly #maxCooldownMs: number;
  readonly #clock: Clock;
  readonly #circuits = new Map<string, CircuitEntry>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.#failureThreshold = options.failureThreshold ?? 5;
    this.#baseCooldownMs = options.cooldownMs ?? 30_000;
    this.#successThreshold = options.successThreshold ?? 2;
    this.#maxCooldownMs = options.maxCooldownMs ?? 600_000;
    this.#clock = options.clock ?? systemClock;
  }

  #entry(key: string): CircuitEntry {
    let entry = this.#circuits.get(key);
    if (!entry) {
      entry = {
        state: 'CLOSED',
        failures: 0,
        successes: 0,
        openedAt: null,
        cooldownMs: this.#baseCooldownMs,
        probeInFlight: false,
      };
      this.#circuits.set(key, entry);
    }
    return entry;
  }

  /**
   * Whether a request may proceed. Transitions OPEN -> HALF_OPEN once the
   * cooldown has elapsed, and admits exactly one probe at a time so a burst of
   * callers does not all hit a still-broken provider.
   */
  canRequest(key: string): boolean {
    const entry = this.#entry(key);
    if (entry.state === 'CLOSED') return true;

    if (entry.state === 'OPEN') {
      const elapsed = this.#clock.now().getTime() - (entry.openedAt ?? 0);
      if (elapsed < entry.cooldownMs) return false;
      entry.state = 'HALF_OPEN';
      entry.successes = 0;
      entry.probeInFlight = true;
      return true;
    }

    // HALF_OPEN: admit only if no probe is currently outstanding.
    if (entry.probeInFlight) return false;
    entry.probeInFlight = true;
    return true;
  }

  recordSuccess(key: string): void {
    const entry = this.#entry(key);
    entry.probeInFlight = false;

    if (entry.state === 'HALF_OPEN') {
      entry.successes++;
      if (entry.successes >= this.#successThreshold) {
        entry.state = 'CLOSED';
        entry.failures = 0;
        entry.successes = 0;
        entry.openedAt = null;
        // Recovery resets the escalated cooldown.
        entry.cooldownMs = this.#baseCooldownMs;
      }
      return;
    }

    entry.failures = 0;
  }

  recordFailure(key: string): void {
    const entry = this.#entry(key);
    entry.probeInFlight = false;
    entry.failures++;

    if (entry.state === 'HALF_OPEN') {
      // The trial failed: reopen with a doubled cooldown.
      entry.state = 'OPEN';
      entry.openedAt = this.#clock.now().getTime();
      entry.cooldownMs = Math.min(entry.cooldownMs * 2, this.#maxCooldownMs);
      entry.successes = 0;
      return;
    }

    if (entry.state === 'CLOSED' && entry.failures >= this.#failureThreshold) {
      entry.state = 'OPEN';
      entry.openedAt = this.#clock.now().getTime();
    }
  }

  state(key: string): CircuitState {
    return this.#entry(key).state;
  }

  /** When an OPEN circuit will next admit a probe. */
  reopensAt(key: string): Date | null {
    const entry = this.#entry(key);
    if (entry.state !== 'OPEN' || entry.openedAt === null) return null;
    return new Date(entry.openedAt + entry.cooldownMs);
  }

  /** Diagnostic view for /health and the status UI. */
  snapshot(): CircuitSnapshot[] {
    return [...this.#circuits.entries()].map(([key, entry]) => ({
      key,
      state: entry.state,
      failures: entry.failures,
      reopensAt:
        entry.state === 'OPEN' && entry.openedAt !== null
          ? new Date(entry.openedAt + entry.cooldownMs)
          : null,
    }));
  }

  reset(key?: string): void {
    if (key === undefined) this.#circuits.clear();
    else this.#circuits.delete(key);
  }
}
