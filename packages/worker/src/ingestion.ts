import {
  clusterBatch,
  computeImportance,
  type CollectedRecords,
  type CollectionResult,
  type Connector,
  type EventDraft,
  type Logger,
  type RealtimeBus,
} from '@cid/core';
import { noopLogger } from '@cid/core';
import type { CidRepositories } from '@cid/db';
import { CHANNELS, metrics } from '@cid/platform';

/**
 * The ingestion service — the single write path into the database.
 *
 * Connectors produce normalised drafts; nothing else. This service owns
 * everything that must happen consistently regardless of source:
 *
 *  1. append events, skipping duplicates
 *  2. link the typed domain records to the events they belong to
 *  3. cluster near-duplicate stories across sources
 *  4. score anything the connector did not
 *  5. publish realtime frames and emit metrics
 *
 * Centralising this is what stops thirty connectors each inventing their own
 * dedupe rule and their own idea of what "importance" means.
 */

export interface IngestionResult {
  eventsCreated: number;
  eventsSkipped: number;
  recordsWritten: number;
}

export interface IngestionServiceOptions {
  repositories: CidRepositories;
  realtime: RealtimeBus;
  logger?: Logger;
  /** Window for cross-source duplicate clustering. */
  clusterWindowMs?: number;
}

export class IngestionService {
  readonly #repositories: CidRepositories;
  readonly #realtime: RealtimeBus;
  readonly #logger: Logger;
  readonly #clusterWindowMs: number;

  constructor(options: IngestionServiceOptions) {
    this.#repositories = options.repositories;
    this.#realtime = options.realtime;
    this.#logger = (options.logger ?? noopLogger).child({ component: 'ingestion' });
    this.#clusterWindowMs = options.clusterWindowMs ?? 48 * 3_600_000;
  }

  /** Register a connector's source row so `sourceKey` resolution succeeds. */
  async registerConnector(connector: Connector): Promise<void> {
    const { key, name, sourceKind, homepageUrl, credibility } = connector.descriptor;
    await this.#repositories.sources.ensure({
      key,
      name,
      kind: sourceKind,
      homepageUrl,
      credibility,
    });
  }

  /**
   * Persist one connector run.
   *
   * Events go first so the typed records can reference their ids; the typed
   * records then follow. A failure part-way leaves events without their detail
   * rows, which the UI tolerates (the timeline row still renders) — chosen over
   * one giant transaction, which at a 10s cadence across 18 connectors would
   * hold locks long enough to matter.
   */
  async ingest(connectorKey: string, result: CollectionResult): Promise<IngestionResult> {
    const inserted = await this.#insertEvents(result.events);
    const created = inserted.filter((entry) => entry.created);

    // Link typed records to their events, positionally.
    const recordsWritten = await this.#writeRecords(
      result.records,
      inserted.map((entry) => entry.eventId),
    );

    if (created.length > 0) {
      await this.#clusterNewEvents(created.map((entry) => entry.eventId));
      await this.#scoreUnscored(created.map((entry) => entry.eventId));
      await this.#publish(created.map((entry) => entry.eventId));
    }

    metrics.increment('events_ingested', { connector: connectorKey }, created.length);
    metrics.increment(
      'events_duplicate',
      { connector: connectorKey },
      inserted.length - created.length,
    );

    return {
      eventsCreated: created.length,
      eventsSkipped: inserted.length - created.length,
      recordsWritten,
    };
  }

  async #insertEvents(
    drafts: readonly EventDraft[],
  ): Promise<Array<{ eventId: string; created: boolean; occurredAt: Date }>> {
    if (drafts.length === 0) return [];

    const results = await this.#repositories.events.insertMany(drafts);
    const now = Date.now();

    for (const result of results) {
      if (!result.created) continue;
      // Ingestion lag is the platform's headline SLO; record it per event.
      const lagMs = now - result.event.occurredAt.getTime();
      if (lagMs >= 0) metrics.observe('ingestion_lag_ms', lagMs);
    }

    return results.map((result) => ({
      eventId: result.event.id,
      created: result.created,
      occurredAt: result.event.occurredAt,
    }));
  }

  /**
   * Write the typed records a connector produced.
   *
   * The event-linked buckets — news, socialPosts, onchainEvents, githubActivity
   * and proposals — are zipped against the inserted event ids by position,
   * which is why connectors must emit them in the same order as their events.
   * That coupling is documented in the SDK and is the price of not making every
   * connector do its own id round trip.
   */
  async #writeRecords(records: CollectedRecords, eventIds: readonly string[]): Promise<number> {
    let written = 0;
    const repos = this.#repositories;

    const withEventIds = <T extends Record<string, unknown>>(rows: readonly unknown[]): T[] =>
      rows.flatMap((row, index) => {
        const eventId = eventIds[index];
        // A record with no corresponding event cannot be stored; skipping is
        // correct and is counted by the difference in `written`.
        if (eventId === undefined) return [];
        return [{ ...(row as T), eventId }];
      });

    // ── Market data (no event linkage) ──
    if (records.marketSnapshots?.length) {
      written += await repos.market.insertSnapshots(records.marketSnapshots as never);
    }
    if (records.candles?.length) {
      written += await repos.market.insertCandles(records.candles as never);
    }
    if (records.derivatives?.length) {
      written += await repos.market.insertDerivatives(records.derivatives as never);
    }
    if (records.options?.length) {
      written += await repos.market.insertOptions(records.options as never);
    }
    if (records.liquidations?.length) {
      written += await repos.market.insertLiquidations(records.liquidations as never);
    }
    if (records.trades?.length) {
      written += await repos.market.insertTrades(records.trades as never);
    }
    if (records.liquidityPools?.length) {
      written += await repos.market.insertLiquidityPools(records.liquidityPools as never);
    }

    // ── Trading pairs: new ones are listings, which are themselves events ──
    if (records.tradingPairs?.length) {
      const outcome = await repos.market.recordTradingPairs(records.tradingPairs as never);
      written += outcome.created.length + outcome.updated;
      for (const pair of outcome.created) {
        await repos.market.insertListing({
          sourceKey: pair.venue,
          coinId: pair.coinId,
          venue: pair.venue,
          venueKind: pair.venueKind,
          symbol: pair.symbol,
          detectedAt: pair.firstSeenAt,
          url: null,
        });
      }
      if (outcome.created.length > 0) {
        this.#logger.info(
          {
            count: outcome.created.length,
            venues: [...new Set(outcome.created.map((p) => p.venue))],
          },
          'new trading pairs detected',
        );
      }
    }

    // ── Reference data ──
    if (records.wallets?.length) {
      for (const wallet of records.wallets) {
        await repos.content.upsertWallet(wallet as never);
        written++;
      }
    }
    if (records.socialAuthors?.length) {
      for (const author of records.socialAuthors) {
        await repos.content.upsertSocialAuthor(author as never);
        written++;
      }
    }

    // ── Event-linked content ──
    if (records.news?.length) {
      written += await repos.content.insertNews(withEventIds(records.news) as never);
    }
    if (records.socialPosts?.length) {
      written += await repos.content.insertSocialPosts(withEventIds(records.socialPosts) as never);
    }
    if (records.onchainEvents?.length) {
      written += await repos.content.insertOnchainEvents(
        withEventIds(records.onchainEvents) as never,
      );
    }
    if (records.githubActivity?.length) {
      written += await repos.content.insertGithubActivity(
        withEventIds(records.githubActivity) as never,
      );
    }
    if (records.proposals?.length) {
      const outcome = await repos.content.upsertProposals(withEventIds(records.proposals) as never);
      written += outcome.created.length + outcome.stateChanged.length;
    }

    // ── Aggregates and schedules (no event linkage) ──
    if (records.socialMetrics?.length) {
      written += await repos.content.insertSocialMetrics(records.socialMetrics as never);
    }
    if (records.onchainMetrics?.length) {
      written += await repos.content.insertOnchainMetrics(records.onchainMetrics as never);
    }
    if (records.githubSnapshots?.length) {
      for (const snapshot of records.githubSnapshots) {
        await repos.content.insertGithubSnapshot(snapshot as never);
        written++;
      }
    }
    if (records.unlocks?.length) {
      written += await repos.content.upsertUnlocks(records.unlocks as never);
    }
    if (records.tokenomics?.length) {
      written += await repos.content.insertTokenomics(records.tokenomics as never);
    }

    return written;
  }

  /**
   * Assign cluster ids so the timeline can collapse "CoinDesk + 11 others".
   *
   * Compares new events against recent ones across all sources. Bounded by the
   * time window and a candidate cap, because this is O(new × candidates).
   */
  async #clusterNewEvents(eventIds: readonly string[]): Promise<void> {
    const since = new Date(Date.now() - this.#clusterWindowMs);
    const candidates = await this.#repositories.events.listRecentForClustering(since, 500);
    if (candidates.length === 0) return;

    const newIds = new Set(eventIds);
    const assignments = clusterBatch(candidates, { windowMs: this.#clusterWindowMs });

    for (const candidate of candidates) {
      // Only write for the events this run created, and only when the assignment
      // actually changes something.
      if (!newIds.has(candidate.id)) continue;
      const clusterId = assignments.get(candidate.id);
      if (clusterId && clusterId !== candidate.clusterId) {
        await this.#repositories.events.setCluster(candidate.id, clusterId);
      }
    }
  }

  /**
   * Give every new event a baseline importance immediately.
   *
   * The AI enrichment queue may be minutes behind, and a timeline where half the
   * rows have no importance cannot be sorted or filtered. This applies the same
   * deterministic scoring the enricher later refines.
   */
  async #scoreUnscored(eventIds: readonly string[]): Promise<void> {
    const sources = await this.#repositories.sources.listEnabled();
    const credibility = new Map(sources.map((source) => [source.id, source.credibility]));

    for (const eventId of eventIds) {
      const event = await this.#repositories.events.findById(eventId);
      if (!event || event.intelligence.importance !== null) continue;

      const importance = computeImportance({
        category: event.category,
        sourceCredibility: credibility.get(event.sourceId) ?? 0.5,
        ageMs: Date.now() - event.occurredAt.getTime(),
      });

      await this.#repositories.events.updateIntelligence(eventId, { importance });
    }
  }

  /** Push new events to connected SSE clients. */
  async #publish(eventIds: readonly string[]): Promise<void> {
    for (const eventId of eventIds) {
      const event = await this.#repositories.events.findById(eventId);
      if (!event) continue;
      await this.#realtime.publish(CHANNELS.events, {
        type: 'event',
        payload: {
          id: event.id,
          occurredAt: event.occurredAt.toISOString(),
          coinId: event.coinId,
          category: event.category,
          headline: event.headline,
          url: event.url,
          importance: event.intelligence.importance,
          sentiment: event.intelligence.sentiment,
        },
      });
    }
  }
}
