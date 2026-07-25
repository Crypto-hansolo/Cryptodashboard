import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { Cron } from 'croner';
import { systemClock, type ConnectorContext } from '@cid/core';
import {
  CircuitBreaker,
  Container,
  RedisCache,
  RedisRateLimiter,
  RedisRealtimeBus,
  ResilientHttpClient,
  TOKENS,
  connectorConfig,
  createLogger,
  createRedis,
  metrics,
  parseEnv,
  redactEnv,
} from '@cid/platform';
import { buildRepositories } from '@cid/db';
import { buildConnectorRegistry } from '@cid/connectors';
import {
  LexiconEnricher,
  LlmEnricher,
  ReportGenerator,
  createEmbeddingClient,
  createLlmClient,
} from '@cid/ai';
import { IngestionService } from './ingestion.js';
import { Scheduler } from './scheduler.js';
import { AlertEngine, buildMarketSignals, buildUnlockSignals } from './alerts.js';
import { EnrichmentWorker } from './enrichment.js';
import {
  DesktopNotifier,
  DiscordNotifier,
  EmailNotifier,
  NotificationDispatcher,
  TelegramNotifier,
  WebhookNotifier,
} from './notifications.js';

/**
 * Worker entrypoint — the composition root for the background runtime.
 *
 * Everything is wired here and nowhere else: modules receive their dependencies
 * as constructor arguments, so nothing below this file reaches for a global.
 * That is what makes the whole system testable with fakes.
 *
 * Responsibilities: run collectors on independent cadences, enrich events,
 * evaluate alerts, generate scheduled reports, and prune old data.
 */

// Resolve the repo-root .env regardless of the cwd the process was started from.
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

async function main(): Promise<void> {
  const env = parseEnv();
  const logger = createLogger(env);
  const container = new Container();

  logger.info({ config: redactEnv(env) }, 'starting crypto-intelligence-dashboard worker');

  // ── Infrastructure ──
  container.value(TOKENS.env, env);
  container.value(TOKENS.logger, logger);
  container.value(TOKENS.clock, systemClock);

  container.singleton(
    TOKENS.redis,
    () => createRedis({ url: env.REDIS_URL, logger, role: 'worker' }),
    {
      dispose: (client) => {
        client.disconnect();
      },
    },
  );

  container.singleton(
    TOKENS.cache,
    (c) =>
      new RedisCache(c.resolve(TOKENS.redis), {
        defaultTtlSeconds: env.CACHE_TTL_SECONDS,
        logger,
      }),
  );

  // Redis-backed so provider limits are respected per API key rather than per
  // process — two worker replicas must not each spend the full budget.
  container.singleton(
    TOKENS.rateLimiter,
    (c) =>
      new RedisRateLimiter(c.resolve(TOKENS.redis), { defaultConfig: { requestsPerMinute: 30 } }),
  );

  container.singleton(TOKENS.circuitBreaker, () => new CircuitBreaker({ clock: systemClock }));

  container.singleton(TOKENS.realtime, () => new RedisRealtimeBus({ url: env.REDIS_URL, logger }), {
    dispose: async (bus) => {
      await (bus as RedisRealtimeBus).close();
    },
  });

  // ── Persistence ──
  const { db, repositories } = buildRepositories({
    databaseUrl: env.DATABASE_URL,
    logger,
    embeddingDimensions: env.EMBEDDING_DIMENSIONS,
  });
  container.value(TOKENS.prisma, db);
  container.value(TOKENS.repositories, repositories);

  const cache = container.resolve(TOKENS.cache);
  const rateLimiter = container.resolve(TOKENS.rateLimiter);
  const circuitBreaker = container.resolve(TOKENS.circuitBreaker);
  const realtime = container.resolve(TOKENS.realtime);

  // ── AI ──
  //
  // A shared HTTP client for the model backend, with a long timeout: local
  // inference on CPU legitimately takes tens of seconds, and the default 15s
  // budget would abort every request.
  const llmHttp = new ResilientHttpClient({
    provider: 'llm',
    logger,
    defaultTimeoutMs: env.LLM_TIMEOUT_MS,
    // No retries: a timed-out local inference is usually a too-large model, and
    // retrying triples the queue for the same failure.
    maxRetries: 0,
    circuitBreaker,
  });

  const llm = createLlmClient(env.LLM_PROVIDER, {
    http: llmHttp,
    baseUrl: env.LLM_BASE_URL,
    model: env.LLM_MODEL,
    apiKey: env.LLM_API_KEY,
    temperature: env.LLM_TEMPERATURE,
    maxTokens: env.LLM_MAX_TOKENS,
    timeoutMs: env.LLM_TIMEOUT_MS,
    logger,
  });

  const embeddings = createEmbeddingClient(env.EMBEDDING_PROVIDER, {
    http: llmHttp,
    baseUrl: env.EMBEDDING_BASE_URL,
    model: env.EMBEDDING_MODEL,
    apiKey: env.LLM_API_KEY,
    dimensions: env.EMBEDDING_DIMENSIONS,
    timeoutMs: env.LLM_TIMEOUT_MS,
    logger,
  });

  // Probe the backend at boot so a misconfigured LLM_BASE_URL is reported once,
  // clearly, rather than as a failure on every enrichment attempt.
  let llmAvailable = false;
  if (llm) {
    llmAvailable = await llm.isAvailable();
    if (llmAvailable) {
      logger.info({ provider: llm.provider, model: llm.model }, 'llm backend reachable');
    } else {
      logger.warn(
        { provider: llm.provider, baseUrl: env.LLM_BASE_URL },
        'llm backend unreachable; falling back to deterministic lexicon enrichment',
      );
    }
  } else {
    logger.info('LLM_PROVIDER=null; AI enrichment disabled, using lexicon scoring');
  }

  const enricher = llm && llmAvailable ? new LlmEnricher({ llm, logger }) : new LexiconEnricher();
  container.value(TOKENS.llm, llm);
  container.value(TOKENS.embeddings, embeddings);
  container.value(TOKENS.enricher, enricher);

  // ── Notifications & alerts ──
  const notifierHttp = new ResilientHttpClient({
    provider: 'notifications',
    logger,
    maxRetries: 2,
  });

  const dispatcher = new NotificationDispatcher(
    [
      new DesktopNotifier(),
      new DiscordNotifier(notifierHttp, env),
      new TelegramNotifier(notifierHttp, env),
      new EmailNotifier(env, { logger }),
      new WebhookNotifier(notifierHttp, env),
    ],
    { logger },
  );
  logger.info({ channels: dispatcher.configuredChannels() }, 'notification channels configured');

  const alerts = new AlertEngine({ repositories, dispatcher, realtime, logger });

  // ── Ingestion & connectors ──
  const ingestion = new IngestionService({ repositories, realtime, logger });

  const connectorConfigMap = connectorConfig(env);

  /**
   * One HTTP client per connector, memoised.
   *
   * The `provider` string is the key the circuit breaker and rate limiter both
   * use, so it must be the connector's own key. A single shared client makes one
   * dead RSS feed open the circuit for every other source, and silently discards
   * the per-connector rate limits each descriptor declares.
   *
   * The CircuitBreaker *instance* is shared deliberately — it partitions state by
   * provider internally, and sharing it gives /health one unified snapshot.
   */
  const httpClients = new Map<string, ResilientHttpClient>();
  const contextFor = (connectorKey: string): ConnectorContext => {
    let http = httpClients.get(connectorKey);
    if (!http) {
      http = new ResilientHttpClient({
        provider: connectorKey,
        cache,
        rateLimiter,
        circuitBreaker,
        logger,
        defaultTimeoutMs: 15_000,
        maxRetries: 3,
      });
      httpClients.set(connectorKey, http);
    }
    return {
      http,
      cache,
      logger,
      clock: systemClock,
      rateLimiter,
      config: connectorConfigMap,
    };
  };

  // Registry-wide context: only its `config` is read (to decide which
  // connectors are enabled), so the HTTP client attached here is never used for
  // a collector run.
  const connectorContext = contextFor('registry');

  const registry = buildConnectorRegistry({
    coins: repositories.coins,
    quotes: repositories.market,
    baselines: repositories.content,
  });
  container.value(TOKENS.connectors, registry);

  const scheduler = new Scheduler({
    registry,
    repositories,
    ingestion,
    context: connectorContext,
    contextFor: (connector) => contextFor(connector.descriptor.key),
    realtime,
    env,
    logger,
  });

  const enrichment = new EnrichmentWorker({
    repositories,
    enricher,
    embeddings,
    alerts,
    realtime,
    logger,
    concurrency: env.LLM_CONCURRENCY,
  });

  const reports = new ReportGenerator({ repositories, llm, logger });

  // ── Start ──
  const shutdown = new AbortController();

  await scheduler.start();
  void enrichment.start(env.INTERVAL_ENRICHMENT_MS, shutdown.signal);

  /**
   * Market-signal loop for price/volume/funding alerts.
   *
   * Separate from the collectors because these rules compare the *current* quote
   * against history, so they must run after prices land rather than as part of
   * fetching them.
   */
  const marketAlertInterval = setInterval(
    () => {
      void (async () => {
        try {
          const coins = await repositories.coins.listTracked(env.MAX_TRACKED_COINS);
          const coinIds = coins.map((coin) => coin.id);
          if (coinIds.length === 0) return;

          const signals = await buildMarketSignals(repositories, { coinIds });
          await alerts.processMany(signals);
        } catch (error) {
          logger.error({ err: error }, 'market alert evaluation failed');
        }
      })();
    },
    Math.max(env.INTERVAL_MARKET_MS * 3, 30_000),
  );

  // Unlock alerts are checked hourly; an unlock is known days in advance.
  const unlockAlertInterval = setInterval(() => {
    void (async () => {
      try {
        const coins = await repositories.coins.listTracked(env.MAX_TRACKED_COINS);
        const signals = await buildUnlockSignals(repositories, {
          coinIds: coins.map((coin) => coin.id),
        });
        await alerts.processMany(signals);
      } catch (error) {
        logger.error({ err: error }, 'unlock alert evaluation failed');
      }
    })();
  }, 3_600_000);

  // ── Scheduled reports & maintenance ──
  //
  // croner rather than node-cron: it handles DST and timezones correctly and
  // supports `protect` (skip if the previous run is still going), which matters
  // for a report that takes a minute to generate.
  const crons: Cron[] = [
    new Cron('0 * * * *', { name: 'hourly-report', protect: true }, () => {
      void reports
        .generate({ kind: 'HOURLY', from: new Date(Date.now() - 3_600_000), to: new Date() })
        .then((result) => {
          if (!result.ok) logger.warn({ err: result.error.message }, 'hourly report failed');
        });
    }),

    new Cron('0 7 * * *', { name: 'morning-brief', protect: true }, () => {
      void reports
        .generate({ kind: 'MORNING', from: new Date(Date.now() - 86_400_000), to: new Date() })
        .then((result) => {
          if (!result.ok) logger.warn({ err: result.error.message }, 'morning brief failed');
        });
    }),

    new Cron('0 0 * * 1', { name: 'weekly-report', protect: true }, () => {
      void reports
        .generate({ kind: 'WEEKLY', from: new Date(Date.now() - 7 * 86_400_000), to: new Date() })
        .then((result) => {
          if (!result.ok) logger.warn({ err: result.error.message }, 'weekly report failed');
        });
    }),

    new Cron('0 1 1 * *', { name: 'monthly-report', protect: true }, () => {
      void reports
        .generate({ kind: 'MONTHLY', from: new Date(Date.now() - 30 * 86_400_000), to: new Date() })
        .then((result) => {
          if (!result.ok) logger.warn({ err: result.error.message }, 'monthly report failed');
        });
    }),

    // Retention: prune raw high-frequency snapshots and old telemetry. Events,
    // news and on-chain history are never pruned — see docs/ARCHITECTURE.md.
    new Cron('30 3 * * *', { name: 'retention', protect: true }, () => {
      void (async () => {
        try {
          if (env.MARKET_SNAPSHOT_RETENTION_DAYS > 0) {
            const cutoff = new Date(Date.now() - env.MARKET_SNAPSHOT_RETENTION_DAYS * 86_400_000);
            const pruned = await repositories.market.pruneSnapshots(cutoff);
            const runsPruned = await repositories.telemetry.pruneRuns(
              new Date(Date.now() - 30 * 86_400_000),
            );
            logger.info({ pruned, runsPruned }, 'retention pass complete');
          }
        } catch (error) {
          logger.error({ err: error }, 'retention pass failed');
        }
      })();
    }),
  ];

  logger.info(
    {
      connectors: registry.listEnabled(connectorContext).length,
      crons: crons.map((cron) => cron.name),
    },
    'worker running',
  );

  // ── Graceful shutdown ──
  //
  // Stop taking new work, abort in-flight HTTP, then close connections. Without
  // the abort, shutdown waits out a 20s feed timeout.
  let shuttingDown = false;
  const stop = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    shutdown.abort();
    clearInterval(marketAlertInterval);
    clearInterval(unlockAlertInterval);
    for (const cron of crons) cron.stop();
    await scheduler.stop();

    const errors = await container.dispose();
    for (const error of errors) logger.warn({ err: error.message }, 'error during disposal');
    await db.$disconnect();

    logger.info({ metrics: metrics.snapshot().counters }, 'worker stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  // An unhandled rejection in a background task must be loud, not silent.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
}

main().catch((error: unknown) => {
  // Boot failures (bad config, unreachable database) are fatal by design: a
  // worker that starts without a database would silently ingest nothing.
  console.error('worker failed to start:', error);
  process.exit(1);
});
