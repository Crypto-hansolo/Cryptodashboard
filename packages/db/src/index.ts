import type { Logger, Repositories } from '@cid/core';
import { createPrismaClient, type Db } from './client.js';
import { PrismaSourceRepository } from './repositories/source-repository.js';
import { PrismaCoinRepository } from './repositories/coin-repository.js';
import { PrismaEventRepository } from './repositories/event-repository.js';
import { PrismaMarketRepository } from './repositories/market-repository.js';
import { PrismaContentRepository } from './repositories/content-repository.js';
import { PrismaAlertRepository } from './repositories/alert-repository.js';
import {
  PrismaPortfolioRepository,
  PrismaTagRepository,
  PrismaWatchlistRepository,
} from './repositories/watchlist-repository.js';
import { PrismaSearchRepository } from './repositories/search-repository.js';
import {
  PrismaAnalyticsRepository,
  PrismaReportRepository,
  PrismaTelemetryRepository,
} from './repositories/analytics-repository.js';

/**
 * `@cid/db` — the persistence layer.
 *
 * Prisma-backed implementations of the repository ports declared in
 * `@cid/core`. Nothing above this package imports `@prisma/client`; the mappers
 * are the only translation point, which is what keeps the domain testable
 * without a database and a schema rename from rippling through business logic.
 */

export * from './client.js';
export * from './mappers.js';
export { PrismaSourceRepository } from './repositories/source-repository.js';
export { PrismaCoinRepository } from './repositories/coin-repository.js';
export { PrismaEventRepository } from './repositories/event-repository.js';
export { PrismaMarketRepository } from './repositories/market-repository.js';
export { PrismaContentRepository } from './repositories/content-repository.js';
export { PrismaAlertRepository } from './repositories/alert-repository.js';
export {
  PrismaWatchlistRepository,
  PrismaPortfolioRepository,
  PrismaTagRepository,
} from './repositories/watchlist-repository.js';
export { PrismaSearchRepository } from './repositories/search-repository.js';
export {
  PrismaAnalyticsRepository,
  PrismaReportRepository,
  PrismaTelemetryRepository,
} from './repositories/analytics-repository.js';

/**
 * The concrete repository set, with the extra methods that the ports do not
 * declare but the worker and API legitimately need (connector high-water marks,
 * hybrid search, delivery updates). Callers that only need the port contract
 * should depend on `Repositories` from `@cid/core` instead.
 */
export interface CidRepositories extends Repositories {
  sources: PrismaSourceRepository;
  events: PrismaEventRepository;
  alerts: PrismaAlertRepository;
  search: PrismaSearchRepository;
  telemetry: PrismaTelemetryRepository;
  analytics: PrismaAnalyticsRepository;
}

export interface BuildRepositoriesOptions {
  db?: Db;
  databaseUrl?: string;
  logger?: Logger;
  logQueries?: boolean;
  /** Must match the pgvector column width; see the search migration. */
  embeddingDimensions?: number;
}

/**
 * Compose the repository set over one Prisma client.
 *
 * Wiring lives here rather than in each entry point so the worker, the Next.js
 * server and the integration tests all get an identically-wired set.
 */
export function buildRepositories(options: BuildRepositoriesOptions = {}): {
  db: Db;
  repositories: CidRepositories;
} {
  const db =
    options.db ??
    createPrismaClient({
      ...(options.databaseUrl !== undefined ? { databaseUrl: options.databaseUrl } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
      ...(options.logQueries !== undefined ? { logQueries: options.logQueries } : {}),
    });

  // Sources is shared by every insert path: it caches key -> id so the
  // per-batch resolution is one query rather than one per row.
  const sources = new PrismaSourceRepository(db);

  const repositories: CidRepositories = {
    sources,
    coins: new PrismaCoinRepository(db),
    watchlists: new PrismaWatchlistRepository(db),
    portfolios: new PrismaPortfolioRepository(db),
    tags: new PrismaTagRepository(db),
    events: new PrismaEventRepository(db, sources),
    market: new PrismaMarketRepository(db, sources),
    content: new PrismaContentRepository(db, sources),
    alerts: new PrismaAlertRepository(db),
    reports: new PrismaReportRepository(db),
    analytics: new PrismaAnalyticsRepository(db),
    telemetry: new PrismaTelemetryRepository(db),
    search: new PrismaSearchRepository(db, {
      ...(options.embeddingDimensions !== undefined
        ? { dimensions: options.embeddingDimensions }
        : {}),
    }),
  };

  return { db, repositories };
}
