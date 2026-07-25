import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EventDraft } from '@cid/core';
import {
  createTestContext,
  hasDatabase,
  resetDatabase,
  seedCoin,
  seedSources,
  type TestContext,
} from './setup.js';

/**
 * Event repository against real Postgres.
 *
 * Covers the two behaviours that carry the platform's correctness and
 * performance: idempotent bulk insert, and keyset-paginated timeline reads.
 */
describe.skipIf(!hasDatabase)('PrismaEventRepository (integration)', () => {
  let ctx: TestContext;
  let coinId: string;
  let ethId: string;

  beforeAll(() => {
    ctx = createTestContext();
  });

  afterAll(async () => {
    await ctx.db.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.db);
    ctx.repositories.sources.clearCache();
    await seedSources(ctx.db);
    coinId = await seedCoin(ctx.db);
    ethId = await seedCoin(ctx.db, { slug: 'ethereum', symbol: 'ETH', name: 'Ethereum', rank: 2 });
  });

  const draft = (overrides: Partial<EventDraft> = {}): EventDraft => ({
    occurredAt: new Date('2026-06-01T12:00:00Z'),
    sourceKey: 'coindesk',
    coinId,
    category: 'NEWS',
    headline: 'Bitcoin ETF inflows reach a record high',
    url: 'https://example.test/a',
    ...overrides,
  });

  describe('insertMany', () => {
    it('inserts new events and reports them as created', async () => {
      const results = await ctx.repositories.events.insertMany([draft()]);
      expect(results).toHaveLength(1);
      expect(results[0]?.created).toBe(true);
      expect(results[0]?.event.id).toBeTruthy();
      expect(results[0]?.event.headline).toBe('Bitcoin ETF inflows reach a record high');
    });

    it('is idempotent: re-polling the same feed creates nothing', async () => {
      await ctx.repositories.events.insertMany([draft()]);
      const second = await ctx.repositories.events.insertMany([draft()]);

      expect(second[0]?.created).toBe(false);
      expect(await ctx.db.event.count()).toBe(1);
    });

    it('returns a stable id for an already-known event', async () => {
      const first = await ctx.repositories.events.insertMany([draft()]);
      const second = await ctx.repositories.events.insertMany([draft()]);
      expect(second[0]?.event.id).toBe(first[0]?.event.id);
    });

    it('deduplicates within a single batch', async () => {
      // A feed listing the same item twice must not violate the unique index.
      const results = await ctx.repositories.events.insertMany([draft(), draft()]);
      expect(results).toHaveLength(2);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await ctx.db.event.count()).toBe(1);
    });

    it('treats the same story from two sources as two events', async () => {
      await ctx.repositories.events.insertMany([
        draft({ sourceKey: 'coindesk' }),
        draft({ sourceKey: 'theblock', url: 'https://example.test/b' }),
      ]);
      expect(await ctx.db.event.count()).toBe(2);
    });

    it('ignores tracking parameters when deciding identity', async () => {
      await ctx.repositories.events.insertMany([draft({ url: 'https://example.test/a' })]);
      const second = await ctx.repositories.events.insertMany([
        draft({ url: 'https://example.test/a?utm_source=rss' }),
      ]);
      expect(second[0]?.created).toBe(false);
    });

    it('skips drafts whose source is not registered', async () => {
      const results = await ctx.repositories.events.insertMany([
        draft({ sourceKey: 'does-not-exist' }),
      ]);
      expect(results).toHaveLength(0);
      expect(await ctx.db.event.count()).toBe(0);
    });

    it('persists connector hints as the scoring prior', async () => {
      const results = await ctx.repositories.events.insertMany([
        draft({ importanceHint: 88, sentimentHint: -0.6 }),
      ]);
      const row = await ctx.db.event.findUnique({ where: { id: results[0]!.event.id } });
      expect(row?.importance).toBe(88);
      expect(row?.sentimentScore).toBeCloseTo(-0.6);
    });

    it('handles an empty batch', async () => {
      expect(await ctx.repositories.events.insertMany([])).toEqual([]);
    });

    it('inserts a large batch in one round trip', async () => {
      const drafts = Array.from({ length: 200 }, (_, i) =>
        draft({ headline: `Event number ${i}`, url: `https://example.test/${i}` }),
      );
      const results = await ctx.repositories.events.insertMany(drafts);
      expect(results.filter((r) => r.created)).toHaveLength(200);
    });
  });

  describe('timeline', () => {
    beforeEach(async () => {
      // 25 events, newest first, alternating coin and category.
      const drafts = Array.from({ length: 25 }, (_, i) =>
        draft({
          headline: `Headline ${i}`,
          url: `https://example.test/t/${i}`,
          occurredAt: new Date(Date.UTC(2026, 5, 1, 12, 0, 0) - i * 60_000),
          coinId: i % 2 === 0 ? coinId : ethId,
          category: i % 3 === 0 ? 'SECURITY' : 'NEWS',
        }),
      );
      await ctx.repositories.events.insertMany(drafts);
    });

    it('returns newest first', async () => {
      const page = await ctx.repositories.events.timeline({ limit: 5, collapseDuplicates: false });
      expect(page.items).toHaveLength(5);
      const times = page.items.map((item) => item.event.occurredAt.getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
      expect(page.items[0]?.event.headline).toBe('Headline 0');
    });

    it('paginates without repeating or skipping rows', async () => {
      const seen: string[] = [];
      let cursor: string | null | undefined;

      for (let page = 0; page < 10; page++) {
        const result = await ctx.repositories.events.timeline({
          limit: 7,
          cursor,
          collapseDuplicates: false,
        });
        seen.push(...result.items.map((item) => item.event.id));
        cursor = result.nextCursor;
        if (!cursor) break;
      }

      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);
    });

    it('reports no cursor on the final page', async () => {
      const page = await ctx.repositories.events.timeline({
        limit: 100,
        collapseDuplicates: false,
      });
      expect(page.items).toHaveLength(25);
      expect(page.nextCursor).toBeNull();
    });

    it('starts from the top when handed a malformed cursor', async () => {
      const page = await ctx.repositories.events.timeline({
        limit: 3,
        cursor: 'not-a-real-cursor',
        collapseDuplicates: false,
      });
      expect(page.items[0]?.event.headline).toBe('Headline 0');
    });

    it('filters by coin', async () => {
      const page = await ctx.repositories.events.timeline({
        coinIds: [ethId],
        limit: 100,
        collapseDuplicates: false,
      });
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.every((item) => item.event.coinId === ethId)).toBe(true);
    });

    it('filters by category', async () => {
      const page = await ctx.repositories.events.timeline({
        categories: ['SECURITY'],
        limit: 100,
        collapseDuplicates: false,
      });
      expect(page.items.every((item) => item.event.category === 'SECURITY')).toBe(true);
      expect(page.items.length).toBe(9); // i % 3 === 0 for i in 0..24
    });

    it('filters by source key', async () => {
      const page = await ctx.repositories.events.timeline({
        sourceKeys: ['coindesk'],
        limit: 100,
        collapseDuplicates: false,
      });
      expect(page.items).toHaveLength(25);
      expect(
        await ctx.repositories.events.timeline({
          sourceKeys: ['theblock'],
          limit: 100,
          collapseDuplicates: false,
        }),
      ).toMatchObject({ items: [] });
    });

    it('filters by time range', async () => {
      const page = await ctx.repositories.events.timeline({
        from: new Date(Date.UTC(2026, 5, 1, 11, 55, 0)),
        limit: 100,
        collapseDuplicates: false,
      });
      // Events at 12:00 minus 0..4 minutes fall inside the window.
      expect(page.items).toHaveLength(6);
    });

    it('filters by free-text query across headline and body', async () => {
      await ctx.repositories.events.insertMany([
        draft({
          headline: 'A totally distinct occurrence',
          body: 'mentions zksync in the body',
          url: 'https://example.test/unique',
        }),
      ]);

      const byHeadline = await ctx.repositories.events.timeline({
        query: 'distinct occurrence',
        limit: 10,
        collapseDuplicates: false,
      });
      expect(byHeadline.items).toHaveLength(1);

      const byBody = await ctx.repositories.events.timeline({
        query: 'zksync',
        limit: 10,
        collapseDuplicates: false,
      });
      expect(byBody.items).toHaveLength(1);
    });

    it('joins source and coin display data', async () => {
      const page = await ctx.repositories.events.timeline({ limit: 1, collapseDuplicates: false });
      expect(page.items[0]?.source.key).toBe('coindesk');
      expect(page.items[0]?.source.credibility).toBeCloseTo(0.85);
      expect(page.items[0]?.coin?.symbol).toBeTruthy();
    });

    it('collapses a dedupe cluster to one row and counts the rest', async () => {
      const inserted = await ctx.repositories.events.insertMany([
        draft({ headline: 'Cluster story one', url: 'https://example.test/c1' }),
        draft({
          sourceKey: 'theblock',
          headline: 'Cluster story two',
          url: 'https://example.test/c2',
        }),
      ]);
      for (const result of inserted) {
        await ctx.repositories.events.setCluster(result.event.id, 'shared-cluster');
      }

      const collapsed = await ctx.repositories.events.timeline({
        limit: 100,
        collapseDuplicates: true,
      });
      const clustered = collapsed.items.filter((item) => item.event.clusterId === 'shared-cluster');
      expect(clustered).toHaveLength(1);
      expect(clustered[0]?.duplicateCount).toBe(1);

      const expanded = await ctx.repositories.events.timeline({
        limit: 100,
        collapseDuplicates: false,
      });
      expect(expanded.items.filter((i) => i.event.clusterId === 'shared-cluster')).toHaveLength(2);
    });
  });

  describe('enrichment', () => {
    it('lists unenriched events, most important first', async () => {
      await ctx.repositories.events.insertMany([
        draft({ headline: 'Low priority', url: 'https://example.test/low', importanceHint: 10 }),
        draft({ headline: 'High priority', url: 'https://example.test/high', importanceHint: 95 }),
      ]);

      const pending = await ctx.repositories.events.listPendingEnrichment(10);
      expect(pending).toHaveLength(2);
      expect(pending[0]?.headline).toBe('High priority');
    });

    it('writes an intelligence verdict and removes the event from the queue', async () => {
      const [inserted] = await ctx.repositories.events.insertMany([draft()]);
      const enrichedAt = new Date();

      await ctx.repositories.events.updateIntelligence(inserted!.event.id, {
        summary: 'A concise summary.',
        explanation: 'Why it matters.',
        sentiment: 'BULLISH',
        sentimentScore: 0.55,
        importance: 72,
        confidence: 68,
        impact: 'HIGH',
        narratives: ['etf-flows'],
        model: 'test-model',
        enrichedAt,
      });

      const reloaded = await ctx.repositories.events.findById(inserted!.event.id);
      expect(reloaded?.intelligence.summary).toBe('A concise summary.');
      expect(reloaded?.intelligence.sentiment).toBe('BULLISH');
      expect(reloaded?.intelligence.importance).toBe(72);
      expect(reloaded?.intelligence.narratives).toEqual(['etf-flows']);
      expect(await ctx.repositories.events.listPendingEnrichment(10)).toHaveLength(0);
    });

    it('ignores an empty intelligence patch', async () => {
      const [inserted] = await ctx.repositories.events.insertMany([draft()]);
      await expect(
        ctx.repositories.events.updateIntelligence(inserted!.event.id, {}),
      ).resolves.toBeUndefined();
    });
  });

  describe('aggregates', () => {
    it('buckets events into a histogram', async () => {
      const base = Date.UTC(2026, 5, 1, 0, 0, 0);
      await ctx.repositories.events.insertMany([
        draft({ occurredAt: new Date(base + 60_000), url: 'https://example.test/h1' }),
        draft({ occurredAt: new Date(base + 120_000), url: 'https://example.test/h2' }),
        // Two hours later, so a different bucket.
        draft({ occurredAt: new Date(base + 7_260_000), url: 'https://example.test/h3' }),
      ]);

      const histogram = await ctx.repositories.events.histogram({
        from: new Date(base),
        to: new Date(base + 10_800_000),
        bucketMinutes: 60,
      });

      expect(histogram.length).toBeGreaterThanOrEqual(2);
      expect(histogram[0]?.count).toBe(2);
      expect(histogram.reduce((sum, row) => sum + row.count, 0)).toBe(3);
    });

    it('reports mean sentiment per bucket', async () => {
      const base = Date.UTC(2026, 5, 2, 0, 0, 0);
      const inserted = await ctx.repositories.events.insertMany([
        draft({ occurredAt: new Date(base + 60_000), url: 'https://example.test/s1' }),
        draft({ occurredAt: new Date(base + 120_000), url: 'https://example.test/s2' }),
      ]);
      await ctx.repositories.events.updateIntelligence(inserted[0]!.event.id, {
        sentimentScore: 1,
      });
      await ctx.repositories.events.updateIntelligence(inserted[1]!.event.id, {
        sentimentScore: -1,
      });

      const histogram = await ctx.repositories.events.histogram({
        from: new Date(base),
        to: new Date(base + 3_600_000),
        bucketMinutes: 60,
      });
      expect(histogram[0]?.meanSentiment).toBeCloseTo(0);
    });

    it('returns key events collapsed by cluster', async () => {
      const inserted = await ctx.repositories.events.insertMany([
        draft({ headline: 'Major A', url: 'https://example.test/k1', importanceHint: 90 }),
        draft({
          sourceKey: 'theblock',
          headline: 'Major A restated',
          url: 'https://example.test/k2',
          importanceHint: 88,
        }),
        draft({ headline: 'Minor B', url: 'https://example.test/k3', importanceHint: 30 }),
      ]);
      await ctx.repositories.events.setCluster(inserted[0]!.event.id, 'cluster-major');
      await ctx.repositories.events.setCluster(inserted[1]!.event.id, 'cluster-major');

      const keyEvents = await ctx.repositories.events.listKeyEvents({
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2027-01-01T00:00:00Z'),
        limit: 10,
      });

      expect(keyEvents.filter((e) => e.event.clusterId === 'cluster-major')).toHaveLength(1);
      expect(keyEvents[0]?.event.headline).toBe('Major A');
    });

    it('respects a minimum importance for key events', async () => {
      await ctx.repositories.events.insertMany([
        draft({ headline: 'Trivial', url: 'https://example.test/m1', importanceHint: 5 }),
      ]);
      const keyEvents = await ctx.repositories.events.listKeyEvents({
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2027-01-01T00:00:00Z'),
        limit: 10,
        minImportance: 50,
      });
      expect(keyEvents).toHaveLength(0);
    });

    it('measures ingestion lag', async () => {
      // occurredAt in the recent past; ingestedAt defaults to now.
      await ctx.repositories.events.insertMany([
        draft({ occurredAt: new Date(Date.now() - 30_000), url: 'https://example.test/lag' }),
      ]);
      const lag = await ctx.repositories.events.ingestionLag(new Date(Date.now() - 3_600_000));
      expect(lag).not.toBeNull();
      expect(lag!.p50Ms).toBeGreaterThan(0);
      expect(lag!.maxMs).toBeGreaterThanOrEqual(lag!.p50Ms);
    });

    it('returns null lag when there is nothing to measure', async () => {
      expect(await ctx.repositories.events.ingestionLag(new Date())).toBeNull();
    });
  });
});
