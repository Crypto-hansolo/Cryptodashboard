import type {
  Event,
  EventCategory,
  EventDraft,
  EventRepository,
  InsertEventResult,
  Intelligence,
  Page,
  TimelineEntry,
  TimelineFilter,
} from '@cid/core';
import { computeDedupeHash } from '@cid/core';
import type { Prisma } from '@prisma/client';
import type { Db } from '../client.js';
import { decodeCursor, encodeCursor, fromIntelligence, toEvent } from '../mappers.js';
import type { PrismaSourceRepository } from './source-repository.js';

/**
 * The timeline repository.
 *
 * Two things here carry most of the platform's performance characteristics:
 * the idempotent bulk insert, and keyset-paginated timeline reads. Both are
 * written against the composite indexes declared in schema.prisma.
 */
export class PrismaEventRepository implements EventRepository {
  readonly #db: Db;
  readonly #sources: PrismaSourceRepository;

  constructor(db: Db, sources: PrismaSourceRepository) {
    this.#db = db;
    this.#sources = sources;
  }

  /**
   * Append events, skipping any whose `(sourceId, dedupeHash)` already exists.
   *
   * Implemented as `createMany({ skipDuplicates })` followed by a read-back
   * rather than per-row upserts: a news poll produces 20-50 drafts of which
   * typically zero to two are new, and 50 round trips per connector per minute
   * across 30 connectors is what makes naive aggregators fall over. The
   * `created` flag comes from comparing which hashes existed beforehand, so
   * callers can act only on genuinely new items.
   */
  async insertMany(drafts: readonly EventDraft[]): Promise<InsertEventResult[]> {
    if (drafts.length === 0) return [];

    const sourceIds = await this.#sources.resolveIds(drafts.map((draft) => draft.sourceKey));

    // Compute hashes here, not in connectors, so the rule lives in one place.
    const prepared = drafts.flatMap((draft) => {
      const sourceId = sourceIds.get(draft.sourceKey);
      if (!sourceId) return [];
      const dedupeHash = computeDedupeHash({
        sourceKey: draft.sourceKey,
        externalId: typeof draft.payload?.externalId === 'string' ? draft.payload.externalId : null,
        url: draft.url ?? null,
        headline: draft.headline,
        occurredAt: draft.occurredAt,
      });
      return [{ draft, sourceId, dedupeHash }];
    });

    if (prepared.length === 0) return [];

    // Which of these do we already have?
    const existing = await this.#db.event.findMany({
      where: {
        OR: prepared.map((item) => ({ sourceId: item.sourceId, dedupeHash: item.dedupeHash })),
      },
      select: { id: true, sourceId: true, dedupeHash: true },
    });
    const existingKeys = new Set(existing.map((row) => `${row.sourceId}:${row.dedupeHash}`));

    // De-duplicate within the batch too: a single feed can list the same item
    // twice, and `createMany` would otherwise violate the unique constraint.
    const seenInBatch = new Set<string>();
    const toInsert = prepared.filter((item) => {
      const key = `${item.sourceId}:${item.dedupeHash}`;
      if (existingKeys.has(key) || seenInBatch.has(key)) return false;
      seenInBatch.add(key);
      return true;
    });

    // Keys this call is actually responsible for creating. Used below so that a
    // draft that lost an in-batch duplicate check is not *also* reported as
    // created — callers fire alerts and enqueue enrichment off this flag, so
    // double-reporting means a duplicate notification for one event.
    const insertedKeys = new Set(toInsert.map((item) => `${item.sourceId}:${item.dedupeHash}`));

    if (toInsert.length > 0) {
      await this.#db.event.createMany({
        data: toInsert.map(({ draft, sourceId, dedupeHash }) => ({
          occurredAt: draft.occurredAt,
          coinId: draft.coinId ?? null,
          sourceId,
          category: draft.category,
          subtype: draft.subtype ?? null,
          headline: draft.headline,
          body: draft.body ?? null,
          url: draft.url ?? null,
          author: draft.author ?? null,
          dedupeHash,
          payload: (draft.payload ?? {}) as Prisma.InputJsonValue,
          relatedCoinIds: draft.relatedCoinIds ?? [],
          // Connector hints seed the scoring pass; the enricher refines them.
          importance: draft.importanceHint ?? null,
          sentimentScore: draft.sentimentHint ?? null,
        })),
        skipDuplicates: true,
      });
    }

    // Read back so callers get real ids for every input, new or not.
    const rows = await this.#db.event.findMany({
      where: {
        OR: prepared.map((item) => ({ sourceId: item.sourceId, dedupeHash: item.dedupeHash })),
      },
    });
    const byKey = new Map(rows.map((row) => [`${row.sourceId}:${row.dedupeHash}`, row]));

    // `reported` makes `created` true for at most one draft per identity, even
    // when the input contains the same item twice.
    //
    // Note this is per-call. Two worker replicas racing on the same item can
    // both see it as new; the atomic claim in AlertRepository.recordTrigger is
    // what actually prevents a duplicate notification in that case.
    const reported = new Set<string>();

    return prepared.flatMap(({ sourceId, dedupeHash }) => {
      const key = `${sourceId}:${dedupeHash}`;
      const row = byKey.get(key);
      if (!row) return [];
      const created = insertedKeys.has(key) && !reported.has(key) && !existingKeys.has(key);
      if (created) reported.add(key);
      return [{ event: toEvent(row), created }];
    });
  }

  async findById(id: string): Promise<Event | null> {
    const row = await this.#db.event.findUnique({ where: { id } });
    return row ? toEvent(row) : null;
  }

  /**
   * Keyset-paginated timeline.
   *
   * `collapseDuplicates` keeps one representative per dedupe cluster. It is done
   * with a window function rather than `DISTINCT ON` because we also need the
   * per-cluster count to render "CoinDesk + 11 others".
   */
  async timeline(filter: TimelineFilter): Promise<Page<TimelineEntry>> {
    const cursor = decodeCursor(filter.cursor);
    const limit = Math.min(filter.limit ?? 100, 500);

    const where: Prisma.EventWhereInput = {
      ...(filter.coinIds?.length ? { coinId: { in: [...filter.coinIds] } } : {}),
      ...(filter.categories?.length ? { category: { in: [...filter.categories] } } : {}),
      ...(filter.sentiments?.length ? { sentiment: { in: [...filter.sentiments] } } : {}),
      ...(filter.impacts?.length ? { impact: { in: [...filter.impacts] } } : {}),
      ...(filter.minImportance !== undefined ? { importance: { gte: filter.minImportance } } : {}),
      ...(filter.sourceKeys?.length ? { source: { key: { in: [...filter.sourceKeys] } } } : {}),
      ...(filter.from || filter.to
        ? {
            occurredAt: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lte: filter.to } : {}),
            },
          }
        : {}),
      ...(filter.query
        ? {
            OR: [
              { headline: { contains: filter.query, mode: 'insensitive' } },
              { body: { contains: filter.query, mode: 'insensitive' } },
            ],
          }
        : {}),
      // Keyset predicate: strictly "older than the cursor", with id as tiebreak.
      ...(cursor
        ? {
            OR: [
              { occurredAt: { lt: cursor.occurredAt } },
              { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };

    // Over-fetch by one to detect whether another page exists without a count.
    const rows = await this.#db.event.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        source: { select: { id: true, key: true, name: true, kind: true, credibility: true } },
        coin: { select: { id: true, symbol: true, name: true, imageUrl: true } },
      },
    });

    const hasMore = rows.length > limit;
    let page = hasMore ? rows.slice(0, limit) : rows;

    // Cluster counts, for the "+N others" affordance and for collapsing.
    const clusterIds = [
      ...new Set(page.map((row) => row.clusterId).filter((id): id is string => !!id)),
    ];
    const counts =
      clusterIds.length > 0 ? await this.countByCluster(clusterIds) : new Map<string, number>();

    if (filter.collapseDuplicates !== false) {
      const seenClusters = new Set<string>();
      page = page.filter((row) => {
        if (!row.clusterId) return true;
        if (seenClusters.has(row.clusterId)) return false;
        seenClusters.add(row.clusterId);
        return true;
      });
    }

    const last = hasMore ? rows[limit - 1] : undefined;

    return {
      items: page.map((row) => ({
        event: toEvent(row),
        source: row.source,
        coin: row.coin,
        duplicateCount: row.clusterId ? Math.max(0, (counts.get(row.clusterId) ?? 1) - 1) : 0,
      })),
      nextCursor:
        hasMore && last ? encodeCursor({ occurredAt: last.occurredAt, id: last.id }) : null,
    };
  }

  /**
   * Enrichment queue: unenriched events, most important first.
   * Uses the partial index `Event_pending_enrichment_idx`.
   */
  async listPendingEnrichment(limit: number): Promise<Event[]> {
    const rows = await this.#db.event.findMany({
      where: { enrichedAt: null },
      orderBy: [{ importance: { sort: 'desc', nulls: 'last' } }, { occurredAt: 'desc' }],
      take: limit,
    });
    return rows.map(toEvent);
  }

  async updateIntelligence(eventId: string, intelligence: Partial<Intelligence>): Promise<void> {
    const data = fromIntelligence(intelligence);
    if (Object.keys(data).length === 0) return;
    await this.#db.event.update({ where: { id: eventId }, data });
  }

  async setCluster(eventId: string, clusterId: string): Promise<void> {
    await this.#db.event.update({ where: { id: eventId }, data: { clusterId } });
  }

  async listRecentForClustering(
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
  > {
    return this.#db.event.findMany({
      where: { occurredAt: { gte: since } },
      select: { id: true, headline: true, url: true, occurredAt: true, clusterId: true },
      orderBy: { occurredAt: 'desc' },
      take: limit,
    });
  }

  async countByCluster(clusterIds: readonly string[]): Promise<Map<string, number>> {
    if (clusterIds.length === 0) return new Map();
    const grouped = await this.#db.event.groupBy({
      by: ['clusterId'],
      where: { clusterId: { in: [...clusterIds] } },
      _count: { _all: true },
    });
    return new Map(
      grouped.flatMap((row) => (row.clusterId ? [[row.clusterId, row._count._all]] : [])),
    );
  }

  /**
   * Bucketed event counts for the news-frequency and sentiment charts.
   *
   * `date_bin` (PG14+) rather than `date_trunc`: it supports arbitrary bucket
   * widths, so the UI can ask for 5-minute buckets on an intraday view and
   * 1-day buckets on a quarterly one with the same query.
   */
  async histogram(input: {
    coinId?: string | null;
    categories?: readonly EventCategory[];
    from: Date;
    to: Date;
    bucketMinutes: number;
  }): Promise<Array<{ bucket: Date; count: number; meanSentiment: number | null }>> {
    const interval = `${Math.max(1, Math.floor(input.bucketMinutes))} minutes`;
    const categories = input.categories?.length ? [...input.categories] : null;

    const rows = await this.#db.$queryRaw<
      Array<{ bucket: Date; count: bigint; mean_sentiment: number | null }>
    >`
      SELECT
        date_bin(${interval}::interval, "occurredAt", ${input.from}::timestamptz) AS bucket,
        count(*) AS count,
        avg("sentimentScore") AS mean_sentiment
      FROM "Event"
      WHERE "occurredAt" >= ${input.from} AND "occurredAt" <= ${input.to}
        AND (${input.coinId ?? null}::text IS NULL OR "coinId" = ${input.coinId ?? null})
        AND (${categories}::"EventCategory"[] IS NULL OR category = ANY(${categories}::"EventCategory"[]))
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    return rows.map((row) => ({
      bucket: row.bucket,
      count: Number(row.count),
      meanSentiment: row.mean_sentiment === null ? null : Number(row.mean_sentiment),
    }));
  }

  /** Highest-importance events in a window, deduped by cluster. For reports. */
  async listKeyEvents(input: {
    from: Date;
    to: Date;
    coinIds?: readonly string[];
    limit: number;
    minImportance?: number;
  }): Promise<TimelineEntry[]> {
    const rows = await this.#db.event.findMany({
      where: {
        occurredAt: { gte: input.from, lte: input.to },
        ...(input.coinIds?.length ? { coinId: { in: [...input.coinIds] } } : {}),
        ...(input.minImportance !== undefined ? { importance: { gte: input.minImportance } } : {}),
      },
      orderBy: [{ importance: { sort: 'desc', nulls: 'last' } }, { occurredAt: 'desc' }],
      // Over-fetch, because collapsing clusters will thin the list.
      take: input.limit * 3,
      include: {
        source: { select: { id: true, key: true, name: true, kind: true, credibility: true } },
        coin: { select: { id: true, symbol: true, name: true, imageUrl: true } },
      },
    });

    const seenClusters = new Set<string>();
    const out: TimelineEntry[] = [];
    for (const row of rows) {
      if (row.clusterId) {
        if (seenClusters.has(row.clusterId)) continue;
        seenClusters.add(row.clusterId);
      }
      out.push({
        event: toEvent(row),
        source: row.source,
        coin: row.coin,
        duplicateCount: 0,
      });
      if (out.length >= input.limit) break;
    }
    return out;
  }

  /** Ingestion-lag percentiles — the platform's headline latency SLO. */
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
        -- Backfilled history would swamp the live figure.
        AND "occurredAt" >= ${since}
    `;
    const row = rows[0];
    if (!row || row.p50 === null) return null;
    return {
      p50Ms: Number(row.p50),
      p95Ms: Number(row.p95 ?? row.p50),
      maxMs: Number(row.max ?? row.p50),
    };
  }
}
