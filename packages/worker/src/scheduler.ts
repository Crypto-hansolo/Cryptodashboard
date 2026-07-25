import {
  isRetryable,
  type Clock,
  type Connector,
  type ConnectorContext,
  type ConnectorRegistry,
  type Logger,
  type RealtimeBus,
  type RunStatus,
} from '@cid/core';
import { noopLogger, systemClock } from '@cid/core';
import type { CidRepositories } from '@cid/db';
import { CHANNELS, metrics, type Env } from '@cid/platform';
import type { IngestionService } from './ingestion.js';

/**
 * The collector scheduler.
 *
 * Each connector runs on its own independent timer at its own cadence, rather
 * than everything sharing one tick. That matters because a 10-second price poll
 * and a 15-minute tokenomics poll have nothing to do with each other, and a slow
 * connector must not delay a fast one.
 *
 * Deliberately NOT BullMQ for this part. BullMQ is excellent for durable,
 * distributable work (it is used for enrichment and notifications), but polling
 * a price feed every 10s is neither durable nor distributable work: a missed
 * tick should be *skipped*, not queued and replayed later against stale
 * timestamps. A queue here would accumulate backlog during an outage and then
 * stampede every provider at once on recovery. See docs/DECISIONS.md.
 *
 * Per-connector behaviour:
 *  - overlap prevention: a run still in flight skips the next tick
 *  - failure backoff: consecutive failures push the next attempt out
 *    exponentially, complementing the HTTP client's circuit breaker
 *  - high-water marks: `since` comes from ConnectorState so a poll fetches only
 *    what is new
 */

export interface SchedulerOptions {
  registry: ConnectorRegistry;
  repositories: CidRepositories;
  ingestion: IngestionService;
  /**
   * Base context, used for registry-wide questions (which connectors are
   * enabled, what is missing). Per-run contexts come from {@link contextFor}.
   */
  context: ConnectorContext;
  /**
   * Per-connector context factory.
   *
   * Each connector must get an HTTP client whose `provider` is its own key,
   * because the circuit breaker and rate limiter are both keyed on that string.
   * Sharing one client across all connectors means a single dead RSS feed opens
   * the circuit for CoinGecko, Binance and everything else — and it means the
   * per-connector rate limits declared in each descriptor are never applied.
   */
  contextFor: (connector: Connector) => ConnectorContext;
  realtime: RealtimeBus;
  env: Env;
  logger?: Logger;
  clock?: Clock;
}

interface ConnectorState {
  connector: Connector;
  timer: NodeJS.Timeout | null;
  running: boolean;
  consecutiveFailures: number;
  /** Abort signal for the in-flight run, so shutdown is prompt. */
  controller: AbortController | null;
}

export class Scheduler {
  readonly #options: SchedulerOptions;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #states = new Map<string, ConnectorState>();
  #stopped = false;

  constructor(options: SchedulerOptions) {
    this.#options = options;
    this.#logger = (options.logger ?? noopLogger).child({ component: 'scheduler' });
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Resolve a connector's cadence.
   *
   * The per-domain env override wins, but never below the connector's declared
   * `defaultIntervalMs` — a connector that physically cannot be polled faster
   * says so, and config must not be able to violate that.
   */
  #intervalFor(connector: Connector): number {
    const overrides: Record<string, number> = {
      market: this.#options.env.INTERVAL_MARKET_MS,
      derivatives: this.#options.env.INTERVAL_DERIVATIVES_MS,
      dex: this.#options.env.INTERVAL_MARKET_MS,
      news: this.#options.env.INTERVAL_NEWS_MS,
      social: this.#options.env.INTERVAL_SOCIAL_MS,
      onchain: this.#options.env.INTERVAL_ONCHAIN_MS,
      github: this.#options.env.INTERVAL_GITHUB_MS,
      governance: this.#options.env.INTERVAL_GOVERNANCE_MS,
      tokenomics: this.#options.env.INTERVAL_TOKENOMICS_MS,
    };
    const override = overrides[connector.descriptor.domain];
    return Math.max(
      override ?? connector.descriptor.defaultIntervalMs,
      connector.descriptor.defaultIntervalMs,
    );
  }

  async start(): Promise<void> {
    if (!this.#options.env.INGESTION_ENABLED) {
      this.#logger.warn('ingestion disabled (INGESTION_ENABLED=false); scheduler not started');
      return;
    }

    const enabled = this.#options.registry.listEnabled(this.#options.context);
    const described = this.#options.registry.describe(this.#options.context);
    const disabled = described.filter((entry) => !entry.enabled);

    this.#logger.info(
      { enabled: enabled.length, disabled: disabled.length },
      'starting collector scheduler',
    );
    for (const entry of disabled) {
      // Say exactly which variable is missing; "source disabled" alone is a
      // support ticket waiting to happen.
      this.#logger.warn(
        { connector: entry.descriptor.key, missing: entry.missingRequirements },
        'connector disabled: missing configuration',
      );
    }

    // Register every enabled connector's Source row before any run, so that
    // `sourceKey` -> `sourceId` resolution cannot fail mid-ingest.
    for (const connector of enabled) {
      await this.#options.ingestion.registerConnector(connector);
    }

    // Apply declared rate limits to the shared limiter.
    const registry = this.#options.registry as {
      configureRateLimits?: (c: ConnectorContext) => void;
    };
    registry.configureRateLimits?.(this.#options.context);

    for (const connector of enabled) {
      const state: ConnectorState = {
        connector,
        timer: null,
        running: false,
        consecutiveFailures: 0,
        controller: null,
      };
      this.#states.set(connector.descriptor.key, state);

      // Stagger initial runs. Without this, 18 connectors all fire on boot and
      // the first second of process life is the heaviest.
      const jitter = Math.floor(Math.random() * 5_000);
      state.timer = setTimeout(() => void this.#tick(state), jitter);
    }
  }

  /** One scheduled run, which reschedules itself. */
  async #tick(state: ConnectorState): Promise<void> {
    if (this.#stopped) return;

    const key = state.connector.descriptor.key;

    // Overlap prevention: a slow run must not have a second copy started on top
    // of it, which would double the provider's request rate.
    if (state.running) {
      this.#logger.debug({ connector: key }, 'previous run still in flight, skipping tick');
      this.#reschedule(state);
      return;
    }

    state.running = true;
    state.controller = new AbortController();
    const startedAt = this.#clock.now();
    const startMs = this.#clock.monotonicMs();

    let status: RunStatus = 'SUCCESS';
    let itemsFetched = 0;
    let itemsIngested = 0;
    let error: string | null = null;
    let coinIds: string[] = [];

    try {
      const coins = state.connector.descriptor.batchesCoins
        ? await this.#options.repositories.coins.listTracked(
            Math.min(
              this.#options.env.MAX_TRACKED_COINS,
              state.connector.descriptor.maxCoinsPerRun ?? this.#options.env.MAX_TRACKED_COINS,
            ),
          )
        : await this.#options.repositories.coins.listTracked(this.#options.env.MAX_TRACKED_COINS);

      coinIds = coins.map((coin) => coin.id);

      // High-water mark: only fetch what is new.
      const persisted = await this.#options.repositories.telemetry.getState(key);

      const outcome = await state.connector.collect(
        { coins, since: persisted.lastItemAt, signal: state.controller.signal },
        // Connector-scoped context: its own circuit-breaker and rate-limit key.
        this.#options.contextFor(state.connector),
      );

      if (!outcome.ok) {
        status = 'FAILED';
        error = outcome.error.message;
        state.consecutiveFailures++;

        // A misconfigured connector should stop being polled rather than
        // failing every interval forever.
        if (!isRetryable(outcome.error)) {
          this.#logger.warn(
            { connector: key, err: error },
            'connector failed non-retryably; backing off hard',
          );
        }
      } else {
        itemsFetched = outcome.value.itemsFetched;
        const ingested = await this.#options.ingestion.ingest(key, outcome.value);
        itemsIngested = ingested.eventsCreated + ingested.recordsWritten;
        state.consecutiveFailures = 0;

        // Advance the high-water mark to the newest event we actually stored.
        const newest = outcome.value.events.reduce<Date | null>(
          (latest, event) =>
            latest === null || event.occurredAt > latest ? event.occurredAt : latest,
          null,
        );
        if (newest) {
          await this.#options.repositories.telemetry.setState(key, { lastItemAt: newest });
        } else {
          await this.#options.repositories.telemetry.setState(key, {});
        }

        if (ingested.eventsCreated > 0) {
          this.#logger.info(
            {
              connector: key,
              created: ingested.eventsCreated,
              skipped: ingested.eventsSkipped,
              records: ingested.recordsWritten,
            },
            'ingested new events',
          );
        }
      }
    } catch (thrown) {
      // Defensive: BaseConnector already converts throws to Err, so reaching
      // here means a bug in the scheduler or the ingestion service.
      status = 'FAILED';
      error = thrown instanceof Error ? thrown.message : String(thrown);
      state.consecutiveFailures++;
      this.#logger.error({ connector: key, err: thrown }, 'unhandled error during collector run');
    } finally {
      state.running = false;
      state.controller = null;
      const durationMs = Math.max(0, this.#clock.monotonicMs() - startMs);

      metrics.observe('collector_run_ms', durationMs, { connector: key });
      metrics.increment('collector_items_ingested', { connector: key }, itemsIngested);

      // Telemetry is best-effort: a failure to record a run must not stop the
      // scheduler from continuing to run.
      try {
        await this.#options.repositories.telemetry.recordRun({
          connectorKey: key,
          startedAt,
          finishedAt: this.#clock.now(),
          status,
          itemsFetched,
          itemsIngested,
          durationMs,
          error,
          coinIds: coinIds.slice(0, 50),
        });
        await this.#options.realtime.publish(CHANNELS.connectors, {
          type: 'connector',
          payload: { key, status, at: this.#clock.now().toISOString() },
        });
      } catch (telemetryError) {
        this.#logger.warn(
          { connector: key, err: telemetryError },
          'failed to record run telemetry',
        );
      }

      this.#reschedule(state);
    }
  }

  /**
   * Schedule the next run, with exponential backoff after failures.
   *
   * Capped at 10 minutes: a provider that has been down for an hour is polled
   * every 10 minutes, not every 10 seconds, but is still polled — outages end.
   */
  #reschedule(state: ConnectorState): void {
    if (this.#stopped) return;

    const base = this.#intervalFor(state.connector);
    const backoff =
      state.consecutiveFailures === 0
        ? base
        : Math.min(base * 2 ** Math.min(state.consecutiveFailures, 6), 600_000);

    // Jitter so connectors that failed together do not recover in lockstep.
    const jittered = backoff + Math.floor(Math.random() * Math.min(base, 5_000));
    state.timer = setTimeout(() => void this.#tick(state), jittered);
  }

  /** Run one connector immediately, outside its schedule. Used by admin endpoints. */
  async runNow(connectorKey: string): Promise<boolean> {
    const state = this.#states.get(connectorKey);
    if (!state || state.running) return false;
    if (state.timer) clearTimeout(state.timer);
    await this.#tick(state);
    return true;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const state of this.#states.values()) {
      if (state.timer) clearTimeout(state.timer);
      // Abort in-flight HTTP so shutdown does not wait on a 20s feed timeout.
      state.controller?.abort();
    }
    this.#states.clear();
    this.#logger.info('scheduler stopped');
  }

  /** Diagnostic snapshot for /health. */
  status(): Array<{
    key: string;
    running: boolean;
    consecutiveFailures: number;
    intervalMs: number;
  }> {
    return [...this.#states.values()].map((state) => ({
      key: state.connector.descriptor.key,
      running: state.running,
      consecutiveFailures: state.consecutiveFailures,
      intervalMs: this.#intervalFor(state.connector),
    }));
  }
}
