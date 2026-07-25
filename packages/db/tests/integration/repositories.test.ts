import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { alertRuleSchema } from '@cid/core';
import {
  createTestContext,
  hasDatabase,
  makeVector,
  resetDatabase,
  seedCoin,
  seedSources,
  seedUser,
  type TestContext,
} from './setup.js';

/**
 * Market, content, alert, search and analytics repositories against real
 * Postgres. These cover the raw SQL that a unit test cannot reach: `DISTINCT ON`,
 * `date_bin` bucketing, `LATERAL` joins, the conditional alert claim, and HNSW
 * vector search.
 */
describe.skipIf(!hasDatabase)('repositories (integration)', () => {
  let ctx: TestContext;
  let coinId: string;
  let ethId: string;
  let userId: string;

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
    userId = await seedUser(ctx.db);
  });

  // ─── Sources ───────────────────────────────────────────────────────────────

  describe('sources', () => {
    it('registers a source idempotently', async () => {
      const first = await ctx.repositories.sources.ensure({
        key: 'newsource',
        name: 'New Source',
        kind: 'NEWS',
        credibility: 0.6,
      });
      const second = await ctx.repositories.sources.ensure({
        key: 'newsource',
        name: 'New Source Renamed',
        kind: 'NEWS',
        credibility: 0.7,
      });
      expect(second.id).toBe(first.id);
      expect(second.name).toBe('New Source Renamed');
      expect(second.credibility).toBeCloseTo(0.7);
    });

    it('does not revert a human disable on re-registration', async () => {
      await ctx.repositories.sources.ensure({ key: 'x', name: 'X', kind: 'SOCIAL' });
      await ctx.repositories.sources.setEnabled('x', false);
      const after = await ctx.repositories.sources.ensure({ key: 'x', name: 'X', kind: 'SOCIAL' });
      expect(after.isEnabled).toBe(false);
    });

    it('throws for an unregistered key rather than writing orphan rows', async () => {
      await expect(ctx.repositories.sources.requireId('nope')).rejects.toThrow(
        /Unknown source key/,
      );
    });
  });

  // ─── Coins ─────────────────────────────────────────────────────────────────

  describe('coins', () => {
    it('upserts by slug and preserves identifiers additively', async () => {
      await ctx.repositories.coins.upsert({
        slug: 'cronos',
        symbol: 'CRO',
        name: 'Cronos',
        identifiers: [{ kind: 'SYMBOL', value: 'CRO', chain: null }],
        contracts: [{ chain: 'ethereum', address: '0xABC', decimals: 8, isNative: false }],
      });
      const updated = await ctx.repositories.coins.upsert({
        slug: 'cronos',
        symbol: 'CRO',
        name: 'Cronos Chain',
        identifiers: [{ kind: 'COINGECKO', value: 'crypto-com-chain', chain: null }],
      });

      expect(updated.name).toBe('Cronos Chain');
      // The earlier identifier and contract must survive the second upsert.
      expect(updated.identifiers.map((i) => i.kind).sort()).toEqual(['COINGECKO', 'SYMBOL']);
      expect(updated.contracts).toHaveLength(1);
      // Addresses are normalised to lowercase for case-insensitive lookup.
      expect(updated.contracts[0]?.address).toBe('0xabc');
    });

    it('resolves identifier candidates in priority order', async () => {
      const found = await ctx.repositories.coins.findByIdentifiers([
        { kind: 'COINGECKO', value: 'does-not-exist', chain: null },
        { kind: 'SYMBOL', value: 'ETH', chain: null },
      ]);
      expect(found?.id).toBe(ethId);
    });

    it('prefers the highest-ranked asset for a colliding symbol', async () => {
      await ctx.repositories.coins.upsert({
        slug: 'ethereum-classic-imposter',
        symbol: 'ETH',
        name: 'Not Real Ethereum',
        marketCapRank: 4000,
      });
      const found = await ctx.repositories.coins.findByIdentifiers([
        { kind: 'SYMBOL', value: 'ETH', chain: null },
      ]);
      expect(found?.id).toBe(ethId);
    });

    it('resolves a contract address case-insensitively', async () => {
      await ctx.repositories.coins.upsert({
        slug: 'linkcoin',
        symbol: 'LINK',
        name: 'Chainlink',
        contracts: [
          {
            chain: 'ethereum',
            address: '0x514910771af9ca656af840dff83e8264ecf986ca',
            decimals: 18,
            isNative: false,
          },
        ],
      });
      const found = await ctx.repositories.coins.findByIdentifiers([
        {
          kind: 'CONTRACT',
          value: '0x514910771AF9CA656AF840DFF83E8264ECF986CA',
          chain: 'ethereum',
        },
      ]);
      expect(found?.symbol).toBe('LINK');
    });

    it('ranks search results: exact symbol above fuzzy name', async () => {
      const results = await ctx.repositories.coins.search('ETH');
      expect(results[0]?.coin.id).toBe(ethId);
      expect(results[0]?.score).toBeGreaterThan(0.9);
    });

    it('finds a coin by partial name', async () => {
      const results = await ctx.repositories.coins.search('bitco');
      expect(results.some((r) => r.coin.symbol === 'BTC')).toBe(true);
    });

    it('tolerates a typo via trigram similarity', async () => {
      const results = await ctx.repositories.coins.search('etherium');
      expect(results.some((r) => r.coin.id === ethId)).toBe(true);
    });

    it('returns nothing for an empty query', async () => {
      expect(await ctx.repositories.coins.search('   ')).toEqual([]);
    });

    it('orders tracked coins pinned-first, then watchlisted, then by rank', async () => {
      const lowRank = await ctx.repositories.coins.upsert({
        slug: 'tail-asset',
        symbol: 'TAIL',
        name: 'Tail Asset',
        marketCapRank: 900,
      });
      const watchlist = await ctx.repositories.watchlists.getDefault(userId);
      // Pin the low-ranked coin; it must still come first.
      await ctx.repositories.watchlists.addCoin(watchlist.id, lowRank.id);
      await ctx.repositories.watchlists.setPinned(watchlist.id, lowRank.id, true);
      await ctx.repositories.watchlists.addCoin(watchlist.id, ethId);

      const tracked = await ctx.repositories.coins.listTracked(10);
      expect(tracked[0]?.id).toBe(lowRank.id);
      expect(tracked[1]?.id).toBe(ethId);
      // BTC is rank 1 but unwatched, so it sorts after the watchlisted coins.
      expect(tracked[2]?.id).toBe(coinId);
    });
  });

  // ─── Market ────────────────────────────────────────────────────────────────

  describe('market', () => {
    const insertSnapshots = async (
      entries: Array<{ coinId: string; at: Date; price: number; volume?: number }>,
    ) =>
      ctx.repositories.market.insertSnapshots(
        entries.map((entry) => ({
          sourceKey: 'coingecko',
          coinId: entry.coinId,
          observedAt: entry.at,
          priceUsd: entry.price,
          marketCapUsd: entry.price * 1_000_000,
          fdvUsd: null,
          volume24hUsd: entry.volume ?? 1_000_000,
          circulatingSupply: 1_000_000,
          totalSupply: null,
          maxSupply: null,
          liquidityUsd: null,
          priceChange1hPct: null,
          priceChange24hPct: null,
          priceChange7dPct: null,
          priceChange30dPct: null,
          marketCapRank: 1,
          athUsd: null,
          atlUsd: null,
        })),
      );

    it('appends snapshots rather than overwriting', async () => {
      const at = new Date('2026-06-01T12:00:00Z');
      await insertSnapshots([
        { coinId, at, price: 100 },
        { coinId, at: new Date(at.getTime() + 10_000), price: 101 },
      ]);
      expect(await ctx.db.marketSnapshot.count({ where: { coinId } })).toBe(2);
    });

    it('returns the latest quote', async () => {
      const at = new Date('2026-06-01T12:00:00Z');
      await insertSnapshots([
        { coinId, at, price: 100 },
        { coinId, at: new Date(at.getTime() + 10_000), price: 123.45 },
      ]);
      const quote = await ctx.repositories.market.latestQuote(coinId);
      expect(quote?.priceUsd).toBeCloseTo(123.45);
    });

    it('returns the latest quote per coin in one query', async () => {
      const at = new Date('2026-06-01T12:00:00Z');
      await insertSnapshots([
        { coinId, at, price: 100 },
        { coinId, at: new Date(at.getTime() + 1_000), price: 110 },
        { coinId: ethId, at, price: 3_000 },
        { coinId: ethId, at: new Date(at.getTime() + 1_000), price: 3_100 },
      ]);

      const quotes = await ctx.repositories.market.latestQuotes([coinId, ethId]);
      expect(quotes.get(coinId)?.priceUsd).toBeCloseTo(110);
      expect(quotes.get(ethId)?.priceUsd).toBeCloseTo(3_100);
    });

    it('returns an empty map for no coins', async () => {
      expect((await ctx.repositories.market.latestQuotes([])).size).toBe(0);
    });

    it('finds the quote at or before a timestamp', async () => {
      const base = new Date('2026-06-01T12:00:00Z');
      await insertSnapshots([
        { coinId, at: base, price: 100 },
        { coinId, at: new Date(base.getTime() + 600_000), price: 200 },
      ]);

      const earlier = await ctx.repositories.market.quoteAt(
        coinId,
        new Date(base.getTime() + 300_000),
      );
      expect(earlier?.priceUsd).toBeCloseTo(100);
      expect(
        await ctx.repositories.market.quoteAt(coinId, new Date(base.getTime() - 1)),
      ).toBeNull();
    });

    it('downsamples history to at most maxPoints', async () => {
      const base = new Date('2026-06-01T00:00:00Z');
      // 500 snapshots at 1-minute spacing.
      await insertSnapshots(
        Array.from({ length: 500 }, (_, i) => ({
          coinId,
          at: new Date(base.getTime() + i * 60_000),
          price: 100 + i,
        })),
      );

      const history = await ctx.repositories.market.history({
        coinId,
        from: base,
        to: new Date(base.getTime() + 500 * 60_000),
        maxPoints: 50,
      });

      expect(history.length).toBeLessThanOrEqual(51);
      expect(history.length).toBeGreaterThan(1);
      // Ascending, and the final bucket carries the latest price.
      const times = history.map((row) => row.observedAt.getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(history[history.length - 1]?.priceUsd).toBeCloseTo(599);
    });

    it('computes a volume baseline from one observation per day', async () => {
      const now = Date.now();
      await insertSnapshots([
        { coinId, at: new Date(now - 3 * 86_400_000), price: 100, volume: 1_000_000 },
        { coinId, at: new Date(now - 2 * 86_400_000), price: 100, volume: 2_000_000 },
        { coinId, at: new Date(now - 1 * 86_400_000), price: 100, volume: 3_000_000 },
      ]);
      const baseline = await ctx.repositories.market.baselineVolume(coinId, 7);
      expect(baseline).toBeCloseTo(2_000_000, -3);
    });

    it('returns a null baseline with no data', async () => {
      expect(await ctx.repositories.market.baselineVolume(coinId, 7)).toBeNull();
    });

    it('prunes old snapshots', async () => {
      const now = Date.now();
      await insertSnapshots([
        { coinId, at: new Date(now - 100 * 86_400_000), price: 100 },
        { coinId, at: new Date(now), price: 100 },
      ]);
      const removed = await ctx.repositories.market.pruneSnapshots(new Date(now - 90 * 86_400_000));
      expect(removed).toBe(1);
      expect(await ctx.db.marketSnapshot.count()).toBe(1);
    });

    it('upserts candles, treating the open bucket as mutable', async () => {
      const openTime = new Date('2026-06-01T12:00:00Z');
      const candle = {
        sourceKey: 'binance',
        coinId,
        interval: '1h' as const,
        openTime,
        open: 100,
        high: 105,
        low: 99,
        close: 103,
        volume: 1_000,
        quoteVolume: null,
        trades: null,
      };
      await ctx.repositories.market.insertCandles([candle]);
      await ctx.repositories.market.insertCandles([{ ...candle, close: 107, high: 108 }]);

      const candles = await ctx.repositories.market.candles({
        coinId,
        interval: '1h',
        from: new Date(openTime.getTime() - 1),
        to: new Date(openTime.getTime() + 1),
      });
      expect(candles).toHaveLength(1);
      expect(candles[0]?.close).toBeCloseTo(107);
      // The domain sees '1h', not the Prisma enum name.
      expect(candles[0]?.interval).toBe('1h');
    });

    it('detects new trading pairs as listings', async () => {
      const pair = {
        sourceKey: 'binance',
        coinId,
        venue: 'binance',
        venueKind: 'CEX' as const,
        base: 'BTC',
        quote: 'USDT',
        symbol: 'BTCUSDT',
        volume24hUsd: 1_000_000,
        spread: null,
        isActive: true,
      };

      const first = await ctx.repositories.market.recordTradingPairs([pair]);
      expect(first.created).toHaveLength(1);
      expect(first.updated).toBe(0);

      const second = await ctx.repositories.market.recordTradingPairs([pair]);
      expect(second.created).toHaveLength(0);
      expect(second.updated).toBe(1);
    });

    it('buckets liquidation totals by side', async () => {
      const base = new Date('2026-06-01T00:00:00Z');
      await ctx.repositories.market.insertLiquidations([
        {
          sourceKey: 'binance',
          coinId,
          occurredAt: new Date(base.getTime() + 60_000),
          instrument: 'BTCUSDT',
          side: 'LONG',
          quantity: 1,
          price: 100,
          valueUsd: 500_000,
        },
        {
          sourceKey: 'binance',
          coinId,
          occurredAt: new Date(base.getTime() + 120_000),
          instrument: 'BTCUSDT',
          side: 'SHORT',
          quantity: 1,
          price: 100,
          valueUsd: 200_000,
        },
      ]);

      const totals = await ctx.repositories.market.liquidationTotals({
        coinId,
        from: base,
        to: new Date(base.getTime() + 3_600_000),
        bucketMinutes: 60,
      });
      expect(totals[0]?.longUsd).toBeCloseTo(500_000);
      expect(totals[0]?.shortUsd).toBeCloseTo(200_000);
    });

    it('lists whale trades above a threshold, largest first', async () => {
      const at = new Date('2026-06-01T12:00:00Z');
      await ctx.repositories.market.insertTrades([
        {
          sourceKey: 'binance',
          coinId,
          occurredAt: at,
          venue: 'binance',
          venueKind: 'CEX',
          pair: 'BTCUSDT',
          side: 'BUY',
          price: 100,
          quantity: 10,
          valueUsd: 5_000_000,
          txHash: null,
          trader: null,
          chain: null,
          isWhale: true,
        },
        {
          sourceKey: 'binance',
          coinId,
          occurredAt: at,
          venue: 'binance',
          venueKind: 'CEX',
          pair: 'BTCUSDT',
          side: 'SELL',
          price: 100,
          quantity: 1,
          valueUsd: 50_000,
          txHash: null,
          trader: null,
          chain: null,
          isWhale: false,
        },
      ]);

      const whales = await ctx.repositories.market.listWhaleTrades({
        coinId,
        minUsd: 1_000_000,
        from: new Date(at.getTime() - 1000),
        to: new Date(at.getTime() + 1000),
        limit: 10,
      });
      expect(whales).toHaveLength(1);
      expect(whales[0]?.valueUsd).toBeCloseTo(5_000_000);
    });
  });

  // ─── Content ───────────────────────────────────────────────────────────────

  describe('content', () => {
    const insertEvent = async (headline = 'An event'): Promise<string> => {
      const [result] = await ctx.repositories.events.insertMany([
        {
          occurredAt: new Date('2026-06-01T12:00:00Z'),
          sourceKey: 'etherscan',
          coinId,
          category: 'ONCHAIN',
          headline,
          url: `https://example.test/${encodeURIComponent(headline)}`,
        },
      ]);
      return result!.event.id;
    };

    it('never downgrades a known wallet label to UNKNOWN', async () => {
      await ctx.repositories.content.upsertWallet({
        chain: 'ethereum',
        address: '0xAAA',
        label: 'EXCHANGE',
        entityName: 'Binance 14',
        coinIds: [],
      });
      const after = await ctx.repositories.content.upsertWallet({
        chain: 'ethereum',
        address: '0xaaa',
        label: 'UNKNOWN',
        entityName: null,
        coinIds: [],
      });
      expect(after.label).toBe('EXCHANGE');
      expect(after.entityName).toBe('Binance 14');
    });

    it('aggregates whale flows using wallet labels for direction', async () => {
      const base = new Date('2026-06-01T00:00:00Z');
      const eventId = await insertEvent('whale flows');

      await ctx.repositories.content.insertOnchainEvents([
        {
          sourceKey: 'etherscan',
          eventId,
          coinId,
          type: 'WHALE_TRANSFER',
          occurredAt: new Date(base.getTime() + 60_000),
          chain: 'ethereum',
          txHash: '0x1',
          blockNumber: 100,
          fromAddress: '0xa',
          toAddress: '0xb',
          fromLabel: null,
          // Labelled destination makes this an inflow even though the type is generic.
          toLabel: 'EXCHANGE',
          amount: 10,
          amountUsd: 2_000_000,
          metadata: {},
        },
      ]);

      const flows = await ctx.repositories.content.whaleFlows({
        coinId,
        from: base,
        to: new Date(base.getTime() + 3_600_000),
        bucketMinutes: 60,
        minUsd: 1_000_000,
      });
      expect(flows[0]?.inflowUsd).toBeCloseTo(2_000_000);
      expect(flows[0]?.outflowUsd).toBe(0);
    });

    it('narrows a BigInt block number to a JSON-safe number', async () => {
      const eventId = await insertEvent('block number');
      await ctx.repositories.content.insertOnchainEvents([
        {
          sourceKey: 'etherscan',
          eventId,
          coinId,
          type: 'BURN',
          occurredAt: new Date('2026-06-01T12:00:00Z'),
          chain: 'ethereum',
          txHash: '0x2',
          blockNumber: 21_000_000,
          fromAddress: null,
          toAddress: null,
          fromLabel: null,
          toLabel: null,
          amount: 1,
          amountUsd: 100,
          metadata: { note: 'test' },
        },
      ]);

      const events = await ctx.repositories.content.listOnchainEvents({
        coinId,
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2027-01-01T00:00:00Z'),
        limit: 10,
      });
      expect(events[0]?.blockNumber).toBe(21_000_000);
      expect(typeof events[0]?.blockNumber).toBe('number');
      expect(events[0]?.metadata).toEqual({ note: 'test' });
    });

    it('reports governance state transitions', async () => {
      const eventId = await insertEvent('proposal');
      const proposal = {
        sourceKey: 'snapshot',
        eventId,
        coinId,
        space: 'test.eth',
        externalId: 'proposal-1',
        title: 'Fund the thing',
        body: null,
        author: null,
        state: 'PENDING' as const,
        createdAt: new Date('2026-06-01T00:00:00Z'),
        startsAt: null,
        endsAt: null,
        url: null,
        choices: ['For', 'Against'],
        scores: [0, 0],
        totalVotes: 0,
        quorum: null,
      };

      const first = await ctx.repositories.content.upsertProposals([proposal]);
      expect(first.created).toHaveLength(1);
      expect(first.stateChanged).toHaveLength(0);

      const unchanged = await ctx.repositories.content.upsertProposals([proposal]);
      expect(unchanged.created).toHaveLength(0);
      expect(unchanged.stateChanged).toHaveLength(0);

      const changed = await ctx.repositories.content.upsertProposals([
        { ...proposal, state: 'ACTIVE' },
      ]);
      expect(changed.stateChanged).toHaveLength(1);
      expect(changed.stateChanged[0]?.state).toBe('ACTIVE');
    });

    it('excludes the current window from a mention baseline', async () => {
      const base = new Date('2026-06-01T00:00:00Z');
      await ctx.repositories.content.insertSocialMetrics([
        {
          coinId,
          platform: 'X',
          observedAt: new Date(base.getTime() + 0),
          windowMinutes: 60,
          mentions: 10,
          uniqueAuthors: 8,
          totalEngagement: 100,
          sentimentScore: 0,
          velocity: null,
          trendingScore: null,
          topHashtags: [],
        },
        {
          coinId,
          platform: 'X',
          observedAt: new Date(base.getTime() + 3_600_000),
          windowMinutes: 60,
          mentions: 12,
          uniqueAuthors: 9,
          totalEngagement: 120,
          sentimentScore: 0,
          velocity: null,
          trendingScore: null,
          topHashtags: [],
        },
        // The spike: must NOT be part of its own baseline.
        {
          coinId,
          platform: 'X',
          observedAt: new Date(base.getTime() + 7_200_000),
          windowMinutes: 60,
          mentions: 500,
          uniqueAuthors: 300,
          totalEngagement: 9_000,
          sentimentScore: 0.5,
          velocity: null,
          trendingScore: null,
          topHashtags: [],
        },
      ]);

      const baseline = await ctx.repositories.content.mentionBaseline({
        coinId,
        platform: 'X',
        windowMinutes: 60,
        periods: 5,
      });
      expect(baseline).toEqual([12, 10]);
      expect(baseline).not.toContain(500);
    });

    it('upserts an unlock schedule revision in place', async () => {
      const unlockAt = new Date('2026-09-01T00:00:00Z');
      const unlock = {
        sourceKey: 'coingecko',
        coinId,
        unlockAt,
        amount: 1_000_000,
        amountUsd: 5_000_000,
        pctOfCirculating: 0.02,
        category: 'investors',
        isCliff: true,
        notes: null,
      };
      await ctx.repositories.content.upsertUnlocks([unlock]);
      await ctx.repositories.content.upsertUnlocks([{ ...unlock, amount: 1_500_000 }]);

      const upcoming = await ctx.repositories.content.listUpcomingUnlocks({
        before: new Date('2027-01-01T00:00:00Z'),
      });
      expect(upcoming).toHaveLength(1);
      expect(upcoming[0]?.amount).toBeCloseTo(1_500_000);
    });
  });

  // ─── Alerts ────────────────────────────────────────────────────────────────

  describe('alerts', () => {
    const createAlert = async (cooldownSeconds = 300) =>
      ctx.repositories.alerts.create({
        userId,
        name: 'Test alert',
        rule: alertRuleSchema.parse({ type: 'BREAKING_NEWS', minImportance: 70 }),
        channels: ['DESKTOP'],
        isEnabled: true,
        cooldownSeconds,
      });

    it('round-trips a validated rule', async () => {
      const alert = await createAlert();
      const reloaded = await ctx.repositories.alerts.findById(alert.id);
      expect(reloaded?.rule.type).toBe('BREAKING_NEWS');
    });

    it('skips an alert whose stored rule no longer validates', async () => {
      const alert = await createAlert();
      // Simulate a rule written by a different version of the app.
      await ctx.db.alert.update({
        where: { id: alert.id },
        data: { rule: { type: 'NOT_A_REAL_RULE' } },
      });

      // The loop must not crash; the bad rule is simply not returned.
      expect(await ctx.repositories.alerts.listEnabled()).toHaveLength(0);
      expect(await ctx.repositories.alerts.findById(alert.id)).toBeNull();
    });

    it('claims a trigger and enforces the cooldown atomically', async () => {
      const alert = await createAlert(300);
      const now = new Date();

      const first = await ctx.repositories.alerts.recordTrigger(alert.id, {
        eventId: null,
        coinId,
        triggeredAt: now,
        title: 'Fired',
        message: 'Something happened',
        observedValue: 80,
        payload: {},
      });
      expect(first).not.toBeNull();

      // Inside the cooldown: the claim must fail.
      const second = await ctx.repositories.alerts.recordTrigger(alert.id, {
        eventId: null,
        coinId,
        triggeredAt: new Date(now.getTime() + 1_000),
        title: 'Fired again',
        message: 'Too soon',
        observedValue: 81,
        payload: {},
      });
      expect(second).toBeNull();

      // After the cooldown: allowed again.
      const third = await ctx.repositories.alerts.recordTrigger(alert.id, {
        eventId: null,
        coinId,
        triggeredAt: new Date(now.getTime() + 301_000),
        title: 'Fired later',
        message: 'Fine now',
        observedValue: 82,
        payload: {},
      });
      expect(third).not.toBeNull();
      expect(await ctx.db.alertTrigger.count()).toBe(2);
    });

    it('lets exactly one of many concurrent claims win', async () => {
      // The guard that makes running several worker replicas safe.
      const alert = await createAlert(300);
      const now = new Date();

      const attempts = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          ctx.repositories.alerts.recordTrigger(alert.id, {
            eventId: null,
            coinId,
            triggeredAt: now,
            title: `Attempt ${i}`,
            message: 'concurrent',
            observedValue: i,
            payload: {},
          }),
        ),
      );

      expect(attempts.filter((result) => result !== null)).toHaveLength(1);
      expect(await ctx.db.alertTrigger.count()).toBe(1);
    });

    it('never claims a disabled alert', async () => {
      const alert = await createAlert();
      await ctx.repositories.alerts.update(alert.id, { isEnabled: false });
      const result = await ctx.repositories.alerts.recordTrigger(alert.id, {
        eventId: null,
        coinId,
        triggeredAt: new Date(),
        title: 'x',
        message: 'y',
        observedValue: null,
        payload: {},
      });
      expect(result).toBeNull();
    });

    it('bumps the trigger count', async () => {
      const alert = await createAlert(0);
      for (let i = 0; i < 3; i++) {
        await ctx.repositories.alerts.recordTrigger(alert.id, {
          eventId: null,
          coinId,
          triggeredAt: new Date(Date.now() + i),
          title: 'x',
          message: 'y',
          observedValue: null,
          payload: {},
        });
      }
      const reloaded = await ctx.db.alert.findUnique({ where: { id: alert.id } });
      expect(reloaded?.triggerCount).toBe(3);
    });

    it('tracks notification deliveries', async () => {
      const alert = await createAlert(0);
      const trigger = await ctx.repositories.alerts.recordTrigger(alert.id, {
        eventId: null,
        coinId,
        triggeredAt: new Date(),
        title: 'x',
        message: 'y',
        observedValue: null,
        payload: {},
      });

      await ctx.repositories.alerts.recordDelivery({
        triggerId: trigger!.id,
        channel: 'DISCORD',
        status: 'PENDING',
        attempts: 0,
        error: null,
        sentAt: null,
      });

      const pending = await ctx.repositories.alerts.listPendingDeliveries(10);
      expect(pending).toHaveLength(1);

      await ctx.repositories.alerts.updateDelivery(pending[0]!.id, {
        status: 'SENT',
        sentAt: new Date(),
      });
      expect(await ctx.repositories.alerts.listPendingDeliveries(10)).toHaveLength(0);
    });
  });

  // ─── Search (pgvector + full text) ─────────────────────────────────────────

  describe('search', () => {
    const insertEvent = async (headline: string, body?: string): Promise<string> => {
      const [result] = await ctx.repositories.events.insertMany([
        {
          occurredAt: new Date(),
          sourceKey: 'coindesk',
          coinId,
          category: 'NEWS',
          headline,
          body: body ?? null,
          url: `https://example.test/${encodeURIComponent(headline)}`,
        },
      ]);
      return result!.event.id;
    };

    it('stores an embedding and finds it as its own nearest neighbour', async () => {
      const eventId = await insertEvent('Bitcoin ETF inflows hit a record');
      const vector = makeVector(42);
      await ctx.repositories.search.upsertEmbedding(eventId, vector);

      const hits = await ctx.repositories.search.semanticSearch({ vector, limit: 5 });
      expect(hits[0]?.eventId).toBe(eventId);
      expect(hits[0]?.similarity).toBeCloseTo(1, 4);
    });

    it('ranks a closer vector above a distant one', async () => {
      const near = await insertEvent('Near neighbour event');
      const far = await insertEvent('Far neighbour event');
      const query = makeVector(7);
      // Perturb slightly for the near vector, use an unrelated seed for the far one.
      const nearVector = query.map((value, i) => (i % 50 === 0 ? value * 0.98 : value));
      await ctx.repositories.search.upsertEmbedding(near, nearVector);
      await ctx.repositories.search.upsertEmbedding(far, makeVector(9999));

      const hits = await ctx.repositories.search.semanticSearch({ vector: query, limit: 5 });
      expect(hits[0]?.eventId).toBe(near);
      expect(hits[0]!.similarity).toBeGreaterThan(hits[1]!.similarity);
    });

    it('replaces an existing embedding rather than duplicating it', async () => {
      const eventId = await insertEvent('Re-embedded event');
      await ctx.repositories.search.upsertEmbedding(eventId, makeVector(1));
      await ctx.repositories.search.upsertEmbedding(eventId, makeVector(2));
      expect(await ctx.db.eventEmbedding.count()).toBe(1);
    });

    it('rejects a wrong-sized vector with an actionable message', async () => {
      const eventId = await insertEvent('Bad vector');
      await expect(ctx.repositories.search.upsertEmbedding(eventId, [1, 2, 3])).rejects.toThrow(
        /dimension mismatch/i,
      );
    });

    it('rejects a non-finite vector value', async () => {
      const eventId = await insertEvent('NaN vector');
      const bad = makeVector(1);
      bad[0] = Number.NaN;
      await expect(ctx.repositories.search.upsertEmbedding(eventId, bad)).rejects.toThrow(
        /non-finite/,
      );
    });

    it('filters semantic results by coin and time', async () => {
      const eventId = await insertEvent('Scoped event');
      const vector = makeVector(11);
      await ctx.repositories.search.upsertEmbedding(eventId, vector);

      expect(
        await ctx.repositories.search.semanticSearch({ vector, limit: 5, coinIds: [ethId] }),
      ).toHaveLength(0);
      expect(
        await ctx.repositories.search.semanticSearch({
          vector,
          limit: 5,
          from: new Date(Date.now() + 86_400_000),
        }),
      ).toHaveLength(0);
    });

    it('lists events missing an embedding, most important first', async () => {
      const low = await insertEvent('Low importance unembedded');
      const high = await insertEvent('High importance unembedded');
      await ctx.repositories.events.updateIntelligence(low, { importance: 10 });
      await ctx.repositories.events.updateIntelligence(high, { importance: 95 });

      const missing = await ctx.repositories.search.listMissingEmbeddings(10);
      expect(missing[0]?.id).toBe(high);

      await ctx.repositories.search.upsertEmbedding(high, makeVector(3));
      const after = await ctx.repositories.search.listMissingEmbeddings(10);
      expect(after.map((row) => row.id)).not.toContain(high);
    });

    it('finds events by keyword using full-text search', async () => {
      await insertEvent('Solana network halts block production after an outage');
      await insertEvent('Bitcoin ETF inflows reach a record high');

      const hits = await ctx.repositories.search.keywordSearch({
        query: 'solana outage',
        limit: 5,
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.similarity).toBeGreaterThan(0);
    });

    it('matches stemmed forms and searches the body', async () => {
      await insertEvent('Exchange halted withdrawals', 'The venue is halting all transfers today');
      const hits = await ctx.repositories.search.keywordSearch({ query: 'halt', limit: 5 });
      expect(hits.length).toBeGreaterThan(0);
    });

    it('supports quoted phrases and exclusions', async () => {
      await insertEvent('Ethereum upgrade delayed again');
      await insertEvent('Solana upgrade shipped on time');

      const excluded = await ctx.repositories.search.keywordSearch({
        query: 'upgrade -solana',
        limit: 5,
      });
      expect(excluded).toHaveLength(1);
    });

    it('returns nothing for an empty keyword query', async () => {
      expect(await ctx.repositories.search.keywordSearch({ query: '  ', limit: 5 })).toEqual([]);
    });

    it('blends semantic and keyword hits in a hybrid search', async () => {
      const lexical = await insertEvent('CRO listed on Binance spot markets');
      const semantic = await insertEvent('An unrelated headline about oracles');
      const vector = makeVector(21);
      await ctx.repositories.search.upsertEmbedding(semantic, vector);

      const hits = await ctx.repositories.search.hybridSearch({
        query: 'CRO Binance',
        vector,
        limit: 10,
      });

      const ids = hits.map((hit) => hit.eventId);
      // Both paths contribute: the lexical match and the vector match.
      expect(ids).toContain(lexical);
      expect(ids).toContain(semantic);
    });

    it('falls back to keyword-only when no vector is supplied', async () => {
      const eventId = await insertEvent('Keyword only fallback path');
      const hits = await ctx.repositories.search.hybridSearch({
        query: 'fallback path',
        vector: null,
        limit: 5,
      });
      expect(hits.map((hit) => hit.eventId)).toContain(eventId);
    });

    it('reports embedding coverage', async () => {
      const a = await insertEvent('Coverage A');
      await insertEvent('Coverage B');
      await ctx.repositories.search.upsertEmbedding(a, makeVector(5));

      const coverage = await ctx.repositories.search.embeddingCoverage();
      expect(coverage.total).toBe(2);
      expect(coverage.embedded).toBe(1);
    });
  });

  // ─── Analytics & telemetry ─────────────────────────────────────────────────

  describe('analytics', () => {
    it('ranks coins by weighted sentiment in both directions', async () => {
      const drafts = [];
      // BTC: three bullish events. ETH: three bearish.
      for (let i = 0; i < 3; i++) {
        drafts.push({
          occurredAt: new Date(Date.now() - i * 60_000),
          sourceKey: 'coindesk' as const,
          coinId,
          category: 'NEWS' as const,
          headline: `Bullish btc ${i}`,
          url: `https://example.test/b${i}`,
        });
        drafts.push({
          occurredAt: new Date(Date.now() - i * 60_000),
          sourceKey: 'coindesk' as const,
          coinId: ethId,
          category: 'NEWS' as const,
          headline: `Bearish eth ${i}`,
          url: `https://example.test/e${i}`,
        });
      }
      const inserted = await ctx.repositories.events.insertMany(drafts);
      for (const result of inserted) {
        const bullish = result.event.coinId === coinId;
        await ctx.repositories.events.updateIntelligence(result.event.id, {
          sentimentScore: bullish ? 0.8 : -0.8,
          importance: 70,
        });
      }

      const from = new Date(Date.now() - 3_600_000);
      const to = new Date(Date.now() + 60_000);

      const bullish = await ctx.repositories.analytics.rankBySentiment({
        from,
        to,
        direction: 'bullish',
        limit: 5,
      });
      expect(bullish[0]?.coinId).toBe(coinId);
      expect(bullish[0]?.score).toBeGreaterThan(0);

      const bearish = await ctx.repositories.analytics.rankBySentiment({
        from,
        to,
        direction: 'bearish',
        limit: 5,
      });
      expect(bearish[0]?.coinId).toBe(ethId);
      expect(bearish[0]?.score).toBeLessThan(0);
    });

    it('requires a minimum event count to rank, so one post cannot top the chart', async () => {
      const [result] = await ctx.repositories.events.insertMany([
        {
          occurredAt: new Date(),
          sourceKey: 'coindesk',
          coinId,
          category: 'NEWS',
          headline: 'A single wildly bullish post',
          url: 'https://example.test/single',
        },
      ]);
      await ctx.repositories.events.updateIntelligence(result!.event.id, {
        sentimentScore: 1,
        importance: 100,
      });

      const ranked = await ctx.repositories.analytics.rankBySentiment({
        from: new Date(Date.now() - 3_600_000),
        to: new Date(Date.now() + 60_000),
        direction: 'bullish',
        limit: 5,
      });
      expect(ranked).toHaveLength(0);
    });

    it('ranks price movers over exactly the requested window', async () => {
      const from = new Date(Date.now() - 3_600_000);
      const to = new Date();
      await ctx.repositories.market.insertSnapshots([
        {
          sourceKey: 'coingecko',
          coinId,
          observedAt: from,
          priceUsd: 100,
          marketCapUsd: null,
          fdvUsd: null,
          volume24hUsd: null,
          circulatingSupply: null,
          totalSupply: null,
          maxSupply: null,
          liquidityUsd: null,
          priceChange1hPct: null,
          priceChange24hPct: null,
          priceChange7dPct: null,
          priceChange30dPct: null,
          marketCapRank: null,
          athUsd: null,
          atlUsd: null,
        },
        {
          sourceKey: 'coingecko',
          coinId,
          observedAt: to,
          priceUsd: 150,
          marketCapUsd: null,
          fdvUsd: null,
          volume24hUsd: null,
          circulatingSupply: null,
          totalSupply: null,
          maxSupply: null,
          liquidityUsd: null,
          priceChange1hPct: null,
          priceChange24hPct: null,
          priceChange7dPct: null,
          priceChange30dPct: null,
          marketCapRank: null,
          athUsd: null,
          atlUsd: null,
        },
      ]);

      const movers = await ctx.repositories.analytics.rankByPriceMove({ from, to, limit: 5 });
      expect(movers[0]?.coinId).toBe(coinId);
      expect(movers[0]?.score).toBeCloseTo(50, 1);
    });

    it('aggregates top narratives', async () => {
      const inserted = await ctx.repositories.events.insertMany([
        {
          occurredAt: new Date(),
          sourceKey: 'coindesk',
          coinId,
          category: 'NEWS',
          headline: 'ETF story one',
          url: 'https://example.test/n1',
        },
        {
          occurredAt: new Date(),
          sourceKey: 'theblock',
          coinId,
          category: 'NEWS',
          headline: 'ETF story two',
          url: 'https://example.test/n2',
        },
      ]);
      for (const result of inserted) {
        await ctx.repositories.events.updateIntelligence(result.event.id, {
          narratives: ['etf-flows'],
          sentimentScore: 0.6,
          importance: 75,
        });
      }

      const narratives = await ctx.repositories.analytics.topNarratives({
        from: new Date(Date.now() - 3_600_000),
        to: new Date(Date.now() + 60_000),
        limit: 5,
      });
      expect(narratives[0]?.narrative).toBe('etf-flows');
      expect(narratives[0]?.eventCount).toBe(2);
      expect(narratives[0]?.topHeadlines.length).toBeGreaterThan(0);
    });

    it('assembles report inputs in one call', async () => {
      await ctx.repositories.events.insertMany([
        {
          occurredAt: new Date(),
          sourceKey: 'coindesk',
          coinId,
          category: 'NEWS',
          headline: 'Report input event',
          url: 'https://example.test/r1',
        },
      ]);

      const inputs = await ctx.repositories.analytics.reportInputs({
        from: new Date(Date.now() - 3_600_000),
        to: new Date(Date.now() + 60_000),
      });

      expect(inputs.eventCount).toBe(1);
      expect(inputs.keyEvents).toHaveLength(1);
      expect(inputs.coinRankings).toHaveProperty('mostBullish');
      expect(Array.isArray(inputs.narratives)).toBe(true);
    });
  });

  describe('telemetry', () => {
    it('summarises connector health', async () => {
      const now = new Date();
      await ctx.repositories.telemetry.recordRun({
        connectorKey: 'coingecko-markets',
        startedAt: now,
        finishedAt: new Date(now.getTime() + 500),
        status: 'SUCCESS',
        itemsFetched: 250,
        itemsIngested: 250,
        durationMs: 500,
        error: null,
        coinIds: [coinId],
      });
      await ctx.repositories.telemetry.recordRun({
        connectorKey: 'coingecko-markets',
        startedAt: new Date(now.getTime() + 1_000),
        finishedAt: new Date(now.getTime() + 1_700),
        status: 'FAILED',
        itemsFetched: 0,
        itemsIngested: 0,
        durationMs: 700,
        error: 'HTTP 503',
        coinIds: [],
      });

      const health = await ctx.repositories.telemetry.connectorHealth(
        new Date(now.getTime() - 60_000),
      );
      expect(health).toHaveLength(1);
      expect(health[0]?.runs).toBe(2);
      expect(health[0]?.failures).toBe(1);
      expect(health[0]?.lastStatus).toBe('FAILED');
      expect(health[0]?.meanDurationMs).toBe(600);
      expect(health[0]?.itemsIngested).toBe(250);
    });

    it('truncates an enormous error message', async () => {
      await ctx.repositories.telemetry.recordRun({
        connectorKey: 'noisy',
        startedAt: new Date(),
        finishedAt: new Date(),
        status: 'FAILED',
        itemsFetched: 0,
        itemsIngested: 0,
        durationMs: 1,
        error: 'x'.repeat(50_000),
        coinIds: [],
      });
      const row = await ctx.db.collectorRun.findFirst({ where: { connectorKey: 'noisy' } });
      expect(row?.error?.length).toBeLessThanOrEqual(2_000);
    });

    it('persists connector high-water marks', async () => {
      const at = new Date('2026-06-01T12:00:00Z');
      await ctx.repositories.telemetry.setState('news-rss', { lastItemAt: at, cursor: 'etag-1' });
      expect(await ctx.repositories.telemetry.getState('news-rss')).toMatchObject({
        cursor: 'etag-1',
      });

      // A partial patch must not clear the other field.
      await ctx.repositories.telemetry.setState('news-rss', { cursor: 'etag-2' });
      const state = await ctx.repositories.telemetry.getState('news-rss');
      expect(state.cursor).toBe('etag-2');
      expect(state.lastItemAt?.toISOString()).toBe(at.toISOString());
    });

    it('returns empty state for an unknown connector', async () => {
      expect(await ctx.repositories.telemetry.getState('never-run')).toEqual({
        lastItemAt: null,
        cursor: null,
      });
    });

    it('prunes old runs', async () => {
      await ctx.repositories.telemetry.recordRun({
        connectorKey: 'old',
        startedAt: new Date(Date.now() - 40 * 86_400_000),
        finishedAt: new Date(Date.now() - 40 * 86_400_000),
        status: 'SUCCESS',
        itemsFetched: 1,
        itemsIngested: 1,
        durationMs: 10,
        error: null,
        coinIds: [],
      });
      const removed = await ctx.repositories.telemetry.pruneRuns(
        new Date(Date.now() - 30 * 86_400_000),
      );
      expect(removed).toBe(1);
    });
  });

  // ─── Watchlists / portfolios / tags ────────────────────────────────────────

  describe('watchlists, portfolios and tags', () => {
    it('creates a default watchlist lazily and idempotently', async () => {
      const first = await ctx.repositories.watchlists.getDefault(userId);
      const second = await ctx.repositories.watchlists.getDefault(userId);
      expect(second.id).toBe(first.id);
      expect(second.isDefault).toBe(true);
    });

    it('adds, pins, reorders and removes coins', async () => {
      const watchlist = await ctx.repositories.watchlists.getDefault(userId);
      await ctx.repositories.watchlists.addCoin(watchlist.id, coinId);
      await ctx.repositories.watchlists.addCoin(watchlist.id, ethId);
      // Adding twice must not duplicate.
      await ctx.repositories.watchlists.addCoin(watchlist.id, ethId);
      expect(await ctx.repositories.watchlists.listItems(watchlist.id)).toHaveLength(2);

      await ctx.repositories.watchlists.reorder(watchlist.id, [ethId, coinId]);
      let items = await ctx.repositories.watchlists.listItems(watchlist.id);
      expect(items.map((item) => item.coin.id)).toEqual([ethId, coinId]);

      // Pinned sorts first regardless of position.
      await ctx.repositories.watchlists.setPinned(watchlist.id, coinId, true);
      items = await ctx.repositories.watchlists.listItems(watchlist.id);
      expect(items[0]?.coin.id).toBe(coinId);
      expect(items[0]?.isPinned).toBe(true);

      await ctx.repositories.watchlists.removeCoin(watchlist.id, coinId);
      expect(await ctx.repositories.watchlists.listItems(watchlist.id)).toHaveLength(1);
    });

    it('manages portfolio holdings', async () => {
      const portfolio = await ctx.repositories.portfolios.create(userId, 'Main');
      await ctx.repositories.portfolios.upsertHolding(portfolio.id, coinId, 1.5, 40_000);
      await ctx.repositories.portfolios.upsertHolding(portfolio.id, coinId, 2.5, 42_000);

      const holdings = await ctx.repositories.portfolios.listHoldings(portfolio.id);
      expect(holdings).toHaveLength(1);
      expect(holdings[0]?.quantity).toBeCloseTo(2.5);

      await ctx.repositories.portfolios.removeHolding(portfolio.id, coinId);
      expect(await ctx.repositories.portfolios.listHoldings(portfolio.id)).toHaveLength(0);
    });

    it('assigns tags and reads them back per coin', async () => {
      const tag = await ctx.repositories.tags.create(userId, 'high-conviction', '#ff0000');
      await ctx.repositories.tags.assign(tag.id, coinId);
      // Assigning twice must be a no-op, not an error.
      await ctx.repositories.tags.assign(tag.id, coinId);

      const map = await ctx.repositories.tags.listCoinTags([coinId, ethId]);
      expect(map.get(coinId)?.[0]?.name).toBe('high-conviction');
      expect(map.get(ethId)).toBeUndefined();

      await ctx.repositories.tags.unassign(tag.id, coinId);
      expect((await ctx.repositories.tags.listCoinTags([coinId])).size).toBe(0);
    });
  });
});
