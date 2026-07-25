import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RateLimitError,
  UnauthorizedError,
  err,
  ok,
  type Coin,
  type CollectionRequest,
  type CollectionResult,
  type Connector,
  type ConnectorContext,
  type ConnectorDescriptor,
  type RealtimeBus,
  type Result,
  type DomainError,
} from '@cid/core';
import { noopLogger } from '@cid/core';
import type { CidRepositories } from '@cid/db';
import type { Env } from '@cid/platform';
import { FakeClock, FakeHttpClient, fakeRepositories } from '@cid/platform/testing';
import { Scheduler } from './scheduler.js';
import type { IngestionService } from './ingestion.js';

/**
 * The scheduler is the part that has to behave under failure, and none of that
 * behaviour is observable without controlling time — so these drive fake timers
 * rather than waiting. What matters: one connector's outage must not affect
 * another's cadence, a slow run must not be doubled up, and a failing provider
 * must be backed off without being abandoned.
 */

const NOW = new Date('2026-07-25T12:00:00.000Z');

function descriptor(overrides: Partial<ConnectorDescriptor> = {}): ConnectorDescriptor {
  return {
    key: 'test-connector',
    name: 'Test',
    domain: 'news',
    sourceKind: 'NEWS',
    homepageUrl: null,
    credibility: 0.8,
    requirements: [],
    defaultIntervalMs: 60_000,
    rateLimit: { requestsPerMinute: 10 },
    batchesCoins: true,
    ...overrides,
  };
}

/** A connector whose per-run outcome is scripted. */
class StubConnector implements Connector {
  readonly descriptor: ConnectorDescriptor;
  readonly requests: CollectionRequest[] = [];
  readonly contexts: ConnectorContext[] = [];
  #outcomes: Array<Result<CollectionResult, DomainError>>;
  #index = 0;
  /** Resolve manually to hold a run open. */
  gate: (() => void) | null = null;

  constructor(
    outcomes: Array<Result<CollectionResult, DomainError>>,
    descriptorOverrides: Partial<ConnectorDescriptor> = {},
  ) {
    this.descriptor = descriptor(descriptorOverrides);
    this.#outcomes = outcomes;
  }

  isEnabled(): boolean {
    return true;
  }

  async collect(
    request: CollectionRequest,
    context: ConnectorContext,
  ): Promise<Result<CollectionResult, DomainError>> {
    this.requests.push(request);
    this.contexts.push(context);
    if (this.gate) {
      await new Promise<void>((resolve) => {
        this.gate = resolve;
      });
    }
    const outcome = this.#outcomes[Math.min(this.#index, this.#outcomes.length - 1)];
    this.#index++;
    return outcome ?? ok(emptyResult());
  }
}

function emptyResult(overrides: Partial<CollectionResult> = {}): CollectionResult {
  return { events: [], records: {}, itemsFetched: 0, ...overrides };
}

function coin(id = 'coin-btc'): Coin {
  return { id, symbol: 'BTC', name: 'Bitcoin' } as Coin;
}

const env = {
  INGESTION_ENABLED: true,
  MAX_TRACKED_COINS: 500,
  INTERVAL_MARKET_MS: 10_000,
  INTERVAL_DERIVATIVES_MS: 30_000,
  INTERVAL_NEWS_MS: 60_000,
  INTERVAL_SOCIAL_MS: 60_000,
  INTERVAL_ONCHAIN_MS: 60_000,
  INTERVAL_GITHUB_MS: 60_000,
  INTERVAL_GOVERNANCE_MS: 300_000,
  INTERVAL_TOKENOMICS_MS: 900_000,
} as unknown as Env;

interface Harness {
  scheduler: Scheduler;
  runs: Array<Record<string, unknown>>;
  states: Array<{ key: string; patch: Record<string, unknown> }>;
  ingested: Array<{ key: string; result: CollectionResult }>;
  published: Array<{ channel: string; message: unknown }>;
  clock: FakeClock;
  contextsBuilt: string[];
}

function harness(
  connectors: readonly Connector[],
  options: {
    envOverrides?: Partial<Env>;
    lastItemAt?: Date | null;
    ingest?: (key: string, result: CollectionResult) => Promise<never> | undefined;
    telemetryThrows?: boolean;
  } = {},
): Harness {
  const runs: Array<Record<string, unknown>> = [];
  const states: Array<{ key: string; patch: Record<string, unknown> }> = [];
  const ingested: Array<{ key: string; result: CollectionResult }> = [];
  const published: Array<{ channel: string; message: unknown }> = [];
  const contextsBuilt: string[] = [];
  const clock = new FakeClock(NOW);

  const repositories = fakeRepositories({
    coins: { listTracked: async () => [coin()] },
    telemetry: {
      getState: async () => ({ lastItemAt: options.lastItemAt ?? null }),
      setState: async (key: string, patch: Record<string, unknown>) => {
        states.push({ key, patch });
      },
      recordRun: async (run: Record<string, unknown>) => {
        if (options.telemetryThrows) throw new Error('telemetry down');
        runs.push(run);
      },
    },
  }) as unknown as CidRepositories;

  const ingestion = {
    registerConnector: async () => {},
    ingest: async (key: string, result: CollectionResult) => {
      const override = options.ingest?.(key, result);
      if (override) await override;
      ingested.push({ key, result });
      return { eventsCreated: result.events.length, eventsSkipped: 0, recordsWritten: 0 };
    },
  } as unknown as IngestionService;

  const realtime: RealtimeBus = {
    publish: async (channel, message) => {
      published.push({ channel, message });
    },
    subscribe: async () => async () => {},
  };

  const baseContext: ConnectorContext = {
    http: new FakeHttpClient(),
    cache: {} as ConnectorContext['cache'],
    logger: noopLogger,
    clock,
    rateLimiter: {} as ConnectorContext['rateLimiter'],
    config: {},
  };

  const registry = {
    listEnabled: () => [...connectors],
    describe: () =>
      connectors.map((connector) => ({
        descriptor: connector.descriptor,
        enabled: true,
        missingRequirements: [],
        degraded: false,
      })),
  };

  const scheduler = new Scheduler({
    registry: registry as never,
    repositories,
    ingestion,
    context: baseContext,
    contextFor: (connector) => {
      contextsBuilt.push(connector.descriptor.key);
      return { ...baseContext, http: new FakeHttpClient() };
    },
    realtime,
    env: { ...env, ...options.envOverrides } as Env,
    logger: noopLogger,
    clock,
  });

  return { scheduler, runs, states, ingested, published, clock, contextsBuilt };
}

describe('Scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Deterministic jitter, so "advance by the interval" is exact.
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not start at all when ingestion is disabled', async () => {
    // INGESTION_ENABLED=false is how the UI is developed against seed data.
    const connector = new StubConnector([ok(emptyResult())]);
    const { scheduler } = harness([connector], { envOverrides: { INGESTION_ENABLED: false } });

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(connector.requests).toHaveLength(0);
    expect(scheduler.status()).toEqual([]);
  });

  it('runs each connector on its own timer at its own cadence', async () => {
    /*
     * The core scheduling property: a 10-second price poll and a 5-minute
     * governance poll are unrelated, and one must not gate the other.
     */
    const fast = new StubConnector([ok(emptyResult())], {
      key: 'fast',
      domain: 'market',
      defaultIntervalMs: 10_000,
    });
    const slow = new StubConnector([ok(emptyResult())], {
      key: 'slow',
      domain: 'governance',
      defaultIntervalMs: 300_000,
    });
    const { scheduler } = harness([fast, slow]);

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    await scheduler.stop();

    // 60s at a 10s cadence is many runs; at 300s it is one (the initial tick).
    expect(fast.requests.length).toBeGreaterThan(4);
    expect(slow.requests).toHaveLength(1);
  });

  it('gives each connector its own HTTP context', async () => {
    /*
     * The circuit breaker and rate limiter are keyed on the client's provider, so
     * a shared client means one dead RSS feed opens the circuit for CoinGecko and
     * Binance too. This was a real bug.
     */
    const a = new StubConnector([ok(emptyResult())], { key: 'a' });
    const b = new StubConnector([ok(emptyResult())], { key: 'b' });
    const { scheduler, contextsBuilt } = harness([a, b]);

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await scheduler.stop();

    expect(contextsBuilt).toContain('a');
    expect(contextsBuilt).toContain('b');
    expect(a.contexts[0]?.http).not.toBe(b.contexts[0]?.http);
  });

  it('refuses to poll faster than the connector declares it can be polled', async () => {
    /*
     * The env override raises cadence but must never lower it below the
     * connector's floor — configuration cannot be allowed to violate what a
     * provider physically permits.
     */
    const connector = new StubConnector([ok(emptyResult())], {
      key: 'floored',
      domain: 'market',
      defaultIntervalMs: 60_000,
    });
    const { scheduler } = harness([connector], {
      envOverrides: { INTERVAL_MARKET_MS: 1_000 },
    });

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await scheduler.stop();

    // Only the initial tick: 30s has not reached the 60s floor.
    expect(connector.requests).toHaveLength(1);
  });

  it('passes the stored high-water mark to the connector', async () => {
    const since = new Date(NOW.getTime() - 3_600_000);
    const connector = new StubConnector([ok(emptyResult())]);
    const { scheduler } = harness([connector], { lastItemAt: since });

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await scheduler.stop();

    expect(connector.requests[0]?.since).toEqual(since);
  });

  it('advances the high-water mark to the newest event actually collected', async () => {
    const newest = new Date(NOW.getTime() - 60_000);
    const connector = new StubConnector([
      ok(
        emptyResult({
          events: [
            { occurredAt: new Date(NOW.getTime() - 600_000) } as never,
            { occurredAt: newest } as never,
          ],
        }),
      ),
    ]);
    const { scheduler, states } = harness([connector]);

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await scheduler.stop();

    expect(states[0]).toEqual({ key: 'test-connector', patch: { lastItemAt: newest } });
  });

  it('touches the state without moving the mark when a run found nothing', async () => {
    // The run still happened; the mark must not jump to now, or a story published
    // during the gap would be skipped forever.
    const connector = new StubConnector([ok(emptyResult())]);
    const { scheduler, states } = harness([connector]);

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await scheduler.stop();

    expect(states[0]).toEqual({ key: 'test-connector', patch: {} });
  });

  it('skips a tick while the previous run is still in flight', async () => {
    /*
     * Without this, a connector slower than its interval accumulates concurrent
     * runs and multiplies the provider's request rate until it is banned.
     */
    const connector = new StubConnector([ok(emptyResult())], {
      key: 'slow-runner',
      domain: 'market',
      defaultIntervalMs: 10_000,
    });
    connector.gate = () => {};
    const { scheduler } = harness([connector]);

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(50_000);

    // Several intervals elapsed, but the first run never finished.
    expect(connector.requests).toHaveLength(1);

    // Release it and confirm scheduling resumes.
    connector.gate?.();
    connector.gate = null;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(connector.requests.length).toBeGreaterThan(1);

    await scheduler.stop();
  });

  it('records a successful run in telemetry and announces it', async () => {
    const connector = new StubConnector([ok(emptyResult({ itemsFetched: 7 }))]);
    const { scheduler, runs, published } = harness([connector]);

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await scheduler.stop();

    expect(runs[0]).toMatchObject({
      connectorKey: 'test-connector',
      status: 'SUCCESS',
      itemsFetched: 7,
    });
    expect(published[0]).toMatchObject({
      channel: 'cid:connectors',
      message: { type: 'connector', payload: { key: 'test-connector', status: 'SUCCESS' } },
    });
  });

  it('records a failed run without ingesting anything', async () => {
    const connector = new StubConnector([err(new RateLimitError('provider', 30))]);
    const { scheduler, runs, ingested } = harness([connector]);

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await scheduler.stop();

    expect(runs[0]).toMatchObject({ status: 'FAILED', itemsFetched: 0 });
    expect(runs[0]?.error).toContain('rate limited');
    expect(ingested).toEqual([]);
  });

  it('backs off exponentially after consecutive failures', async () => {
    /*
     * A provider returning 503 every 10 seconds should be polled less and less
     * often, not hammered — the breaker handles the request layer, this handles
     * the schedule.
     */
    const connector = new StubConnector([err(new RateLimitError('provider'))], {
      key: 'failing',
      domain: 'market',
      defaultIntervalMs: 10_000,
    });
    const { scheduler } = harness([connector]);

    await scheduler.start();

    // First tick fires immediately (jitter mocked to 0).
    await vi.advanceTimersByTimeAsync(1);
    expect(connector.requests).toHaveLength(1);

    // After one failure the next attempt is 2x the base interval away.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connector.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connector.requests).toHaveLength(2);

    // After two failures, 4x — so 30s is not yet enough, 40s is.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connector.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connector.requests).toHaveLength(3);

    await scheduler.stop();
  });

  it('keeps polling a persistently failing provider, just rarely', async () => {
    // Outages end. Abandoning a source permanently would need manual recovery.
    const connector = new StubConnector([err(new UnauthorizedError('provider'))], {
      key: 'broken',
      domain: 'market',
      defaultIntervalMs: 10_000,
    });
    const { scheduler } = harness([connector]);

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(3_600_000);
    await scheduler.stop();

    // Backoff caps at 10 minutes, so an hour yields a handful of attempts —
    // more than one, far fewer than 360.
    expect(connector.requests.length).toBeGreaterThan(1);
    expect(connector.requests.length).toBeLessThan(30);
  });

  it('resets the backoff after a success', async () => {
    const connector = new StubConnector(
      [err(new RateLimitError('provider')), ok(emptyResult()), ok(emptyResult())],
      { key: 'recovering', domain: 'market', defaultIntervalMs: 10_000 },
    );
    const { scheduler } = harness([connector]);

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    // Failure, so the next attempt is 20s out.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(connector.requests).toHaveLength(2);

    // That one succeeded, so the cadence is back to 10s.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connector.requests).toHaveLength(3);

    await scheduler.stop();
  });

  it('survives a connector that throws instead of returning an error', async () => {
    // BaseConnector converts throws, so reaching this means a bug elsewhere —
    // and it must not take the scheduler down.
    const throwing: Connector = {
      descriptor: descriptor({ key: 'throwing', domain: 'market', defaultIntervalMs: 10_000 }),
      isEnabled: () => true,
      collect: async () => {
        throw new Error('unexpected');
      },
    };
    const { scheduler, runs } = harness([throwing]);

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(runs[0]).toMatchObject({ status: 'FAILED', error: 'unexpected' });

    // Still scheduled afterwards.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runs.length).toBeGreaterThan(1);

    await scheduler.stop();
  });

  it('keeps running when telemetry itself fails', async () => {
    // Failing to record a run is not a reason to stop collecting.
    const connector = new StubConnector([ok(emptyResult())], {
      key: 'ok',
      domain: 'market',
      defaultIntervalMs: 10_000,
    });
    const { scheduler } = harness([connector], { telemetryThrows: true });

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(40_000);
    await scheduler.stop();

    expect(connector.requests.length).toBeGreaterThan(1);
  });

  it('caps the coin batch to the connector limit', async () => {
    const connector = new StubConnector([ok(emptyResult())], {
      key: 'batched',
      batchesCoins: true,
      maxCoinsPerRun: 1,
    });
    const { scheduler } = harness([connector]);

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await scheduler.stop();

    expect(connector.requests[0]?.coins).toHaveLength(1);
  });

  it('runs a connector on demand, outside its schedule', async () => {
    const connector = new StubConnector([ok(emptyResult())], { key: 'manual' });
    const { scheduler } = harness([connector]);

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    const before = connector.requests.length;

    expect(await scheduler.runNow('manual')).toBe(true);
    expect(connector.requests.length).toBe(before + 1);

    await scheduler.stop();
  });

  it('refuses an on-demand run for an unknown connector', async () => {
    const { scheduler } = harness([new StubConnector([ok(emptyResult())])]);
    await scheduler.start();

    expect(await scheduler.runNow('not-registered')).toBe(false);

    await scheduler.stop();
  });

  it('stops scheduling and aborts in-flight work on shutdown', async () => {
    /*
     * Shutdown must not wait out a 20-second feed timeout, so the in-flight
     * request's signal is aborted.
     */
    const connector = new StubConnector([ok(emptyResult())], {
      key: 'aborting',
      domain: 'market',
      defaultIntervalMs: 10_000,
    });
    connector.gate = () => {};
    const { scheduler } = harness([connector]);

    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1);
    const signal = connector.requests[0]?.signal;
    expect(signal?.aborted).toBe(false);

    await scheduler.stop();

    expect(signal?.aborted).toBe(true);

    connector.gate?.();
    await vi.advanceTimersByTimeAsync(60_000);
    // No further runs after stop.
    expect(connector.requests).toHaveLength(1);
  });

  it('reports a status snapshot for the health endpoint', async () => {
    const connector = new StubConnector([ok(emptyResult())], { key: 'watched' });
    const { scheduler } = harness([connector]);

    await scheduler.start();
    const status = scheduler.status();

    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ key: 'watched' });

    await scheduler.stop();
  });
});
