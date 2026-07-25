import { PrismaClient } from '@prisma/client';
import type { Logger } from '@cid/core';
import { noopLogger } from '@cid/core';

/**
 * Prisma client construction.
 *
 * A single instance per process. In development, Next.js hot-reloads modules on
 * every edit; without stashing the client on `globalThis` you accumulate a new
 * connection pool per reload and exhaust Postgres' connection limit within a few
 * minutes of editing.
 */

export type Db = PrismaClient;

export interface CreateClientOptions {
  databaseUrl?: string;
  logger?: Logger;
  /** Emit every query at debug level. Very noisy; useful when tuning indexes. */
  logQueries?: boolean;
}

export function createPrismaClient(options: CreateClientOptions = {}): PrismaClient {
  const logger = options.logger ?? noopLogger;

  const client = new PrismaClient({
    ...(options.databaseUrl ? { datasources: { db: { url: options.databaseUrl } } } : {}),
    log: options.logQueries
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ]
      : [
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ],
  });

  // Route Prisma's own logs through our structured logger rather than stdout.
  client.$on('warn' as never, (event: { message: string }) => {
    logger.warn({ prisma: true }, event.message);
  });
  client.$on('error' as never, (event: { message: string }) => {
    logger.error({ prisma: true }, event.message);
  });
  if (options.logQueries) {
    client.$on('query' as never, (event: { query: string; params: string; duration: number }) => {
      logger.debug({ prisma: true, durationMs: event.duration, params: event.params }, event.query);
    });
  }

  return client;
}

const globalForPrisma = globalThis as unknown as { cidPrisma?: PrismaClient };

/**
 * Process-wide client, safe under Next.js hot reload.
 * The worker calls {@link createPrismaClient} directly and manages its own
 * lifecycle through the DI container.
 */
export function getPrismaClient(options: CreateClientOptions = {}): PrismaClient {
  if (process.env.NODE_ENV === 'production') {
    globalForPrisma.cidPrisma ??= createPrismaClient(options);
    return globalForPrisma.cidPrisma;
  }
  globalForPrisma.cidPrisma ??= createPrismaClient(options);
  return globalForPrisma.cidPrisma;
}
