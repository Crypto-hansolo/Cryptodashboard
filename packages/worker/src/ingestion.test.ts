import { describe, expect, it } from 'vitest';
import { clusterBatch } from '@cid/core';
import type { CollectionResult, Event, EventDraft, RealtimeBus } from '@cid/core';
import { fakeRepositories } from '@cid/platform/testing';
import type { CidRepositories } from '@cid/db';
import { IngestionService } from './ingestion.js';

/**
 * The single write path into the database, and therefore the place where a
 * mistake is systemic rather than local: a wrong `created` flag double-fires
 * alerts for every source at once, and a mis-zipped record attaches an article
 * to the wrong event.
 */

const NOW = new Date('2026-07-25T12:00:00.000Z');

function draft(overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    occurredAt: new Date(NOW.getTime() - 600_000),
    sourceKey: 'coindesk',
    coinId: 'coin-btc',
    category: 'NEWS',
    subtype: 'ARTICLE',
    headline: 'Bitcoin holds $90k',
    body: null,
    url: 'https://example.com/a',
    author: null,
    payload: {},
    ...overrides,
  } as EventDraft;
}

function storedEvent(id: string, overrides: Partial<Event> = {}): Event {
  return {
    id,
    sourceId: 'source-1',
    coinId: 'coin-btc',
    occurredAt: new Date(NOW.getTime() - 600_000),
    ingestedAt: NOW,
    category: 'NEWS',
    subtype: 'ARTICLE',
    headline: 'Bitcoin holds $90k',
    body: null,
    url: 'https://example.com/a',
    author: null,
    relatedCoinIds: [],
    clusterId: null,
    dedupeHash: `hash-${id}`,
    payload: {},
    intelligence: {
      summary: null,
      explanation: null,
      sentiment: null,
      sentimentScore: null,
      importance: null,
      confidence: null,
      impact: null,
      narratives: [],
      isFud: false,
      model: null,
      enrichedAt: null,
    },
    ...overrides,
  } as Event;
}

interface Harness {
  service: IngestionService;
  published: Array<{ channel: string; message: unknown }>;
  intelligenceUpdates: Array<{ eventId: string; patch: Record<string, unknown> }>;
  clusters: Array<{ eventId: string; clusterId: string }>;
  calls: Record<string, unknown[]>;
}

/**
 * Build the service over stubs.
 *
 * `events.insertMany` is scripted with the insert outcomes, which is the pivot
 * everything else in `ingest` keys off.
 */
function harness(
  options: {
    inserted?: Array<{ event: Event; created: boolean }>;
    events?: Record<string, Event>;
    candidates?: Array<{
      id: string;
      headline: string;
      occurredAt: Date;
      clusterId: string | null;
    }>;
    contentStubs?: Record<string, unknown>;
    marketStubs?: Record<string, unknown>;
  } = {},
): Harness {
  const published: Array<{ channel: string; message: unknown }> = [];
  const intelligenceUpdates: Array<{ eventId: string; patch: Record<string, unknown> }> = [];
  const clusters: Array<{ eventId: string; clusterId: string }> = [];
  const calls: Record<string, unknown[]> = {};

  const record = (name: string, value: unknown): void => {
    (calls[name] ??= []).push(value);
  };

  const byId = options.events ?? {};

  const repositories = fakeRepositories({
    sources: {
      ensure: async (input: unknown) => {
        record('sources.ensure', input);
        return { id: 'source-1' };
      },
      listEnabled: async () => [{ id: 'source-1', credibility: 0.9 }],
    },
    events: {
      insertMany: async (drafts: readonly EventDraft[]) => {
        record('events.insertMany', drafts);
        return (
          options.inserted ??
          drafts.map((_, index) => ({ event: storedEvent(`event-${index}`), created: true }))
        );
      },
      findById: async (id: string) => byId[id] ?? storedEvent(id),
      listRecentForClustering: async () => options.candidates ?? [],
      setCluster: async (eventId: string, clusterId: string) => {
        clusters.push({ eventId, clusterId });
      },
      updateIntelligence: async (eventId: string, patch: Record<string, unknown>) => {
        intelligenceUpdates.push({ eventId, patch });
      },
    },
    market: {
      insertSnapshots: async (rows: unknown[]) => {
        record('market.insertSnapshots', rows);
        return rows.length;
      },
      insertCandles: async (rows: unknown[]) => rows.length,
      recordTradingPairs: async (rows: unknown[]) => {
        record('market.recordTradingPairs', rows);
        return { created: [], updated: rows.length };
      },
      insertListing: async (row: unknown) => {
        record('market.insertListing', row);
      },
      ...options.marketStubs,
    },
    content: {
      insertNews: async (rows: unknown[]) => {
        record('content.insertNews', rows);
        return rows.length;
      },
      insertSocialPosts: async (rows: unknown[]) => {
        record('content.insertSocialPosts', rows);
        return rows.length;
      },
      insertSocialMetrics: async (rows: unknown[]) => rows.length,
      ...options.contentStubs,
    },
  }) as unknown as CidRepositories;

  const realtime: RealtimeBus = {
    publish: async (channel, message) => {
      published.push({ channel, message });
    },
    subscribe: async () => async () => {},
  };

  return {
    service: new IngestionService({ repositories, realtime }),
    published,
    intelligenceUpdates,
    clusters,
    calls,
  };
}

function result(overrides: Partial<CollectionResult> = {}): CollectionResult {
  return { events: [], records: {}, itemsFetched: 0, ...overrides };
}

describe('IngestionService.registerConnector', () => {
  it('registers the source row from the descriptor, so sourceKey resolution works', async () => {
    const { service, calls } = harness();

    await service.registerConnector({
      descriptor: {
        key: 'coindesk',
        name: 'CoinDesk',
        sourceKind: 'NEWS',
        homepageUrl: 'https://www.coindesk.com',
        credibility: 0.9,
      },
    } as never);

    expect(calls['sources.ensure']?.[0]).toEqual({
      key: 'coindesk',
      name: 'CoinDesk',
      kind: 'NEWS',
      homepageUrl: 'https://www.coindesk.com',
      credibility: 0.9,
    });
  });
});

describe('IngestionService.ingest', () => {
  it('reports created and skipped counts separately', async () => {
    /*
     * The distinction is the alerting contract: a duplicate must not look like
     * news. A feed that re-publishes its whole page every minute would otherwise
     * fire the same alert every minute.
     */
    const { service } = harness({
      inserted: [
        { event: storedEvent('event-new'), created: true },
        { event: storedEvent('event-dup'), created: false },
      ],
    });

    const outcome = await service.ingest('coindesk', result({ events: [draft(), draft()] }));

    expect(outcome.eventsCreated).toBe(1);
    expect(outcome.eventsSkipped).toBe(1);
  });

  it('does nothing at all for an empty run', async () => {
    const { service, calls, published } = harness();

    const outcome = await service.ingest('coingecko', result());

    expect(outcome).toEqual({ eventsCreated: 0, eventsSkipped: 0, recordsWritten: 0 });
    expect(calls['events.insertMany']).toBeUndefined();
    expect(published).toEqual([]);
  });

  it('publishes only newly created events to the realtime bus', async () => {
    // A duplicate arriving from a second outlet must not pop up in the UI again.
    const { service, published } = harness({
      inserted: [
        { event: storedEvent('event-new'), created: true },
        { event: storedEvent('event-dup'), created: false },
      ],
    });

    await service.ingest('coindesk', result({ events: [draft(), draft()] }));

    expect(published).toHaveLength(1);
    expect(published[0]?.channel).toBe('cid:events');
    expect(published[0]?.message).toMatchObject({
      type: 'event',
      payload: { id: 'event-new', headline: 'Bitcoin holds $90k' },
    });
  });

  it('scores a new event immediately so the timeline is sortable', async () => {
    /*
     * Enrichment may be minutes behind. A timeline where half the rows have no
     * importance cannot be sorted or filtered, so ingestion applies the same
     * deterministic scoring the enricher later refines.
     */
    const { service, intelligenceUpdates } = harness({
      inserted: [{ event: storedEvent('event-1'), created: true }],
    });

    await service.ingest('coindesk', result({ events: [draft()] }));

    expect(intelligenceUpdates).toHaveLength(1);
    expect(intelligenceUpdates[0]?.eventId).toBe('event-1');
    const importance = (intelligenceUpdates[0]?.patch as { importance: number }).importance;
    expect(importance).toBeGreaterThan(0);
    expect(importance).toBeLessThanOrEqual(100);
  });

  it('leaves an already-scored event alone', async () => {
    // A connector that supplied an importance hint must not be overwritten.
    const scored = storedEvent('event-1', {
      intelligence: { ...storedEvent('event-1').intelligence, importance: 91 },
    });
    const { service, intelligenceUpdates } = harness({
      inserted: [{ event: scored, created: true }],
      events: { 'event-1': scored },
    });

    await service.ingest('coindesk', result({ events: [draft()] }));

    expect(intelligenceUpdates).toEqual([]);
  });

  it('clusters a new event with an existing near-duplicate from another source', async () => {
    /*
     * Six outlets covering one story is itself a signal, so they are clustered
     * rather than discarded and the timeline collapses them.
     */
    const headline = 'Binance lists Cronos CRO for spot trading on July 26';
    const older = {
      id: 'event-old',
      headline: 'Binance will list Cronos CRO for spot trading on July 26',
      occurredAt: new Date(NOW.getTime() - 1_800_000),
      clusterId: null,
    };
    /*
     * Cluster ids are derived from the earliest story in the cluster, so the id
     * the older event already carries is what the new one must join. Deriving the
     * expected value with the same pure function keeps this a test of the joining
     * behaviour rather than a restatement of the hash.
     */
    const existingClusterId = clusterBatch([older]).get('event-old');
    const newEvent = storedEvent('event-new', { headline });

    const { service, clusters } = harness({
      inserted: [{ event: newEvent, created: true }],
      events: { 'event-new': newEvent },
      candidates: [
        { ...older, clusterId: existingClusterId ?? null },
        { id: 'event-new', headline, occurredAt: NOW, clusterId: null },
      ],
    });

    await service.ingest('coindesk', result({ events: [draft({ headline })] }));

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.eventId).toBe('event-new');
    expect(clusters[0]?.clusterId).toBe(existingClusterId);
  });

  it('never rewrites the cluster of an event this run did not create', async () => {
    // Clustering compares against recent events from every source; only the new
    // rows may be updated, or one run would churn the whole window.
    const { service, clusters } = harness({
      inserted: [{ event: storedEvent('event-new'), created: true }],
      candidates: [
        {
          id: 'event-other',
          headline: 'Something entirely unrelated about Solana staking',
          occurredAt: NOW,
          clusterId: null,
        },
      ],
    });

    await service.ingest('coindesk', result({ events: [draft()] }));

    expect(clusters.every((entry) => entry.eventId === 'event-new')).toBe(true);
  });

  it('writes market records that need no event linkage', async () => {
    const { service, calls } = harness();

    const outcome = await service.ingest(
      'coingecko',
      result({
        records: { marketSnapshots: [{ coinId: 'coin-btc', priceUsd: 90_000 }] },
      }),
    );

    expect(calls['market.insertSnapshots']?.[0]).toHaveLength(1);
    expect(outcome.recordsWritten).toBe(1);
  });

  it('zips event-linked records against the inserted event ids by position', async () => {
    /*
     * The coupling connectors are documented to rely on: emit records in the same
     * order as their events, and ingestion attaches the ids. Getting this wrong
     * attaches an article's body to a different story.
     */
    const { service, calls } = harness({
      inserted: [
        { event: storedEvent('event-a'), created: true },
        { event: storedEvent('event-b'), created: true },
      ],
    });

    await service.ingest(
      'coindesk',
      result({
        events: [draft({ headline: 'first' }), draft({ headline: 'second' })],
        records: { news: [{ title: 'first' }, { title: 'second' }] },
      }),
    );

    expect(calls['content.insertNews']?.[0]).toEqual([
      { title: 'first', eventId: 'event-a' },
      { title: 'second', eventId: 'event-b' },
    ]);
  });

  it('links a record to a duplicate event too, since the row still belongs to it', async () => {
    const { service, calls } = harness({
      inserted: [
        { event: storedEvent('event-a'), created: true },
        { event: storedEvent('event-dup'), created: false },
      ],
    });

    await service.ingest(
      'coindesk',
      result({
        events: [draft(), draft()],
        records: { news: [{ title: 'first' }, { title: 'second' }] },
      }),
    );

    expect(calls['content.insertNews']?.[0]).toEqual([
      { title: 'first', eventId: 'event-a' },
      { title: 'second', eventId: 'event-dup' },
    ]);
  });

  it('drops a record with no corresponding event rather than orphaning it', async () => {
    // A connector emitting more records than events is a connector bug; storing a
    // row with no event would put a story in the database that the timeline can
    // never show.
    const { service, calls } = harness({
      inserted: [{ event: storedEvent('event-a'), created: true }],
    });

    const outcome = await service.ingest(
      'coindesk',
      result({
        events: [draft()],
        records: { news: [{ title: 'first' }, { title: 'orphan' }] },
      }),
    );

    expect(calls['content.insertNews']?.[0]).toEqual([{ title: 'first', eventId: 'event-a' }]);
    // The count reflects what was actually written.
    expect(outcome.recordsWritten).toBe(1);
  });

  it('turns a newly seen trading pair into an exchange listing', async () => {
    /*
     * This is how "new Binance listing" alerts work without a listings API: a
     * pair we have never seen before *is* the listing.
     */
    const { service, calls } = harness({
      marketStubs: {
        recordTradingPairs: async () => ({
          created: [
            {
              coinId: 'coin-cro',
              venue: 'binance',
              venueKind: 'CEX',
              symbol: 'CROUSDT',
              firstSeenAt: NOW,
            },
          ],
          updated: 0,
        }),
      },
    });

    const outcome = await service.ingest(
      'binance',
      result({ records: { tradingPairs: [{ coinId: 'coin-cro', symbol: 'CROUSDT' }] } }),
    );

    expect(calls['market.insertListing']?.[0]).toEqual({
      sourceKey: 'binance',
      coinId: 'coin-cro',
      venue: 'binance',
      venueKind: 'CEX',
      symbol: 'CROUSDT',
      detectedAt: NOW,
      url: null,
    });
    expect(outcome.recordsWritten).toBe(1);
  });

  it('does not emit a listing for a pair it has seen before', async () => {
    const { service, calls } = harness();

    const outcome = await service.ingest(
      'binance',
      result({ records: { tradingPairs: [{ coinId: 'coin-btc', symbol: 'BTCUSDT' }] } }),
    );

    expect(calls['market.insertListing']).toBeUndefined();
    expect(outcome.recordsWritten).toBe(1);
  });

  it('accumulates counts across several record buckets', async () => {
    const { service } = harness();

    const outcome = await service.ingest(
      'mixed',
      result({
        records: {
          marketSnapshots: [{ a: 1 }, { a: 2 }],
          socialMetrics: [{ b: 1 }],
        },
      }),
    );

    expect(outcome.recordsWritten).toBe(3);
  });
});
