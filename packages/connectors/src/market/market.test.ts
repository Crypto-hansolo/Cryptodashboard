import { describe, expect, it } from 'vitest';
import { UpstreamError, type Coin } from '@cid/core';
import type { StubRoute } from '@cid/platform/testing';
import {
  FIXED_NOW,
  makeCoin,
  makeContext,
  makeRequest,
  type TestContext,
} from '../connector-fixtures.js';
import { CoinGeckoMarketsConnector, CoinGeckoSearchClient } from './coingecko.js';
import { BinanceCandlesConnector, BinanceConnector } from './binance.js';

/**
 * Market connectors are translation layers: a provider's JSON in, domain records
 * out. Every bug they can have is a mapping bug — a field read from the wrong
 * key, a string left uncoerced, a row attributed to the wrong coin — and none of
 * those are visible against a live API, whose payloads change underneath you and
 * whose rate limits make a test suite slow and flaky. So they are tested against
 * exact recorded payloads.
 */

const NOW = FIXED_NOW;
const coin = makeCoin;
const collectionRequest = (coins: readonly Coin[]): ReturnType<typeof makeRequest> =>
  makeRequest(coins);
const context = (
  routes: readonly StubRoute[],
  config: Record<string, string | undefined> = {},
): TestContext => makeContext(routes, config);

// ─── CoinGecko ───────────────────────────────────────────────────────────────

const marketRow = {
  id: 'bitcoin',
  symbol: 'btc',
  name: 'Bitcoin',
  image: 'https://img/btc.png',
  current_price: 89948.29,
  market_cap: 1_783_000_000_000,
  market_cap_rank: 1,
  fully_diluted_valuation: 1_889_000_000_000,
  total_volume: 24_100_000_000,
  circulating_supply: 19_820_000,
  total_supply: 19_820_000,
  max_supply: 21_000_000,
  ath: 112_000,
  atl: 67.81,
  price_change_percentage_1h_in_currency: 0.12,
  price_change_percentage_24h_in_currency: -0.11,
  price_change_percentage_7d_in_currency: 3.4,
  price_change_percentage_30d_in_currency: -8.2,
  last_updated: '2026-07-25T11:59:30.000Z',
};

describe('CoinGeckoMarketsConnector', () => {
  const connector = new CoinGeckoMarketsConnector();

  it('is enabled without an API key — the platform must run keyless', async () => {
    const { context: ctx } = context([]);
    expect(connector.isEnabled(ctx)).toBe(true);
    // ...but reports itself degraded, so the status page can say why coverage is
    // thin.
    expect(connector.isDegraded(ctx)).toBe(true);
    expect(connector.missingRequirements(ctx)).toEqual(['COINGECKO_API_KEY']);
  });

  it('maps a market row onto a snapshot, field by field', async () => {
    const { context: ctx } = context([{ match: '/coins/markets', body: [marketRow] }]);

    const result = await connector.collect(collectionRequest([coin()]), ctx);

    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.itemsFetched).toBe(1);
    expect(result.value.records.marketSnapshots).toEqual([
      {
        sourceKey: 'coingecko',
        coinId: 'coin-btc',
        observedAt: new Date('2026-07-25T11:59:30.000Z'),
        priceUsd: 89948.29,
        marketCapUsd: 1_783_000_000_000,
        fdvUsd: 1_889_000_000_000,
        volume24hUsd: 24_100_000_000,
        circulatingSupply: 19_820_000,
        totalSupply: 19_820_000,
        maxSupply: 21_000_000,
        liquidityUsd: null,
        priceChange1hPct: 0.12,
        priceChange24hPct: -0.11,
        priceChange7dPct: 3.4,
        priceChange30dPct: -8.2,
        marketCapRank: 1,
        athUsd: 112_000,
        atlUsd: 67.81,
      },
    ]);
  });

  it("prefers the provider's timestamp over poll time", async () => {
    /*
     * `observedAt` must say when the price was true, not when we happened to
     * ask — otherwise every chart is skewed by the poll interval and two
     * providers disagree about the same minute.
     */
    const { context: ctx } = context([{ match: '/coins/markets', body: [marketRow] }]);

    const result = await connector.collect(collectionRequest([coin()]), ctx);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.marketSnapshots?.[0]?.observedAt).toEqual(
      new Date('2026-07-25T11:59:30.000Z'),
    );
  });

  it('falls back to the clock when the provider omits a timestamp', async () => {
    const { context: ctx } = context([
      { match: '/coins/markets', body: [{ ...marketRow, last_updated: null }] },
    ]);

    const result = await connector.collect(collectionRequest([coin()]), ctx);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.marketSnapshots?.[0]?.observedAt).toEqual(NOW);
  });

  it('drops a row with no price rather than storing a zero', async () => {
    // A priceless row is not an observation; storing 0 would show up as a -100%
    // move and fire every price alert at once.
    const { context: ctx } = context([
      { match: '/coins/markets', body: [{ ...marketRow, current_price: null }] },
    ]);

    const result = await connector.collect(collectionRequest([coin()]), ctx);

    if (!result.ok) throw new Error('expected success');
    // The builder omits empty buckets entirely rather than writing an empty array.
    expect(result.value.records.marketSnapshots ?? []).toEqual([]);
    // Still counted as fetched: we saw the row, we just could not use it.
    expect(result.value.itemsFetched).toBe(1);
  });

  it('ignores rows for coins it did not ask about', async () => {
    const { context: ctx } = context([
      { match: '/coins/markets', body: [marketRow, { ...marketRow, id: 'dogecoin' }] },
    ]);

    const result = await connector.collect(collectionRequest([coin()]), ctx);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.marketSnapshots).toHaveLength(1);
  });

  it('keeps nulls as nulls for optional fields', async () => {
    const { context: ctx } = context([
      {
        match: '/coins/markets',
        body: [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 100 }],
      },
    ]);

    const result = await connector.collect(collectionRequest([coin()]), ctx);

    if (!result.ok) throw new Error('expected success');
    const snapshot = result.value.records.marketSnapshots?.[0];
    expect(snapshot?.priceUsd).toBe(100);
    expect(snapshot?.marketCapUsd).toBeNull();
    expect(snapshot?.maxSupply).toBeNull();
  });

  it('requests only the coins it can address by CoinGecko id', async () => {
    const { context: ctx, http } = context([{ match: '/coins/markets', body: [] }]);

    await connector.collect(
      collectionRequest([
        coin(),
        coin({ id: 'coin-x', symbol: 'X', coingeckoId: null }),
        coin({ id: 'coin-eth', symbol: 'ETH', coingeckoId: 'ethereum' }),
      ]),
      ctx,
    );

    expect(http.lastRequest?.query).toMatchObject({
      vs_currency: 'usd',
      ids: 'bitcoin,ethereum',
      per_page: 2,
    });
  });

  it('makes no request at all when no coin has a CoinGecko id', async () => {
    const { context: ctx, http } = context([{ match: '/coins/markets', body: [] }]);

    const result = await connector.collect(collectionRequest([coin({ coingeckoId: null })]), ctx);

    expect(result.ok).toBe(true);
    expect(http.requests).toHaveLength(0);
  });

  it('pages in chunks of 250, the provider limit', async () => {
    const coins = Array.from({ length: 260 }, (_, index) =>
      coin({ id: `coin-${index}`, coingeckoId: `gecko-${index}` }),
    );
    const { context: ctx, http } = context([{ match: '/coins/markets', body: [] }]);

    await connector.collect(collectionRequest(coins), ctx);

    expect(http.requests).toHaveLength(2);
    expect(String(http.requests[0]?.query?.ids).split(',')).toHaveLength(250);
    expect(String(http.requests[1]?.query?.ids).split(',')).toHaveLength(10);
  });

  it('sends a demo key header on the public host, a pro key on the pro host', async () => {
    // Sending a pro key to the public host silently downgrades to public limits,
    // which looks like a broken key rather than a misconfiguration.
    const demo = context([{ match: '/coins/markets', body: [] }], {
      COINGECKO_API_KEY: 'demo-key',
    });
    await connector.collect(collectionRequest([coin()]), demo.context);
    expect(demo.http.lastRequest?.url).toContain('api.coingecko.com');
    expect(demo.http.lastRequest?.headers).toEqual({ 'x-cg-demo-api-key': 'demo-key' });

    const pro = context([{ match: '/coins/markets', body: [] }], {
      COINGECKO_API_KEY: 'pro-key',
      COINGECKO_API_TIER: 'pro',
    });
    await connector.collect(collectionRequest([coin()]), pro.context);
    expect(pro.http.lastRequest?.url).toContain('pro-api.coingecko.com');
    expect(pro.http.lastRequest?.headers).toEqual({ 'x-cg-pro-api-key': 'pro-key' });
  });

  it('sends no auth header when no key is configured', async () => {
    const { context: ctx, http } = context([{ match: '/coins/markets', body: [] }]);

    await connector.collect(collectionRequest([coin()]), ctx);

    expect(http.lastRequest?.headers).toEqual({});
  });

  it('surfaces an upstream failure as a failed run, not as "no data"', async () => {
    /*
     * The distinction matters to the scheduler: a failed run gets the retry and
     * backoff policy and shows up in connector health, while an empty successful
     * run advances the high-water mark and hides the outage.
     */
    const { context: ctx } = context([
      { match: '/coins/markets', error: new UpstreamError('coingecko', 'rate limited', 429) },
    ]);

    const result = await connector.collect(collectionRequest([coin()]), ctx);

    expect(result.ok).toBe(false);
  });

  it('fails the run when the payload shape changes', async () => {
    // A silent schema drift would otherwise write nothing, forever, invisibly.
    const { context: ctx } = context([
      { match: '/coins/markets', body: [{ id: 'bitcoin', symbol: 42 }] },
    ]);

    const result = await connector.collect(collectionRequest([coin()]), ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('coingecko');
  });
});

describe('CoinGeckoSearchClient', () => {
  it('maps search hits and prefers the large image', async () => {
    const { context: ctx } = context([
      {
        match: '/search',
        body: {
          coins: [
            {
              id: 'crypto-com-chain',
              symbol: 'cro',
              name: 'Cronos',
              market_cap_rank: 42,
              thumb: 'https://img/small.png',
              large: 'https://img/large.png',
            },
          ],
        },
      },
    ]);

    const results = await new CoinGeckoSearchClient(ctx).search('cronos');

    expect(results).toEqual([
      {
        coingeckoId: 'crypto-com-chain',
        symbol: 'CRO',
        name: 'Cronos',
        marketCapRank: 42,
        imageUrl: 'https://img/large.png',
      },
    ]);
  });

  it('falls back to the thumbnail when there is no large image', async () => {
    const { context: ctx } = context([
      { match: '/search', body: { coins: [{ id: 'x', symbol: 'x', name: 'X', thumb: 't' }] } },
    ]);

    const results = await new CoinGeckoSearchClient(ctx).search('x');

    expect(results[0]?.imageUrl).toBe('t');
  });

  it('caps results, so the palette cannot be flooded', async () => {
    const coins = Array.from({ length: 40 }, (_, index) => ({
      id: `c${index}`,
      symbol: 's',
      name: 'n',
    }));
    const { context: ctx } = context([{ match: '/search', body: { coins } }]);

    expect(await new CoinGeckoSearchClient(ctx).search('s')).toHaveLength(25);
  });

  it('returns nothing for a blank query, without calling the provider', async () => {
    const { context: ctx, http } = context([{ match: '/search', body: { coins: [] } }]);

    expect(await new CoinGeckoSearchClient(ctx).search('   ')).toEqual([]);
    expect(http.requests).toHaveLength(0);
  });

  it('degrades to an empty list rather than throwing at the user', async () => {
    // This runs on every keystroke in the command palette; a provider outage must
    // not break typing.
    const { context: ctx } = context([
      { match: '/search', error: new UpstreamError('coingecko', 'down', 503) },
    ]);

    expect(await new CoinGeckoSearchClient(ctx).search('btc')).toEqual([]);
  });

  it('degrades to an empty list on a malformed payload', async () => {
    const { context: ctx } = context([{ match: '/search', body: { coins: 'nope' } }]);

    expect(await new CoinGeckoSearchClient(ctx).search('btc')).toEqual([]);
  });
});

// ─── Binance ─────────────────────────────────────────────────────────────────

const ticker = {
  symbol: 'BTCUSDT',
  lastPrice: '89948.29',
  bidPrice: '89948.00',
  askPrice: '89950.00',
  quoteVolume: '2410000000',
  volume: '26800',
  priceChangePercent: '-0.11',
};

const premium = {
  symbol: 'BTCUSDT',
  markPrice: '89960.10',
  indexPrice: '89955.00',
  lastFundingRate: '0.00012',
  nextFundingTime: 1_784_000_000_000,
  time: 1_783_999_000_000,
};

describe('BinanceConnector', () => {
  const connector = new BinanceConnector();

  it('needs no credentials — only public endpoints are ever called', () => {
    const { context: ctx } = context([]);
    expect(connector.descriptor.requirements).toEqual([]);
    expect(connector.isEnabled(ctx)).toBe(true);
    expect(connector.isDegraded(ctx)).toBe(false);
  });

  it('maps a spot ticker onto a trading pair, with spread as a fraction of mid', async () => {
    const { context: ctx } = context([
      { match: '/api/v3/ticker/24hr', body: [ticker] },
      { match: '/fapi/v1/premiumIndex', body: [] },
    ]);

    const result = await connector.collect(collectionRequest([coin()]), ctx);

    if (!result.ok) throw new Error(result.error.message);
    const pair = result.value.records.tradingPairs?.[0];
    expect(pair).toMatchObject({
      sourceKey: 'binance',
      coinId: 'coin-btc',
      venue: 'binance',
      venueKind: 'CEX',
      base: 'BTC',
      quote: 'USDT',
      symbol: 'BTCUSDT',
      volume24hUsd: 2_410_000_000,
      isActive: true,
    });
    // (89950 - 89948) / 89949 — comparable across assets of any price.
    expect(pair?.spread as number).toBeCloseTo(2 / 89_949, 9);
  });

  it('leaves spread null when the book is one-sided', async () => {
    const { context: ctx } = context([
      { match: '/api/v3/ticker/24hr', body: [{ ...ticker, bidPrice: '0' }] },
      { match: '/fapi/v1/premiumIndex', body: [] },
    ]);

    const result = await connector.collect(collectionRequest([coin()]), ctx);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.tradingPairs?.[0]?.spread).toBeNull();
  });

  it('skips symbols whose quote asset it does not recognise', async () => {
    /*
     * "BTCTRY" would otherwise be split as base "BTCT", quote "RY" — attributing
     * lira volume to a coin that does not exist. Skipping the pair is the safe
     * failure.
     */
    const { context: ctx } = context([
      { match: '/api/v3/ticker/24hr', body: [{ ...ticker, symbol: 'BTCTRY' }] },
      { match: '/fapi/v1/premiumIndex', body: [] },
    ]);

    const result = await connector.collect(collectionRequest([coin()]), ctx);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.tradingPairs ?? []).toEqual([]);
  });

  it('ignores tickers for untracked coins', async () => {
    const { context: ctx } = context([
      { match: '/api/v3/ticker/24hr', body: [ticker, { ...ticker, symbol: 'DOGEUSDT' }] },
      { match: '/fapi/v1/premiumIndex', body: [] },
    ]);

    const result = await connector.collect(collectionRequest([coin()]), ctx);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.tradingPairs).toHaveLength(1);
  });

  it('maps funding rate and mark price from the premium index', async () => {
    const { context: ctx } = context([
      { match: '/api/v3/ticker/24hr', body: [ticker] },
      { match: '/fapi/v1/premiumIndex', body: [premium] },
      { match: '/fapi/v1/openInterest', body: { symbol: 'BTCUSDT', openInterest: '78000' } },
    ]);

    const result = await connector.collect(collectionRequest([coin()]), ctx);

    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.records.derivatives?.[0]).toMatchObject({
      coinId: 'coin-btc',
      instrument: 'BTCUSDT',
      fundingRate: 0.00012,
      markPrice: 89_960.1,
      indexPrice: 89_955,
      openInterest: 78_000,
    });
  });

  it('values open interest in USD using the mark price', async () => {
    const { context: ctx } = context([
      { match: '/api/v3/ticker/24hr', body: [ticker] },
      { match: '/fapi/v1/premiumIndex', body: [premium] },
      { match: '/fapi/v1/openInterest', body: { symbol: 'BTCUSDT', openInterest: '78000' } },
    ]);

    const result = await connector.collect(collectionRequest([coin()]), ctx);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.derivatives?.[0]?.openInterestUsd).toBeCloseTo(
      78_000 * 89_960.1,
      2,
    );
  });

  it('leaves open interest null when that call fails, keeping the rest', async () => {
    const { context: ctx } = context([
      { match: '/api/v3/ticker/24hr', body: [ticker] },
      { match: '/fapi/v1/premiumIndex', body: [premium] },
      {
        match: '/fapi/v1/openInterest',
        error: new UpstreamError('binance', 'unavailable', 503),
      },
    ]);

    const result = await connector.collect(collectionRequest([coin()]), ctx);

    if (!result.ok) throw new Error('expected success');
    const derivative = result.value.records.derivatives?.[0];
    expect(derivative?.fundingRate).toBe(0.00012);
    expect(derivative?.openInterest).toBeNull();
    expect(derivative?.openInterestUsd).toBeNull();
  });

  it('caps open-interest fan-out at 20 symbols', async () => {
    // Per-symbol calls: a 500-coin watchlist would otherwise issue 500 requests
    // inside one 30-second tick.
    const coins = Array.from({ length: 40 }, (_, index) =>
      coin({ id: `coin-${index}`, symbol: `T${index}` }),
    );
    const premiums = coins.map((c) => ({ ...premium, symbol: `${c.symbol}USDT` }));
    const { context: ctx, http } = context([
      { match: '/api/v3/ticker/24hr', body: [] },
      { match: '/fapi/v1/premiumIndex', body: premiums },
      { match: '/fapi/v1/openInterest', body: { symbol: 'x', openInterest: '1' } },
    ]);

    await connector.collect(collectionRequest(coins), ctx);

    const oiCalls = http.urls.filter((url) => url.includes('openInterest'));
    expect(oiCalls).toHaveLength(20);
  });

  it('continues with spot data when futures are unavailable', async () => {
    /*
     * Spot and futures are different hosts. One being down is common, and losing
     * prices because funding rates were unavailable would be a bad trade.
     */
    const { context: ctx } = context([
      { match: '/api/v3/ticker/24hr', body: [ticker] },
      { match: '/fapi/v1/premiumIndex', error: new UpstreamError('binance', 'down', 503) },
    ]);

    const result = await connector.collect(collectionRequest([coin()]), ctx);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.tradingPairs).toHaveLength(1);
    expect(result.value.records.derivatives).toBeUndefined();
  });

  it('fails the run when the spot payload shape changes', async () => {
    const { context: ctx } = context([{ match: '/api/v3/ticker/24hr', body: { not: 'an array' } }]);

    expect((await connector.collect(collectionRequest([coin()]), ctx)).ok).toBe(false);
  });

  it('honours a custom API base, for a regional or proxied endpoint', async () => {
    const { context: ctx, http } = context(
      [
        { match: '/api/v3/ticker/24hr', body: [] },
        { match: '/fapi/v1/premiumIndex', body: [] },
      ],
      { BINANCE_API_BASE: 'https://api1.binance.com' },
    );

    await connector.collect(collectionRequest([coin()]), ctx);

    expect(http.urls[0]).toBe('https://api1.binance.com/api/v3/ticker/24hr');
  });

  it('does nothing when no coins are tracked', async () => {
    const { context: ctx, http } = context([{ match: '/api/v3/ticker/24hr', body: [] }]);

    expect((await connector.collect(collectionRequest([]), ctx)).ok).toBe(true);
    expect(http.requests).toHaveLength(0);
  });
});

describe('BinanceCandlesConnector', () => {
  const connector = new BinanceCandlesConnector();
  // [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades]
  const kline = [
    1_783_900_800_000,
    '89000.00',
    '90500.00',
    '88750.00',
    '89948.29',
    '1240.5',
    1_783_904_399_999,
    '111000000',
    48_120,
  ];

  it('maps a kline tuple by position', async () => {
    // Positional payloads are exactly where an off-by-one goes unnoticed, because
    // open/high/low/close are all plausible prices.
    const { context: ctx } = context([{ match: '/api/v3/klines', body: [kline] }]);

    const result = await connector.collect(collectionRequest([coin()]), ctx);

    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.records.candles).toEqual([
      {
        sourceKey: 'binance-candles',
        coinId: 'coin-btc',
        interval: '1h',
        openTime: new Date(1_783_900_800_000),
        open: 89_000,
        high: 90_500,
        low: 88_750,
        close: 89_948.29,
        volume: 1_240.5,
        quoteVolume: 111_000_000,
        trades: 48_120,
      },
    ]);
  });

  it('requests the USDT pair at the hourly interval', async () => {
    const { context: ctx, http } = context([{ match: '/api/v3/klines', body: [] }]);

    await connector.collect(collectionRequest([coin({ symbol: 'eth' })]), ctx);

    expect(http.lastRequest?.query).toEqual({ symbol: 'ETHUSDT', interval: '1h', limit: 200 });
  });

  it('skips a coin with no Binance pair instead of failing the run', async () => {
    // A coin without a USDT pair 400s. That is expected, not an error.
    const { context: ctx } = context([
      { match: 'symbol=NOPEUSDT', error: new UpstreamError('binance', 'invalid symbol', 400) },
      { match: '/api/v3/klines', body: [kline] },
    ]);

    const result = await connector.collect(
      collectionRequest([coin({ id: 'coin-nope', symbol: 'NOPE' }), coin()]),
      ctx,
    );

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.candles).toHaveLength(1);
    expect(result.value.records.candles?.[0]?.coinId).toBe('coin-btc');
  });

  it('caps fan-out at 25 coins per run', async () => {
    const coins = Array.from({ length: 40 }, (_, index) =>
      coin({ id: `coin-${index}`, symbol: `T${index}` }),
    );
    const { context: ctx, http } = context([{ match: '/api/v3/klines', body: [] }]);

    await connector.collect(collectionRequest(coins), ctx);

    expect(http.requests).toHaveLength(25);
  });

  it('fans out per coin rather than batching', () => {
    // The descriptor is what the scheduler reads to decide this.
    expect(connector.descriptor.batchesCoins).toBe(false);
  });
});
