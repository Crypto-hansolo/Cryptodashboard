import type {
  Coin,
  CoinDraft,
  CoinIdentifier,
  Portfolio,
  PortfolioHolding,
  Tag,
  TrackedCoin,
  Watchlist,
  WatchlistItem,
} from '../domain/coin.js';
import type {
  Event,
  EventDraft,
  Page,
  Source,
  TimelineEntry,
  TimelineFilter,
  Intelligence,
} from '../domain/event.js';
import type {
  DerivativesSnapshot,
  ExchangeListing,
  Liquidation,
  LiquidityPool,
  MarketQuote,
  MarketSnapshot,
  OhlcvCandle,
  OptionsSnapshot,
  Trade,
  TradingPair,
} from '../domain/market.js';
import type {
  GithubActivity,
  GithubRepoSnapshot,
  GovernanceProposal,
  NewsArticle,
  OnchainEvent,
  OnchainMetric,
  SocialAuthor,
  SocialMetric,
  SocialPlatform,
  SocialPost,
  TokenUnlock,
  TokenomicsSnapshot,
  Wallet,
} from '../domain/content.js';
import type { Alert, AlertDraft, AlertTrigger, NotificationDelivery } from '../domain/alert.js';
import type { CoinRanking, NarrativeSummary, Report, ReportInputs } from '../domain/report.js';
import type { CandleInterval, EventCategory, RunStatus } from '../domain/enums.js';

/**
 * Repository ports.
 *
 * The domain declares what it needs; `@cid/db` provides Prisma-backed
 * implementations and the tests provide in-memory fakes. Nothing in this file
 * knows that Postgres exists, which is what lets the scoring and alert logic be
 * tested without a database and lets a connector be exercised against a fake.
 *
 * Convention: `insert*` is append-only (history is never rewritten), `upsert*`
 * is for reference data that legitimately changes (a coin's logo URL), and
 * `record*` returns whether the row was newly created — collectors use that to
 * decide whether something is *news* or just a re-poll.
 */

// ─── Reference data ──────────────────────────────────────────────────────────

export interface SourceRepository {
  findByKey(key: string): Promise<Source | null>;
  listEnabled(): Promise<Source[]>;
  /** Registers a source on first use; idempotent. */
  ensure(source: Pick<Source, 'key' | 'name' | 'kind'> & Partial<Source>): Promise<Source>;
  setEnabled(key: string, enabled: boolean): Promise<void>;
}

export interface CoinSearchResult {
  coin: Coin;
  /** Relevance on [0,1]. */
  score: number;
  matchedOn: 'symbol' | 'name' | 'slug' | 'contract' | 'external-id';
}

export interface CoinRepository {
  findById(id: string): Promise<Coin | null>;
  findManyByIds(ids: readonly string[]): Promise<Coin[]>;
  findBySlug(slug: string): Promise<Coin | null>;
  /** Resolve any identifier candidate to a coin. Tries in the given order. */
  findByIdentifiers(candidates: readonly CoinIdentifier[]): Promise<Coin | null>;
  search(query: string, limit?: number): Promise<CoinSearchResult[]>;
  upsert(draft: CoinDraft): Promise<Coin>;
  addIdentifier(coinId: string, identifier: CoinIdentifier): Promise<void>;
  /**
   * Coins the scheduler should poll, ordered by priority (pinned first, then
   * watchlisted, then by market-cap rank). Capped by `MAX_TRACKED_COINS`.
   */
  listTracked(limit: number): Promise<Coin[]>;
  /** Lightweight projection used by the coin matcher on every ingest. */
  listMatchable(): Promise<Array<{ id: string; symbol: string; name: string; aliases: string[] }>>;
  count(): Promise<number>;
}

// ─── Watchlists, portfolios, tags ────────────────────────────────────────────

export interface WatchlistRepository {
  listForUser(userId: string): Promise<Watchlist[]>;
  getDefault(userId: string): Promise<Watchlist>;
  create(userId: string, name: string, description?: string | null): Promise<Watchlist>;
  rename(id: string, name: string): Promise<Watchlist>;
  remove(id: string): Promise<void>;
  listItems(watchlistId: string): Promise<TrackedCoin[]>;
  addCoin(watchlistId: string, coinId: string): Promise<WatchlistItem>;
  removeCoin(watchlistId: string, coinId: string): Promise<void>;
  setPinned(watchlistId: string, coinId: string, pinned: boolean): Promise<void>;
  reorder(watchlistId: string, orderedCoinIds: readonly string[]): Promise<void>;
}

export interface PortfolioRepository {
  listForUser(userId: string): Promise<Portfolio[]>;
  create(userId: string, name: string, baseCurrency?: string): Promise<Portfolio>;
  remove(id: string): Promise<void>;
  listHoldings(portfolioId: string): Promise<PortfolioHolding[]>;
  upsertHolding(
    portfolioId: string,
    coinId: string,
    quantity: number,
    costBasis?: number | null,
  ): Promise<PortfolioHolding>;
  removeHolding(portfolioId: string, coinId: string): Promise<void>;
}

export interface TagRepository {
  listForUser(userId: string): Promise<Tag[]>;
  create(userId: string, name: string, color?: string): Promise<Tag>;
  remove(id: string): Promise<void>;
  assign(tagId: string, coinId: string): Promise<void>;
  unassign(tagId: string, coinId: string): Promise<void>;
  listCoinTags(coinIds: readonly string[]): Promise<Map<string, Tag[]>>;
}

// ─── Events / timeline ───────────────────────────────────────────────────────

export interface InsertEventResult {
  event: Event;
  /** False when an event with this dedupeHash already existed. */
  created: boolean;
}

export interface EventRepository {
  /**
   * Append events, skipping ones whose `dedupeHash` already exists.
   * Returns one result per input so callers can act only on genuinely new items.
   */
  insertMany(drafts: readonly EventDraft[]): Promise<InsertEventResult[]>;
  findById(id: string): Promise<Event | null>;
  timeline(filter: TimelineFilter): Promise<Page<TimelineEntry>>;
  /** Events awaiting AI enrichment, oldest-important-first. */
  listPendingEnrichment(limit: number): Promise<Event[]>;
  updateIntelligence(eventId: string, intelligence: Partial<Intelligence>): Promise<void>;
  setCluster(eventId: string, clusterId: string): Promise<void>;
  /** Recent events used as dedupe-cluster candidates. */
  listRecentForClustering(
    since: Date,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      headline: string;
      url: string | null;
      occurredAt: Date;
      clusterId: string | null;
    }>
  >;
  countByCluster(clusterIds: readonly string[]): Promise<Map<string, number>>;
  /** Aggregate event counts per bucket, for the news-frequency chart. */
  histogram(input: {
    coinId?: string | null;
    categories?: readonly EventCategory[];
    from: Date;
    to: Date;
    bucketMinutes: number;
  }): Promise<Array<{ bucket: Date; count: number; meanSentiment: number | null }>>;
  /** Highest-importance events in a window, for report generation. */
  listKeyEvents(input: {
    from: Date;
    to: Date;
    coinIds?: readonly string[];
    limit: number;
    minImportance?: number;
  }): Promise<TimelineEntry[]>;
}

// ─── Market data ─────────────────────────────────────────────────────────────

export interface MarketRepository {
  insertSnapshots(
    snapshots: readonly (Omit<MarketSnapshot, 'id' | 'sourceId'> & { sourceKey: string })[],
  ): Promise<number>;
  latestQuote(coinId: string): Promise<MarketQuote | null>;
  latestQuotes(coinIds: readonly string[]): Promise<Map<string, MarketQuote>>;
  /** Quote nearest to (and at or before) `at`. Used by PRICE_CHANGE rules. */
  quoteAt(coinId: string, at: Date): Promise<MarketQuote | null>;
  history(input: {
    coinId: string;
    from: Date;
    to: Date;
    /** Downsample to at most this many points. */
    maxPoints?: number;
  }): Promise<MarketSnapshot[]>;
  /** Trailing mean 24h volume over `days`, for spike detection. */
  baselineVolume(coinId: string, days: number): Promise<number | null>;

  insertCandles(
    candles: readonly (Omit<OhlcvCandle, 'id' | 'sourceId'> & { sourceKey: string })[],
  ): Promise<number>;
  candles(input: {
    coinId: string;
    interval: CandleInterval;
    from: Date;
    to: Date;
  }): Promise<OhlcvCandle[]>;

  insertDerivatives(
    snapshots: readonly (Omit<DerivativesSnapshot, 'id' | 'sourceId'> & { sourceKey: string })[],
  ): Promise<number>;
  latestDerivatives(coinId: string): Promise<DerivativesSnapshot[]>;
  derivativesHistory(input: {
    coinId: string;
    from: Date;
    to: Date;
    instrument?: string;
  }): Promise<DerivativesSnapshot[]>;

  insertOptions(
    snapshots: readonly (Omit<OptionsSnapshot, 'id' | 'sourceId'> & { sourceKey: string })[],
  ): Promise<number>;
  insertLiquidations(
    liquidations: readonly (Omit<Liquidation, 'id' | 'sourceId'> & { sourceKey: string })[],
  ): Promise<number>;
  liquidationTotals(input: {
    coinId: string;
    from: Date;
    to: Date;
    bucketMinutes: number;
  }): Promise<Array<{ bucket: Date; longUsd: number; shortUsd: number }>>;

  insertTrades(
    trades: readonly (Omit<Trade, 'id' | 'sourceId'> & { sourceKey: string })[],
  ): Promise<number>;
  listWhaleTrades(input: {
    coinId?: string | null;
    minUsd: number;
    from: Date;
    to: Date;
    limit: number;
  }): Promise<Trade[]>;

  /** Returns pairs that were not previously known — i.e. new listings. */
  recordTradingPairs(
    pairs: readonly (Omit<TradingPair, 'id' | 'sourceId' | 'firstSeenAt' | 'lastSeenAt'> & {
      sourceKey: string;
    })[],
  ): Promise<{ created: TradingPair[]; updated: number }>;
  listTradingPairs(coinId: string): Promise<TradingPair[]>;
  insertListing(
    listing: Omit<ExchangeListing, 'id' | 'sourceId'> & { sourceKey: string },
  ): Promise<ExchangeListing>;
  listListings(coinId: string, limit: number): Promise<ExchangeListing[]>;

  insertLiquidityPools(
    pools: readonly (Omit<LiquidityPool, 'id' | 'sourceId'> & { sourceKey: string })[],
  ): Promise<number>;
  latestLiquidityPools(coinId: string, limit: number): Promise<LiquidityPool[]>;

  /** Prune raw snapshots older than the retention window. Returns rows removed. */
  pruneSnapshots(olderThan: Date): Promise<number>;
}

// ─── Content ─────────────────────────────────────────────────────────────────

export interface ContentRepository {
  insertNews(
    articles: readonly (Omit<NewsArticle, 'id' | 'sourceId'> & { sourceKey: string })[],
  ): Promise<number>;
  findNewsByEventIds(eventIds: readonly string[]): Promise<Map<string, NewsArticle>>;

  upsertSocialAuthor(
    author: Omit<SocialAuthor, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<SocialAuthor>;
  findSocialAuthor(platform: SocialPlatform, externalId: string): Promise<SocialAuthor | null>;
  insertSocialPosts(
    posts: readonly (Omit<SocialPost, 'id' | 'sourceId'> & { sourceKey: string })[],
  ): Promise<number>;
  insertSocialMetrics(metrics: readonly Omit<SocialMetric, 'id'>[]): Promise<number>;
  latestSocialMetric(coinId: string, platform: SocialPlatform): Promise<SocialMetric | null>;
  socialMetricHistory(input: {
    coinId: string;
    platform?: SocialPlatform;
    from: Date;
    to: Date;
  }): Promise<SocialMetric[]>;
  /** Mention counts per window, for velocity baselines. */
  mentionBaseline(input: {
    coinId: string;
    platform: SocialPlatform;
    windowMinutes: number;
    periods: number;
  }): Promise<number[]>;

  upsertWallet(wallet: Omit<Wallet, 'id' | 'createdAt' | 'updatedAt'>): Promise<Wallet>;
  findWallets(chain: string, addresses: readonly string[]): Promise<Map<string, Wallet>>;
  insertOnchainEvents(
    events: readonly (Omit<OnchainEvent, 'id' | 'sourceId'> & { sourceKey: string })[],
  ): Promise<number>;
  listOnchainEvents(input: {
    coinId: string;
    from: Date;
    to: Date;
    minUsd?: number;
    limit: number;
  }): Promise<OnchainEvent[]>;
  /** Exchange in/outflow totals per bucket, for the whale-activity chart. */
  whaleFlows(input: {
    coinId: string;
    from: Date;
    to: Date;
    bucketMinutes: number;
    minUsd: number;
  }): Promise<Array<{ bucket: Date; inflowUsd: number; outflowUsd: number; count: number }>>;
  insertOnchainMetrics(
    metrics: readonly (Omit<OnchainMetric, 'id' | 'sourceId'> & { sourceKey: string })[],
  ): Promise<number>;

  insertGithubActivity(
    activity: readonly (Omit<GithubActivity, 'id' | 'sourceId'> & { sourceKey: string })[],
  ): Promise<number>;
  insertGithubSnapshot(
    snapshot: Omit<GithubRepoSnapshot, 'id' | 'sourceId'> & { sourceKey: string },
  ): Promise<GithubRepoSnapshot>;
  latestGithubSnapshots(coinId: string): Promise<GithubRepoSnapshot[]>;
  githubActivityHistory(input: {
    coinId: string;
    from: Date;
    to: Date;
    bucketMinutes: number;
  }): Promise<Array<{ bucket: Date; commits: number; releases: number; pullRequests: number }>>;

  /** Upsert by (space, externalId): proposals change state over their lifetime. */
  upsertProposals(
    proposals: readonly (Omit<GovernanceProposal, 'id' | 'sourceId'> & { sourceKey: string })[],
  ): Promise<{ created: GovernanceProposal[]; stateChanged: GovernanceProposal[] }>;
  listProposals(coinId: string, limit: number): Promise<GovernanceProposal[]>;

  upsertUnlocks(
    unlocks: readonly (Omit<TokenUnlock, 'id' | 'sourceId'> & { sourceKey: string })[],
  ): Promise<number>;
  listUpcomingUnlocks(input: { coinIds?: readonly string[]; before: Date }): Promise<TokenUnlock[]>;
  insertTokenomics(
    snapshots: readonly (Omit<TokenomicsSnapshot, 'id' | 'sourceId'> & { sourceKey: string })[],
  ): Promise<number>;
  latestTokenomics(coinId: string): Promise<TokenomicsSnapshot | null>;
}

// ─── Alerts ──────────────────────────────────────────────────────────────────

export interface AlertRepository {
  listForUser(userId: string): Promise<Alert[]>;
  /** All enabled alerts, for the worker's evaluation loop. */
  listEnabled(): Promise<Alert[]>;
  findById(id: string): Promise<Alert | null>;
  create(draft: AlertDraft): Promise<Alert>;
  update(id: string, patch: Partial<AlertDraft>): Promise<Alert>;
  remove(id: string): Promise<void>;
  /**
   * Atomically record a firing and bump the cooldown. Returns null when another
   * worker already fired this alert inside the cooldown window — the guard that
   * makes horizontal scaling of the worker safe.
   */
  recordTrigger(
    alertId: string,
    trigger: Omit<AlertTrigger, 'id' | 'alertId'>,
  ): Promise<AlertTrigger | null>;
  listTriggers(input: { userId: string; limit: number }): Promise<AlertTrigger[]>;
  recordDelivery(delivery: Omit<NotificationDelivery, 'id' | 'createdAt'>): Promise<void>;
  listPendingDeliveries(limit: number): Promise<NotificationDelivery[]>;
}

// ─── Reports & analytics ─────────────────────────────────────────────────────

export interface ReportRepository {
  insert(report: Omit<Report, 'id' | 'createdAt'>): Promise<Report>;
  findLatest(kind: Report['kind'], coinId?: string | null): Promise<Report | null>;
  list(input: { kind?: Report['kind']; limit: number }): Promise<Report[]>;
  findById(id: string): Promise<Report | null>;
}

export interface AnalyticsRepository {
  /** Assemble everything a period report needs in one round trip. */
  reportInputs(input: {
    from: Date;
    to: Date;
    coinIds?: readonly string[];
    portfolioId?: string | null;
  }): Promise<ReportInputs>;
  rankBySentiment(input: {
    from: Date;
    to: Date;
    direction: 'bullish' | 'bearish';
    limit: number;
  }): Promise<CoinRanking[]>;
  rankByDevActivity(limit: number): Promise<CoinRanking[]>;
  rankByPriceMove(input: { from: Date; to: Date; limit: number }): Promise<CoinRanking[]>;
  topNarratives(input: { from: Date; to: Date; limit: number }): Promise<NarrativeSummary[]>;
}

// ─── Telemetry ───────────────────────────────────────────────────────────────

export interface CollectorRunRecord {
  connectorKey: string;
  startedAt: Date;
  finishedAt: Date;
  status: RunStatus;
  itemsFetched: number;
  itemsIngested: number;
  durationMs: number;
  error: string | null;
  /** Coins the run covered, when scoped. */
  coinIds: string[];
}

export interface TelemetryRepository {
  recordRun(run: CollectorRunRecord): Promise<void>;
  /** Per-connector health over a window, for the /health and status UI. */
  connectorHealth(since: Date): Promise<
    Array<{
      connectorKey: string;
      runs: number;
      failures: number;
      lastRunAt: Date | null;
      lastStatus: RunStatus | null;
      meanDurationMs: number;
      itemsIngested: number;
    }>
  >;
  /** Ingestion lag percentiles — the platform's core latency SLO. */
  ingestionLag(since: Date): Promise<{ p50Ms: number; p95Ms: number; maxMs: number } | null>;
}

// ─── Semantic search ─────────────────────────────────────────────────────────

export interface SemanticHit {
  eventId: string;
  /** Cosine similarity on [0,1]. */
  similarity: number;
}

export interface SearchRepository {
  /** Store or replace an event's embedding. */
  upsertEmbedding(eventId: string, vector: readonly number[]): Promise<void>;
  /** Events with no embedding yet. */
  listMissingEmbeddings(
    limit: number,
  ): Promise<Array<{ id: string; headline: string; body: string | null }>>;
  /** Approximate nearest neighbours, optionally filtered. */
  semanticSearch(input: {
    vector: readonly number[];
    limit: number;
    coinIds?: readonly string[];
    from?: Date;
    to?: Date;
    minSimilarity?: number;
  }): Promise<SemanticHit[]>;
  /** Postgres full-text search — the fallback when embeddings are unavailable. */
  keywordSearch(input: {
    query: string;
    limit: number;
    coinIds?: readonly string[];
    from?: Date;
    to?: Date;
  }): Promise<SemanticHit[]>;
}

/**
 * Aggregate of every port, resolved once at boot and passed around.
 * Handy for constructor injection without 12 parameters.
 */
export interface Repositories {
  sources: SourceRepository;
  coins: CoinRepository;
  watchlists: WatchlistRepository;
  portfolios: PortfolioRepository;
  tags: TagRepository;
  events: EventRepository;
  market: MarketRepository;
  content: ContentRepository;
  alerts: AlertRepository;
  reports: ReportRepository;
  analytics: AnalyticsRepository;
  telemetry: TelemetryRepository;
  search: SearchRepository;
}
