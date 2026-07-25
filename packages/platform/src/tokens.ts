import type {
  Cache,
  Clock,
  ConnectorRegistry,
  EmbeddingClient,
  Enricher,
  LlmClient,
  Logger,
  RateLimiter,
  RealtimeBus,
  Repositories,
} from '@cid/core';
import type { Redis } from 'ioredis';
import { token } from './container.js';
import type { Env } from './env.js';
import type { CircuitBreaker } from './circuit-breaker.js';

/**
 * DI tokens, declared in one place.
 *
 * Keeping them together means the composition roots (worker `main.ts`, the web
 * app's server container) share the same identifiers, and a rename is a single
 * edit rather than a string hunt. The phantom type on each token is what makes
 * `container.resolve(TOKENS.repositories)` come back typed.
 */
export const TOKENS = {
  env: token<Env>('env'),
  logger: token<Logger>('logger'),
  clock: token<Clock>('clock'),

  redis: token<Redis>('redis'),
  queueRedis: token<Redis>('queueRedis'),

  cache: token<Cache>('cache'),
  rateLimiter: token<RateLimiter>('rateLimiter'),
  circuitBreaker: token<CircuitBreaker>('circuitBreaker'),
  realtime: token<RealtimeBus>('realtime'),

  /** Prisma client, typed loosely here so `@cid/platform` need not depend on `@cid/db`. */
  prisma: token<unknown>('prisma'),
  repositories: token<Repositories>('repositories'),

  llm: token<LlmClient | null>('llm'),
  embeddings: token<EmbeddingClient | null>('embeddings'),
  enricher: token<Enricher | null>('enricher'),

  connectors: token<ConnectorRegistry>('connectors'),
} as const;
