import type {
  CandleInterval,
  DerivativesSnapshot,
  ExchangeListing,
  Liquidation,
  LiquidityPool,
  MarketQuote,
  MarketRepository,
  MarketSnapshot,
  OhlcvCandle,
  OptionsSnapshot,
  Trade,
  TradingPair,
} from '@cid/core';
import type { Db } from '../client.js';
import {
  fromPrismaInterval,
  toLiquidityPool,
  toMarketQuote,
  toPrismaInterval,
  toTrade,
} from '../mappers.js';
import type { PrismaSourceRepository } from './source-repository.js';

/** Rows carrying a `sourceKey` that must be resolved to a `sourceId`. */
type WithSourceKey<T> = T & { sourceKey: string };

export class PrismaMarketRepository implements MarketRepository {
  readonly #db: Db;
  readonly #sources: PrismaSourceRepository;

  constructor(db: Db, sources: PrismaSourceRepository) {
    this.#db = db;
    this.#sources = sources;
  }

  /** Resolve source keys for a batch, dropping rows whose source is unknown. */
  async #withSourceIds<T extends { sourceKey: string }>(
    rows: readonly T[],
  ): Promise<Array<Omit<T, 'sourceKey'> & { sourceId: string }>> {
    if (rows.length === 0) return [];
    const ids = await this.#sources.resolveIds(rows.map((row) => row.sourceKey));
    return rows.flatMap((row) => {
      const sourceId = ids.get(row.sourceKey);
      if (!sourceId) return [];
      const { sourceKey: _sourceKey, ...rest } = row;
      return [{ ...rest, sourceId } as Omit<T, 'sourceKey'> & { sourceId: string }];
    });
  }

  // ─── Snapshots ─────────────────────────────────────────────────────────────

  async insertSnapshots(
    snapshots: readonly WithSourceKey<Omit<MarketSnapshot, 'id' | 'sourceId'>>[],
  ): Promise<number> {
    const data = await this.#withSourceIds(snapshots);
    if (data.length === 0) return 0;
    const result = await this.#db.marketSnapshot.createMany({ data });
    return result.count;
  }

  async latestQuote(coinId: string): Promise<MarketQuote | null> {
    const row = await this.#db.marketSnapshot.findFirst({
      where: { coinId },
      orderBy: { observedAt: 'desc' },
    });
    return row ? toMarketQuote(row) : null;
  }

  /**
   * Latest quote for many coins in one query.
   *
   * `DISTINCT ON` is the right tool here: Postgres walks the
   * (coinId, observedAt DESC) index and takes the first row per coin, rather
   * than sorting the whole table or issuing N queries from the caller.
   */
  async latestQuotes(coinIds: readonly string[]): Promise<Map<string, MarketQuote>> {
    if (coinIds.length === 0) return new Map();
    const rows = await this.#db.$queryRaw<
      Array<{
        coinId: string;
        priceUsd: number;
        marketCapUsd: number | null;
        volume24hUsd: number | null;
        fdvUsd: number | null;
        priceChange1hPct: number | null;
        priceChange24hPct: number | null;
        priceChange7dPct: number | null;
        observedAt: Date;
      }>
    >`
      SELECT DISTINCT ON ("coinId")
        "coinId", "priceUsd", "marketCapUsd", "volume24hUsd", "fdvUsd",
        "priceChange1hPct", "priceChange24hPct", "priceChange7dPct", "observedAt"
      FROM "MarketSnapshot"
      WHERE "coinId" = ANY(${[...coinIds]}::text[])
      ORDER BY "coinId", "observedAt" DESC
    `;
    return new Map(rows.map((row) => [row.coinId, row]));
  }

  /** Nearest quote at or before `at`. Used by PRICE_CHANGE rules. */
  async quoteAt(coinId: string, at: Date): Promise<MarketQuote | null> {
    const row = await this.#db.marketSnapshot.findFirst({
      where: { coinId, observedAt: { lte: at } },
      orderBy: { observedAt: 'desc' },
    });
    return row ? toMarketQuote(row) : null;
  }

  /**
   * Price history, downsampled server-side.
   *
   * A 90-day range at a 10s cadence is ~780k rows; sending that to a chart that
   * can show ~1000 pixels of width is pure waste. Bucketing in SQL keeps the
   * payload flat regardless of range.
   */
  async history(input: {
    coinId: string;
    from: Date;
    to: Date;
    maxPoints?: number;
  }): Promise<MarketSnapshot[]> {
    const maxPoints = input.maxPoints ?? 1_000;
    const spanMs = Math.max(1, input.to.getTime() - input.from.getTime());
    const bucketSeconds = Math.max(1, Math.ceil(spanMs / 1000 / maxPoints));

    const rows = await this.#db.$queryRaw<
      Array<{
        bucket: Date;
        priceUsd: number;
        marketCapUsd: number | null;
        fdvUsd: number | null;
        volume24hUsd: number | null;
        circulatingSupply: number | null;
        liquidityUsd: number | null;
        priceChange24hPct: number | null;
      }>
    >`
      SELECT
        date_bin(${`${bucketSeconds} seconds`}::interval, "observedAt", ${input.from}::timestamptz) AS bucket,
        -- Last price in the bucket, so the series ends on the true latest value.
        (array_agg("priceUsd" ORDER BY "observedAt" DESC))[1] AS "priceUsd",
        (array_agg("marketCapUsd" ORDER BY "observedAt" DESC))[1] AS "marketCapUsd",
        (array_agg("fdvUsd" ORDER BY "observedAt" DESC))[1] AS "fdvUsd",
        (array_agg("volume24hUsd" ORDER BY "observedAt" DESC))[1] AS "volume24hUsd",
        (array_agg("circulatingSupply" ORDER BY "observedAt" DESC))[1] AS "circulatingSupply",
        (array_agg("liquidityUsd" ORDER BY "observedAt" DESC))[1] AS "liquidityUsd",
        (array_agg("priceChange24hPct" ORDER BY "observedAt" DESC))[1] AS "priceChange24hPct"
      FROM "MarketSnapshot"
      WHERE "coinId" = ${input.coinId}
        AND "observedAt" >= ${input.from}
        AND "observedAt" <= ${input.to}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    // Synthesised rows: ids/ranks are not meaningful for an aggregate.
    return rows.map((row) => ({
      id: `${input.coinId}:${row.bucket.getTime()}`,
      coinId: input.coinId,
      sourceId: '',
      observedAt: row.bucket,
      priceUsd: row.priceUsd,
      marketCapUsd: row.marketCapUsd,
      fdvUsd: row.fdvUsd,
      volume24hUsd: row.volume24hUsd,
      circulatingSupply: row.circulatingSupply,
      totalSupply: null,
      maxSupply: null,
      liquidityUsd: row.liquidityUsd,
      priceChange1hPct: null,
      priceChange24hPct: row.priceChange24hPct,
      priceChange7dPct: null,
      priceChange30dPct: null,
      marketCapRank: null,
      athUsd: null,
      atlUsd: null,
    }));
  }

  /**
   * Trailing mean 24h volume, for spike detection.
   * Averages one observation per day so a coin polled more often than another
   * does not get a differently-weighted baseline.
   */
  async baselineVolume(coinId: string, days: number): Promise<number | null> {
    const from = new Date(Date.now() - days * 86_400_000);
    const rows = await this.#db.$queryRaw<Array<{ baseline: number | null }>>`
      SELECT avg(daily) AS baseline FROM (
        SELECT (array_agg("volume24hUsd" ORDER BY "observedAt" DESC))[1] AS daily
        FROM "MarketSnapshot"
        WHERE "coinId" = ${coinId}
          AND "observedAt" >= ${from}
          AND "volume24hUsd" IS NOT NULL
        GROUP BY date_trunc('day', "observedAt")
      ) dailies
    `;
    const baseline = rows[0]?.baseline;
    return baseline === null || baseline === undefined ? null : Number(baseline);
  }

  async pruneSnapshots(olderThan: Date): Promise<number> {
    const result = await this.#db.marketSnapshot.deleteMany({
      where: { observedAt: { lt: olderThan } },
    });
    return result.count;
  }

  // ─── Candles ───────────────────────────────────────────────────────────────

  async insertCandles(
    candles: readonly WithSourceKey<Omit<OhlcvCandle, 'id' | 'sourceId'>>[],
  ): Promise<number> {
    const data = await this.#withSourceIds(candles);
    if (data.length === 0) return 0;

    // A candle is an aggregate that closes, so the in-progress bucket is
    // legitimately mutable — upsert rather than append.
    let written = 0;
    await this.#db.$transaction(
      data.map((candle) => {
        const interval = toPrismaInterval(candle.interval);
        written++;
        return this.#db.ohlcvCandle.upsert({
          where: {
            coinId_sourceId_interval_openTime: {
              coinId: candle.coinId,
              sourceId: candle.sourceId,
              interval,
              openTime: candle.openTime,
            },
          },
          create: { ...candle, interval },
          update: {
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            quoteVolume: candle.quoteVolume,
            trades: candle.trades,
          },
        });
      }),
    );
    return written;
  }

  async candles(input: {
    coinId: string;
    interval: CandleInterval;
    from: Date;
    to: Date;
  }): Promise<OhlcvCandle[]> {
    const rows = await this.#db.ohlcvCandle.findMany({
      where: {
        coinId: input.coinId,
        interval: toPrismaInterval(input.interval),
        openTime: { gte: input.from, lte: input.to },
      },
      orderBy: { openTime: 'asc' },
    });
    return rows.map((row) => ({ ...row, interval: fromPrismaInterval(row.interval) }));
  }

  // ─── Derivatives ───────────────────────────────────────────────────────────

  async insertDerivatives(
    snapshots: readonly WithSourceKey<Omit<DerivativesSnapshot, 'id' | 'sourceId'>>[],
  ): Promise<number> {
    const data = await this.#withSourceIds(snapshots);
    if (data.length === 0) return 0;
    const result = await this.#db.derivativesSnapshot.createMany({ data });
    return result.count;
  }

  /** Latest snapshot per instrument for a coin. */
  async latestDerivatives(coinId: string): Promise<DerivativesSnapshot[]> {
    return this.#db.$queryRaw<DerivativesSnapshot[]>`
      SELECT DISTINCT ON (instrument) *
      FROM "DerivativesSnapshot"
      WHERE "coinId" = ${coinId}
      ORDER BY instrument, "observedAt" DESC
    `;
  }

  async derivativesHistory(input: {
    coinId: string;
    from: Date;
    to: Date;
    instrument?: string;
  }): Promise<DerivativesSnapshot[]> {
    return this.#db.derivativesSnapshot.findMany({
      where: {
        coinId: input.coinId,
        observedAt: { gte: input.from, lte: input.to },
        ...(input.instrument ? { instrument: input.instrument } : {}),
      },
      orderBy: { observedAt: 'asc' },
    });
  }

  // ─── Options, liquidations, trades ──────────────────────────────────────────

  async insertOptions(
    snapshots: readonly WithSourceKey<Omit<OptionsSnapshot, 'id' | 'sourceId'>>[],
  ): Promise<number> {
    const data = await this.#withSourceIds(snapshots);
    if (data.length === 0) return 0;
    const result = await this.#db.optionsSnapshot.createMany({ data });
    return result.count;
  }

  async insertLiquidations(
    liquidations: readonly WithSourceKey<Omit<Liquidation, 'id' | 'sourceId'>>[],
  ): Promise<number> {
    const data = await this.#withSourceIds(liquidations);
    if (data.length === 0) return 0;
    const result = await this.#db.liquidation.createMany({ data });
    return result.count;
  }

  async liquidationTotals(input: {
    coinId: string;
    from: Date;
    to: Date;
    bucketMinutes: number;
  }): Promise<Array<{ bucket: Date; longUsd: number; shortUsd: number }>> {
    const interval = `${Math.max(1, Math.floor(input.bucketMinutes))} minutes`;
    const rows = await this.#db.$queryRaw<
      Array<{ bucket: Date; long_usd: number | null; short_usd: number | null }>
    >`
      SELECT
        date_bin(${interval}::interval, "occurredAt", ${input.from}::timestamptz) AS bucket,
        sum(CASE WHEN side = 'LONG' THEN "valueUsd" ELSE 0 END) AS long_usd,
        sum(CASE WHEN side = 'SHORT' THEN "valueUsd" ELSE 0 END) AS short_usd
      FROM "Liquidation"
      WHERE "coinId" = ${input.coinId}
        AND "occurredAt" >= ${input.from} AND "occurredAt" <= ${input.to}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;
    return rows.map((row) => ({
      bucket: row.bucket,
      longUsd: Number(row.long_usd ?? 0),
      shortUsd: Number(row.short_usd ?? 0),
    }));
  }

  async insertTrades(
    trades: readonly WithSourceKey<Omit<Trade, 'id' | 'sourceId'>>[],
  ): Promise<number> {
    const data = await this.#withSourceIds(trades);
    if (data.length === 0) return 0;
    const result = await this.#db.trade.createMany({ data });
    return result.count;
  }

  async listWhaleTrades(input: {
    coinId?: string | null;
    minUsd: number;
    from: Date;
    to: Date;
    limit: number;
  }): Promise<Trade[]> {
    const rows = await this.#db.trade.findMany({
      where: {
        ...(input.coinId ? { coinId: input.coinId } : {}),
        valueUsd: { gte: input.minUsd },
        occurredAt: { gte: input.from, lte: input.to },
      },
      orderBy: [{ valueUsd: 'desc' }, { occurredAt: 'desc' }],
      take: input.limit,
    });
    return rows.map(toTrade);
  }

  // ─── Venues & liquidity ────────────────────────────────────────────────────

  /**
   * Record the venue/pair set, reporting which pairs are new.
   *
   * The `created` list is the "new listing" signal — the whole reason pairs are
   * stored with a `firstSeenAt` rather than treated as static reference data.
   */
  async recordTradingPairs(
    pairs: readonly WithSourceKey<
      Omit<TradingPair, 'id' | 'sourceId' | 'firstSeenAt' | 'lastSeenAt'>
    >[],
  ): Promise<{ created: TradingPair[]; updated: number }> {
    const data = await this.#withSourceIds(pairs);
    if (data.length === 0) return { created: [], updated: 0 };

    const existing = await this.#db.tradingPair.findMany({
      where: { OR: data.map((pair) => ({ venue: pair.venue, symbol: pair.symbol })) },
      select: { venue: true, symbol: true },
    });
    const existingKeys = new Set(existing.map((pair) => `${pair.venue}:${pair.symbol}`));

    const now = new Date();
    const created: TradingPair[] = [];
    let updated = 0;

    for (const pair of data) {
      const isNew = !existingKeys.has(`${pair.venue}:${pair.symbol}`);
      const row = await this.#db.tradingPair.upsert({
        where: { venue_symbol: { venue: pair.venue, symbol: pair.symbol } },
        create: { ...pair, firstSeenAt: now, lastSeenAt: now },
        update: {
          volume24hUsd: pair.volume24hUsd,
          spread: pair.spread,
          isActive: pair.isActive ?? true,
          lastSeenAt: now,
        },
      });
      if (isNew) created.push(row);
      else updated++;
    }

    return { created, updated };
  }

  async listTradingPairs(coinId: string): Promise<TradingPair[]> {
    return this.#db.tradingPair.findMany({
      where: { coinId, isActive: true },
      orderBy: [{ volume24hUsd: { sort: 'desc', nulls: 'last' } }],
    });
  }

  async insertListing(
    listing: WithSourceKey<Omit<ExchangeListing, 'id' | 'sourceId'>>,
  ): Promise<ExchangeListing> {
    const [data] = await this.#withSourceIds([listing]);
    if (!data) throw new Error(`Unknown source key "${listing.sourceKey}"`);
    return this.#db.exchangeListing.upsert({
      where: {
        coinId_venue_symbol: { coinId: data.coinId, venue: data.venue, symbol: data.symbol },
      },
      create: data,
      // Keep the original detection time: that is the fact of interest.
      update: { url: data.url },
    });
  }

  async listListings(coinId: string, limit: number): Promise<ExchangeListing[]> {
    return this.#db.exchangeListing.findMany({
      where: { coinId },
      orderBy: { detectedAt: 'desc' },
      take: limit,
    });
  }

  async insertLiquidityPools(
    pools: readonly WithSourceKey<Omit<LiquidityPool, 'id' | 'sourceId'>>[],
  ): Promise<number> {
    const data = await this.#withSourceIds(pools);
    if (data.length === 0) return 0;
    const result = await this.#db.liquidityPool.createMany({ data });
    return result.count;
  }

  async latestLiquidityPools(coinId: string, limit: number): Promise<LiquidityPool[]> {
    const rows = await this.#db.$queryRaw<Array<LiquidityPool & { chain: string }>>`
      SELECT DISTINCT ON ("poolAddress") *
      FROM "LiquidityPool"
      WHERE "coinId" = ${coinId}
      ORDER BY "poolAddress", "observedAt" DESC
      LIMIT ${limit}
    `;
    return rows.map(toLiquidityPool);
  }
}
