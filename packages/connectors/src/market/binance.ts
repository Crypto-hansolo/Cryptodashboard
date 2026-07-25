import { z } from 'zod';
import type { CollectionRequest, ConnectorContext, ConnectorDescriptor } from '@cid/core';
import {
  BaseConnector,
  type CollectionBuilder,
  indexBySymbol,
  num,
  numOr,
  parseTimestamp,
  splitSymbol,
} from '../sdk/base.js';

/**
 * Binance spot + derivatives.
 *
 * Public market data needs no credentials — this platform is read-only by design
 * and never touches a private endpoint, so no API key is declared at all.
 *
 * Two things make this connector valuable beyond price: it detects *new trading
 * pairs*, which is the classic "new Binance listing" alert, and it supplies
 * funding rate and open interest, which no aggregator reports as promptly.
 */

const tickerSchema = z
  .object({
    symbol: z.string(),
    lastPrice: z.string(),
    quoteVolume: z.string().nullish(),
    priceChangePercent: z.string().nullish(),
    bidPrice: z.string().nullish(),
    askPrice: z.string().nullish(),
    closeTime: z.number().nullish(),
  })
  .passthrough();

const premiumIndexSchema = z
  .object({
    symbol: z.string(),
    markPrice: z.string().nullish(),
    indexPrice: z.string().nullish(),
    lastFundingRate: z.string().nullish(),
    nextFundingTime: z.number().nullish(),
    time: z.number().nullish(),
  })
  .passthrough();

const openInterestSchema = z
  .object({
    symbol: z.string(),
    openInterest: z.string(),
    time: z.number().nullish(),
  })
  .passthrough();

export class BinanceConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    key: 'binance',
    name: 'Binance',
    domain: 'derivatives',
    sourceKind: 'DERIVATIVES',
    homepageUrl: 'https://www.binance.com',
    credibility: 0.95,
    // No requirements: public endpoints only. Keys would unlock private
    // trading endpoints, which this platform deliberately never calls.
    requirements: [],
    defaultIntervalMs: 30_000,
    // Binance's documented weight budget is generous; 60/min is well inside it
    // while leaving headroom for the other exchange connectors.
    rateLimit: { requestsPerMinute: 60, burst: 10 },
    batchesCoins: true,
  };

  protected async run(
    request: CollectionRequest,
    context: ConnectorContext,
    builder: CollectionBuilder,
  ): Promise<void> {
    if (request.coins.length === 0) return;

    const spotBase = this.config(context, 'BINANCE_API_BASE') ?? 'https://api.binance.com';
    // Futures live on a different host from spot.
    const futuresBase = 'https://fapi.binance.com';
    const bySymbol = indexBySymbol(request.coins);
    const observedAt = context.clock.now();

    // ── Spot: one call returns every ticker ──
    const tickers = await context.http.getJson<unknown>(`${spotBase}/api/v3/ticker/24hr`, {
      cacheTtlSeconds: 10,
    });
    if (!tickers.ok) throw tickers.error;

    const parsedTickers = z.array(tickerSchema).safeParse(tickers.value);
    if (!parsedTickers.success) throw new Error('binance: unexpected 24hr ticker payload');
    builder.countFetched(parsedTickers.data.length);

    const pairs: Array<Record<string, unknown>> = [];

    for (const ticker of parsedTickers.data) {
      const split = splitSymbol(ticker.symbol);
      if (!split) continue;
      const coin = bySymbol.get(split.base);
      if (!coin) continue;

      const price = num(ticker.lastPrice);
      if (price === null) continue;

      const bid = num(ticker.bidPrice);
      const ask = num(ticker.askPrice);
      // Spread as a fraction of mid, which is comparable across assets.
      const spread =
        bid !== null && ask !== null && bid > 0 ? (ask - bid) / ((ask + bid) / 2) : null;

      pairs.push({
        sourceKey: this.descriptor.key,
        coinId: coin.id,
        venue: 'binance',
        venueKind: 'CEX' as const,
        base: split.base,
        quote: split.quote,
        symbol: ticker.symbol,
        volume24hUsd: num(ticker.quoteVolume),
        spread,
        isActive: true,
      });
    }

    builder.add('tradingPairs', pairs);

    // ── Derivatives: funding rate and open interest for perpetuals ──
    //
    // premiumIndex returns every symbol in one call. Open interest is per-symbol,
    // so it is fetched only for the coins actually being tracked, and capped so a
    // 500-coin watchlist cannot issue 500 requests in one tick.
    const premium = await context.http.getJson<unknown>(`${futuresBase}/fapi/v1/premiumIndex`, {
      cacheTtlSeconds: 20,
    });

    if (premium.ok) {
      const parsedPremium = z.array(premiumIndexSchema).safeParse(premium.value);
      if (parsedPremium.success) {
        const derivatives: Array<Record<string, unknown>> = [];
        const perpetuals: Array<{ symbol: string; coinId: string }> = [];

        for (const row of parsedPremium.data) {
          const split = splitSymbol(row.symbol);
          if (!split) continue;
          const coin = bySymbol.get(split.base);
          if (!coin) continue;

          derivatives.push({
            sourceKey: this.descriptor.key,
            coinId: coin.id,
            observedAt: parseTimestamp(row.time) ?? observedAt,
            instrument: row.symbol,
            fundingRate: num(row.lastFundingRate),
            nextFundingAt: parseTimestamp(row.nextFundingTime),
            openInterest: null,
            openInterestUsd: null,
            markPrice: num(row.markPrice),
            indexPrice: num(row.indexPrice),
            longShortRatio: null,
            volume24hUsd: null,
          });
          perpetuals.push({ symbol: row.symbol, coinId: coin.id });
        }

        // Open interest for the highest-priority perpetuals only.
        const oiTargets = perpetuals.slice(0, 20);
        const oiResults = await Promise.all(
          oiTargets.map(async (target) => {
            const response = await context.http.getJson<unknown>(
              `${futuresBase}/fapi/v1/openInterest`,
              { query: { symbol: target.symbol }, cacheTtlSeconds: 25 },
            );
            if (!response.ok) return null;
            const parsed = openInterestSchema.safeParse(response.value);
            return parsed.success ? { target, data: parsed.data } : null;
          }),
        );

        const oiBySymbol = new Map(
          oiResults.flatMap((result) =>
            result ? [[result.target.symbol, num(result.data.openInterest)]] : [],
          ),
        );

        for (const row of derivatives) {
          const openInterest = oiBySymbol.get(row.instrument as string);
          if (openInterest !== undefined && openInterest !== null) {
            row.openInterest = openInterest;
            const markPrice = row.markPrice as number | null;
            row.openInterestUsd = markPrice === null ? null : openInterest * markPrice;
          }
        }

        builder.add('derivatives', derivatives);
      }
    } else {
      // Futures being unavailable must not fail the spot half of the run.
      context.logger.debug(
        { connector: this.descriptor.key, err: premium.error.message },
        'binance futures unavailable, continuing with spot only',
      );
    }
  }
}

// ─── Candles ─────────────────────────────────────────────────────────────────

const klineSchema = z
  .tuple([
    z.number(), // open time
    z.string(), // open
    z.string(), // high
    z.string(), // low
    z.string(), // close
    z.string(), // volume
    z.number(), // close time
    z.string(), // quote volume
    z.number(), // trade count
  ])
  .rest(z.unknown());

const INTERVAL_TO_BINANCE: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
  '1w': '1w',
};

/**
 * OHLCV candles, on a slower cadence than the ticker.
 *
 * Separate connector rather than part of the ticker run: candles only change on
 * the interval boundary, so polling them every 30s alongside prices would waste
 * most of the rate-limit budget for no new information.
 */
export class BinanceCandlesConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    key: 'binance-candles',
    name: 'Binance (candles)',
    domain: 'market',
    sourceKind: 'MARKET_DATA',
    homepageUrl: 'https://www.binance.com',
    credibility: 0.95,
    requirements: [],
    defaultIntervalMs: 300_000,
    rateLimit: { requestsPerMinute: 30, burst: 5 },
    // One request per coin, so the scheduler fans out.
    batchesCoins: false,
  };

  protected async run(
    request: CollectionRequest,
    context: ConnectorContext,
    builder: CollectionBuilder,
  ): Promise<void> {
    const base = this.config(context, 'BINANCE_API_BASE') ?? 'https://api.binance.com';
    const interval = '1h';

    // Cap the fan-out: candles are a nice-to-have, and a 500-coin watchlist must
    // not consume the entire minute's budget on them.
    for (const coin of request.coins.slice(0, 25)) {
      const symbol = `${coin.symbol.toUpperCase()}USDT`;

      const response = await context.http.getJson<unknown>(`${base}/api/v3/klines`, {
        query: { symbol, interval: INTERVAL_TO_BINANCE[interval], limit: 200 },
        cacheTtlSeconds: 60,
      });
      // A coin with no USDT pair on Binance 400s; that is expected, not an error.
      if (!response.ok) continue;

      const parsed = z.array(klineSchema).safeParse(response.value);
      if (!parsed.success) continue;

      builder.countFetched(parsed.data.length);
      builder.add(
        'candles',
        parsed.data.flatMap((row) => {
          const openTime = parseTimestamp(row[0]);
          if (!openTime) return [];
          return [
            {
              sourceKey: this.descriptor.key,
              coinId: coin.id,
              interval,
              openTime,
              open: numOr(row[1], 0),
              high: numOr(row[2], 0),
              low: numOr(row[3], 0),
              close: numOr(row[4], 0),
              volume: numOr(row[5], 0),
              quoteVolume: num(row[7]),
              trades: num(row[8]),
            },
          ];
        }),
      );
    }
  }
}
