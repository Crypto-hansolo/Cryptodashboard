import type {
  AnalyticsRepository,
  CoinRanking,
  NarrativeSummary,
  Report,
  ReportInputs,
  ReportRepository,
  RunStatus,
  TelemetryRepository,
  CollectorRunRecord,
} from '@cid/core';
import { Prisma } from '@prisma/client';
import type { Db } from '../client.js';

/**
 * Reports, aggregate rankings and connector telemetry.
 *
 * The ranking queries are pushed into SQL rather than pulled into JS on purpose:
 * "most bullish coin this week" is an aggregate over potentially millions of
 * events, and streaming those into Node to reduce them would dominate report
 * generation time.
 */

export class PrismaReportRepository implements ReportRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async insert(report: Omit<Report, 'id' | 'createdAt'>): Promise<Report> {
    const row = await this.#db.report.create({
      data: { ...report, metadata: (report.metadata ?? {}) as Prisma.InputJsonValue },
    });
    return { ...row, metadata: (row.metadata ?? {}) as Record<string, unknown> };
  }

  async findLatest(kind: Report['kind'], coinId?: string | null): Promise<Report | null> {
    const row = await this.#db.report.findFirst({
      where: { kind, ...(coinId !== undefined ? { coinId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    return row ? { ...row, metadata: (row.metadata ?? {}) as Record<string, unknown> } : null;
  }

  async list(input: { kind?: Report['kind']; limit: number }): Promise<Report[]> {
    const rows = await this.#db.report.findMany({
      where: input.kind ? { kind: input.kind } : {},
      orderBy: { createdAt: 'desc' },
      take: input.limit,
    });
    return rows.map((row) => ({
      ...row,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
    }));
  }

  async findById(id: string): Promise<Report | null> {
    const row = await this.#db.report.findUnique({ where: { id } });
    return row ? { ...row, metadata: (row.metadata ?? {}) as Record<string, unknown> } : null;
  }
}

export class PrismaAnalyticsRepository implements AnalyticsRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * Rank coins by mean event sentiment in a window.
   *
   * Weighted by importance and source credibility, so a bullish reading is
   * driven by material news rather than by volume of chatter. The minimum event
   * count guards against a coin topping the chart on the strength of one post.
   */
  async rankBySentiment(input: {
    from: Date;
    to: Date;
    direction: 'bullish' | 'bearish';
    limit: number;
  }): Promise<CoinRanking[]> {
    const rows = await this.#db.$queryRaw<
      Array<{
        coinId: string;
        symbol: string;
        name: string;
        score: number;
        event_count: bigint;
        mean_importance: number | null;
      }>
    >`
      SELECT
        c.id AS "coinId",
        c.symbol,
        c.name,
        -- Importance-and-credibility weighted mean sentiment.
        sum(e."sentimentScore" * coalesce(e.importance, 50) * s.credibility)
          / nullif(sum(coalesce(e.importance, 50) * s.credibility), 0) AS score,
        count(*) AS event_count,
        avg(e.importance) AS mean_importance
      FROM "Event" e
      JOIN "Coin" c ON c.id = e."coinId"
      JOIN "Source" s ON s.id = e."sourceId"
      WHERE e."occurredAt" >= ${input.from}
        AND e."occurredAt" <= ${input.to}
        AND e."sentimentScore" IS NOT NULL
      GROUP BY c.id, c.symbol, c.name
      HAVING count(*) >= 3
      ORDER BY score ${input.direction === 'bullish' ? Prisma.sql`DESC` : Prisma.sql`ASC`}
      LIMIT ${input.limit}
    `;

    return rows.map((row) => ({
      coinId: row.coinId,
      symbol: row.symbol,
      name: row.name,
      score: Number(row.score),
      detail: {
        eventCount: Number(row.event_count),
        meanImportance: row.mean_importance === null ? null : Number(row.mean_importance),
      },
    }));
  }

  /** Rank by the latest development-activity score per coin. */
  async rankByDevActivity(limit: number): Promise<CoinRanking[]> {
    const rows = await this.#db.$queryRaw<
      Array<{
        coinId: string;
        symbol: string;
        name: string;
        score: number | null;
        commits: number | null;
        contributors: number | null;
      }>
    >`
      SELECT c.id AS "coinId", c.symbol, c.name,
             latest."activityScore" AS score,
             latest."commits30d" AS commits,
             latest."contributors30d" AS contributors
      FROM "Coin" c
      JOIN LATERAL (
        SELECT "activityScore", "commits30d", "contributors30d"
        FROM "GithubRepoSnapshot" g
        WHERE g."coinId" = c.id
        ORDER BY g."observedAt" DESC
        LIMIT 1
      ) latest ON true
      WHERE latest."activityScore" IS NOT NULL
      ORDER BY latest."activityScore" DESC
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
      coinId: row.coinId,
      symbol: row.symbol,
      name: row.name,
      score: Number(row.score ?? 0),
      detail: {
        commits30d: row.commits === null ? null : Number(row.commits),
        contributors30d: row.contributors === null ? null : Number(row.contributors),
      },
    }));
  }

  /**
   * Biggest movers over a window.
   *
   * Compares the first and last snapshot inside the range per coin, rather than
   * trusting a provider's `priceChange24hPct`, so the window is exactly the one
   * the report covers.
   */
  async rankByPriceMove(input: { from: Date; to: Date; limit: number }): Promise<CoinRanking[]> {
    const rows = await this.#db.$queryRaw<
      Array<{
        coinId: string;
        symbol: string;
        name: string;
        change_pct: number | null;
        first_price: number;
        last_price: number;
      }>
    >`
      SELECT c.id AS "coinId", c.symbol, c.name,
             CASE WHEN bounds.first_price > 0
               THEN ((bounds.last_price - bounds.first_price) / bounds.first_price) * 100
               ELSE NULL END AS change_pct,
             bounds.first_price, bounds.last_price
      FROM "Coin" c
      JOIN LATERAL (
        SELECT
          (array_agg("priceUsd" ORDER BY "observedAt" ASC))[1] AS first_price,
          (array_agg("priceUsd" ORDER BY "observedAt" DESC))[1] AS last_price
        FROM "MarketSnapshot" m
        WHERE m."coinId" = c.id
          AND m."observedAt" >= ${input.from}
          AND m."observedAt" <= ${input.to}
      ) bounds ON bounds.first_price IS NOT NULL
      WHERE bounds.first_price > 0
      ORDER BY abs((bounds.last_price - bounds.first_price) / bounds.first_price) DESC
      LIMIT ${input.limit}
    `;

    return rows.map((row) => ({
      coinId: row.coinId,
      symbol: row.symbol,
      name: row.name,
      score: Number(row.change_pct ?? 0),
      detail: { fromPrice: Number(row.first_price), toPrice: Number(row.last_price) },
    }));
  }

  /**
   * Most active narratives in a window.
   *
   * Narratives are an array column populated by the enricher, so this unnests
   * them and aggregates. Cheap because the window is bounded.
   */
  async topNarratives(input: { from: Date; to: Date; limit: number }): Promise<NarrativeSummary[]> {
    const rows = await this.#db.$queryRaw<
      Array<{
        narrative: string;
        event_count: bigint;
        mean_sentiment: number | null;
        mean_importance: number | null;
        coin_ids: string[];
        headlines: string[];
      }>
    >`
      SELECT
        narrative,
        count(*) AS event_count,
        avg("sentimentScore") AS mean_sentiment,
        avg(importance) AS mean_importance,
        (array_agg(DISTINCT "coinId") FILTER (WHERE "coinId" IS NOT NULL))[1:10] AS coin_ids,
        (array_agg(headline ORDER BY importance DESC NULLS LAST))[1:3] AS headlines
      FROM "Event", unnest(narratives) AS narrative
      WHERE "occurredAt" >= ${input.from} AND "occurredAt" <= ${input.to}
      GROUP BY narrative
      HAVING count(*) >= 2
      ORDER BY count(*) DESC, avg(importance) DESC NULLS LAST
      LIMIT ${input.limit}
    `;

    return rows.map((row) => ({
      narrative: row.narrative,
      eventCount: Number(row.event_count),
      meanSentiment: Number(row.mean_sentiment ?? 0),
      meanImportance: Number(row.mean_importance ?? 0),
      coinIds: row.coin_ids ?? [],
      topHeadlines: row.headlines ?? [],
    }));
  }

  /** Assemble everything a period report needs, in parallel. */
  async reportInputs(input: {
    from: Date;
    to: Date;
    coinIds?: readonly string[];
    portfolioId?: string | null;
  }): Promise<ReportInputs> {
    const coinIds = input.coinIds?.length ? [...input.coinIds] : undefined;

    const [
      mostBullish,
      mostBearish,
      developerActivity,
      topMovers,
      narratives,
      keyEventRows,
      eventCount,
    ] = await Promise.all([
      this.rankBySentiment({ from: input.from, to: input.to, direction: 'bullish', limit: 10 }),
      this.rankBySentiment({ from: input.from, to: input.to, direction: 'bearish', limit: 10 }),
      this.rankByDevActivity(10),
      this.rankByPriceMove({ from: input.from, to: input.to, limit: 10 }),
      this.topNarratives({ from: input.from, to: input.to, limit: 8 }),
      this.#db.event.findMany({
        where: {
          occurredAt: { gte: input.from, lte: input.to },
          ...(coinIds ? { coinId: { in: coinIds } } : {}),
        },
        orderBy: [{ importance: { sort: 'desc', nulls: 'last' } }, { occurredAt: 'desc' }],
        take: 40,
        include: {
          coin: { select: { symbol: true } },
          source: { select: { name: true } },
        },
      }),
      this.#db.event.count({
        where: {
          occurredAt: { gte: input.from, lte: input.to },
          ...(coinIds ? { coinId: { in: coinIds } } : {}),
        },
      }),
    ]);

    // Collapse dedupe clusters so the report does not cite the same story twice.
    const seenClusters = new Set<string>();
    const keyEvents = keyEventRows
      .filter((row) => {
        if (!row.clusterId) return true;
        if (seenClusters.has(row.clusterId)) return false;
        seenClusters.add(row.clusterId);
        return true;
      })
      .slice(0, 25)
      .map((row) => ({
        id: row.id,
        occurredAt: row.occurredAt,
        coinSymbol: row.coin?.symbol ?? null,
        headline: row.headline,
        summary: row.summary,
        importance: row.importance,
        sentiment: row.sentiment,
        sourceName: row.source.name,
        url: row.url,
      }));

    return {
      periodStart: input.from,
      periodEnd: input.to,
      coinRankings: { mostBullish, mostBearish, developerActivity, topMovers },
      narratives,
      keyEvents,
      eventCount,
    };
  }
}

export class PrismaTelemetryRepository implements TelemetryRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async recordRun(run: CollectorRunRecord): Promise<void> {
    await this.#db.collectorRun.create({
      data: {
        connectorKey: run.connectorKey,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        status: run.status,
        itemsFetched: run.itemsFetched,
        itemsIngested: run.itemsIngested,
        durationMs: run.durationMs,
        // Errors can be enormous (HTML pages, stack traces); bound the column.
        error: run.error === null ? null : run.error.slice(0, 2_000),
        coinIds: run.coinIds,
      },
    });
  }

  async connectorHealth(since: Date): Promise<
    Array<{
      connectorKey: string;
      runs: number;
      failures: number;
      lastRunAt: Date | null;
      lastStatus: RunStatus | null;
      meanDurationMs: number;
      itemsIngested: number;
    }>
  > {
    const rows = await this.#db.$queryRaw<
      Array<{
        connectorKey: string;
        runs: bigint;
        failures: bigint;
        last_run_at: Date | null;
        last_status: RunStatus | null;
        mean_duration: number | null;
        items: bigint | null;
      }>
    >`
      SELECT
        "connectorKey",
        count(*) AS runs,
        count(*) FILTER (WHERE status = 'FAILED') AS failures,
        max("startedAt") AS last_run_at,
        (array_agg(status ORDER BY "startedAt" DESC))[1] AS last_status,
        avg("durationMs") AS mean_duration,
        sum("itemsIngested") AS items
      FROM "CollectorRun"
      WHERE "startedAt" >= ${since}
      GROUP BY "connectorKey"
      ORDER BY "connectorKey" ASC
    `;

    return rows.map((row) => ({
      connectorKey: row.connectorKey,
      runs: Number(row.runs),
      failures: Number(row.failures),
      lastRunAt: row.last_run_at,
      lastStatus: row.last_status,
      meanDurationMs: Math.round(Number(row.mean_duration ?? 0)),
      itemsIngested: Number(row.items ?? 0),
    }));
  }

  /**
   * Ingestion-lag percentiles. This is the number that says whether the
   * "everything within ~1 minute" goal is actually being met.
   */
  async ingestionLag(since: Date): Promise<{ p50Ms: number; p95Ms: number; maxMs: number } | null> {
    const rows = await this.#db.$queryRaw<
      Array<{ p50: number | null; p95: number | null; max: number | null }>
    >`
      SELECT
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM ("ingestedAt" - "occurredAt")) * 1000
        ) AS p50,
        percentile_cont(0.95) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM ("ingestedAt" - "occurredAt")) * 1000
        ) AS p95,
        max(EXTRACT(EPOCH FROM ("ingestedAt" - "occurredAt")) * 1000) AS max
      FROM "Event"
      WHERE "ingestedAt" >= ${since}
        AND "occurredAt" >= ${since}
        -- Guard against clock skew on the provider side producing negatives.
        AND "ingestedAt" >= "occurredAt"
    `;
    const row = rows[0];
    if (!row || row.p50 === null) return null;
    return {
      p50Ms: Math.round(Number(row.p50)),
      p95Ms: Math.round(Number(row.p95 ?? row.p50)),
      maxMs: Math.round(Number(row.max ?? row.p50)),
    };
  }

  /** Read a connector's high-water mark, so a poll fetches only what is new. */
  async getState(
    connectorKey: string,
  ): Promise<{ lastItemAt: Date | null; cursor: string | null }> {
    const row = await this.#db.connectorState.findUnique({ where: { connectorKey } });
    return { lastItemAt: row?.lastItemAt ?? null, cursor: row?.cursor ?? null };
  }

  async setState(
    connectorKey: string,
    patch: { lastItemAt?: Date | null; cursor?: string | null },
  ): Promise<void> {
    await this.#db.connectorState.upsert({
      where: { connectorKey },
      create: {
        connectorKey,
        lastItemAt: patch.lastItemAt ?? null,
        cursor: patch.cursor ?? null,
        lastRunAt: new Date(),
      },
      update: {
        ...(patch.lastItemAt !== undefined ? { lastItemAt: patch.lastItemAt } : {}),
        ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}),
        lastRunAt: new Date(),
      },
    });
  }

  /** Trim telemetry history; unbounded run logs eventually dwarf the real data. */
  async pruneRuns(olderThan: Date): Promise<number> {
    const result = await this.#db.collectorRun.deleteMany({
      where: { startedAt: { lt: olderThan } },
    });
    return result.count;
  }
}
