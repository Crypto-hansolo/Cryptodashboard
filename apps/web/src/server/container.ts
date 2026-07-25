import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { systemClock, type ConnectorContext } from '@cid/core';
import {
  CircuitBreaker,
  InMemoryCache,
  InMemoryRateLimiter,
  RedisCache,
  RedisRateLimiter,
  RedisRealtimeBus,
  ResilientHttpClient,
  connectorConfig,
  createLogger,
  createRedis,
  parseEnv,
  type Env,
} from '@cid/platform';
import { buildRepositories, type CidRepositories } from '@cid/db';
import { CoinGeckoSearchClient, type DiscoveredCoin } from '@cid/connectors';
import { ResearchAgent, createEmbeddingClient, createLlmClient } from '@cid/ai';
import type { LlmClient, EmbeddingClient, Logger, RateLimiter, RealtimeBus } from '@cid/core';

/**
 * Server-side singletons for the web app.
 *
 * Next.js hot-reloads modules on every edit in development, so anything holding
 * a connection pool must be stashed on `globalThis` or you exhaust Postgres'
 * connection limit within a few minutes of editing. This is the same reason the
 * Prisma client is cached in `@cid/db`.
 *
 * Read-only by design: the web app never ingests. Writes are limited to
 * user-owned data (watchlists, alerts, tags) and to coins the user explicitly
 * adds. All collection happens in the worker.
 */

export interface WebServices {
  env: Env;
  logger: Logger;
  repositories: CidRepositories;
  realtime: RealtimeBus;
  llm: LlmClient | null;
  embeddings: EmbeddingClient | null;
  agent: ResearchAgent;
  coinSearch: CoinGeckoSearchClient;
  connectorContext: ConnectorContext;
  /** Inbound per-client limiter for the public API. See server/api.ts. */
  apiRateLimiter: RateLimiter;
}

const globalForServices = globalThis as unknown as { cidServices?: WebServices };

function build(): WebServices {
  /*
   * Next only auto-loads `.env` from the app directory, but this is a monorepo
   * with a single repo-root `.env` shared by the web app, the worker and the
   * Prisma CLI. Load it explicitly rather than duplicating configuration (and
   * secrets) into apps/web/.env.
   *
   * `override: false` is the default and matters: real environment variables —
   * what docker-compose and a production host supply — must win over the file.
   */
  loadEnv({ path: resolve(process.cwd(), '../../.env') });
  loadEnv({ path: resolve(process.cwd(), '.env') });

  const env = parseEnv();
  const logger = createLogger(env);

  const { repositories } = buildRepositories({
    databaseUrl: env.DATABASE_URL,
    logger,
    embeddingDimensions: env.EMBEDDING_DIMENSIONS,
  });

  // Redis is optional for the web process: without it the app still serves
  // everything except live updates, so a Redis outage degrades rather than
  // takes the dashboard down.
  let realtime: RealtimeBus;
  let cache: RedisCache | InMemoryCache;
  /*
   * Inbound API limiting must be shared across web replicas — two instances each
   * politely allowing RATE_LIMIT_RPM lets a client through at twice the
   * configured rate — so it lives in Redis when Redis is there. In-memory is the
   * degraded fallback: still a real limit, just per process.
   */
  let apiRateLimiter: RateLimiter;
  const apiLimitConfig = { requestsPerMinute: env.RATE_LIMIT_RPM };
  try {
    const redis = createRedis({ url: env.REDIS_URL, logger, role: 'web' });
    cache = new RedisCache(redis, { defaultTtlSeconds: env.CACHE_TTL_SECONDS, logger });
    realtime = new RedisRealtimeBus({ url: env.REDIS_URL, logger });
    apiRateLimiter = new RedisRateLimiter(redis, {
      defaultConfig: apiLimitConfig,
      prefix: 'cid:api-ratelimit:',
    });
  } catch (error) {
    logger.warn({ err: error }, 'redis unavailable; live updates disabled');
    cache = new InMemoryCache();
    realtime = {
      publish: async () => {},
      subscribe: async () => async () => {},
    };
    apiRateLimiter = new InMemoryRateLimiter({ defaultConfig: apiLimitConfig });
  }

  const llmHttp = new ResilientHttpClient({
    provider: 'llm-web',
    logger,
    defaultTimeoutMs: env.LLM_TIMEOUT_MS,
    maxRetries: 0,
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

  const connectorContext: ConnectorContext = {
    http: new ResilientHttpClient({
      provider: 'coingecko-search',
      cache,
      rateLimiter: new InMemoryRateLimiter({ defaultConfig: { requestsPerMinute: 20 } }),
      circuitBreaker: new CircuitBreaker(),
      logger,
    }),
    cache,
    logger,
    clock: systemClock,
    rateLimiter: new InMemoryRateLimiter({ defaultConfig: { requestsPerMinute: 20 } }),
    config: connectorConfig(env),
  };

  return {
    env,
    logger,
    repositories,
    realtime,
    llm,
    embeddings,
    agent: new ResearchAgent({ repositories, llm, embeddings, logger }),
    coinSearch: new CoinGeckoSearchClient(connectorContext),
    connectorContext,
    apiRateLimiter,
  };
}

export function getServices(): WebServices {
  globalForServices.cidServices ??= build();
  return globalForServices.cidServices;
}

/**
 * The single local user.
 *
 * This deployment is single-tenant by design (it runs on your own machine
 * against your own API keys). The `userId` column exists on every user-owned
 * table, so adding real auth is an auth change rather than a schema migration —
 * see docs/ARCHITECTURE.md#multi-user.
 */
export const LOCAL_USER_EMAIL = 'local@localhost';

export async function getLocalUserId(): Promise<string> {
  // Upserted rather than required to exist, so a fresh install works without a
  // seed step.
  const { getPrismaClient } = await import('@cid/db');
  const db = getPrismaClient();
  const user = await db.user.upsert({
    where: { email: LOCAL_USER_EMAIL },
    create: { email: LOCAL_USER_EMAIL, name: 'Local' },
    update: {},
  });
  return user.id;
}

export type { DiscoveredCoin };
