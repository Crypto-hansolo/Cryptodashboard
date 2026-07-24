import { z } from 'zod';
import { candleIntervalSchema, chainSchema } from './enums.js';

/**
 * Market-data records. All of these are strictly append-only time series:
 * a new observation is a new row, never an update. See docs/ARCHITECTURE.md
 * ("Append-only history") for why, and `MARKET_SNAPSHOT_RETENTION_DAYS` for the
 * one place where old raw rows may be pruned in favour of rollups.
 */

export const marketSnapshotSchema = z.object({
  id: z.string(),
  coinId: z.string(),
  sourceId: z.string(),
  observedAt: z.date(),
  priceUsd: z.number().nonnegative(),
  marketCapUsd: z.number().nonnegative().nullable().default(null),
  /** Fully diluted valuation. */
  fdvUsd: z.number().nonnegative().nullable().default(null),
  volume24hUsd: z.number().nonnegative().nullable().default(null),
  circulatingSupply: z.number().nonnegative().nullable().default(null),
  totalSupply: z.number().nonnegative().nullable().default(null),
  maxSupply: z.number().nonnegative().nullable().default(null),
  /** Aggregate on-chain + order-book liquidity, when the provider exposes it. */
  liquidityUsd: z.number().nonnegative().nullable().default(null),
  priceChange1hPct: z.number().nullable().default(null),
  priceChange24hPct: z.number().nullable().default(null),
  priceChange7dPct: z.number().nullable().default(null),
  priceChange30dPct: z.number().nullable().default(null),
  marketCapRank: z.number().int().positive().nullable().default(null),
  athUsd: z.number().nonnegative().nullable().default(null),
  atlUsd: z.number().nonnegative().nullable().default(null),
});
export type MarketSnapshot = z.infer<typeof marketSnapshotSchema>;

export const marketSnapshotDraftSchema = marketSnapshotSchema.omit({
  id: true,
  sourceId: true,
});
export type MarketSnapshotDraft = z.infer<typeof marketSnapshotDraftSchema> & { sourceKey: string };

export const ohlcvCandleSchema = z.object({
  id: z.string(),
  coinId: z.string(),
  sourceId: z.string(),
  interval: candleIntervalSchema,
  /** Candle open time, aligned to the interval boundary. */
  openTime: z.date(),
  open: z.number().nonnegative(),
  high: z.number().nonnegative(),
  low: z.number().nonnegative(),
  close: z.number().nonnegative(),
  volume: z.number().nonnegative(),
  quoteVolume: z.number().nonnegative().nullable().default(null),
  trades: z.number().int().nonnegative().nullable().default(null),
});
export type OhlcvCandle = z.infer<typeof ohlcvCandleSchema>;

// ─── Derivatives ─────────────────────────────────────────────────────────────

export const derivativesSnapshotSchema = z.object({
  id: z.string(),
  coinId: z.string(),
  sourceId: z.string(),
  observedAt: z.date(),
  /** Exchange-specific instrument, e.g. `BTCUSDT` or `BTC-PERP`. */
  instrument: z.string().min(1),
  /** Predicted or last-settled funding rate as a fraction (0.0001 = 1bp). */
  fundingRate: z.number().nullable().default(null),
  nextFundingAt: z.date().nullable().default(null),
  openInterest: z.number().nonnegative().nullable().default(null),
  openInterestUsd: z.number().nonnegative().nullable().default(null),
  markPrice: z.number().nonnegative().nullable().default(null),
  indexPrice: z.number().nonnegative().nullable().default(null),
  /** Long/short account ratio when published. */
  longShortRatio: z.number().nonnegative().nullable().default(null),
  volume24hUsd: z.number().nonnegative().nullable().default(null),
});
export type DerivativesSnapshot = z.infer<typeof derivativesSnapshotSchema>;

export const optionsSnapshotSchema = z.object({
  id: z.string(),
  coinId: z.string(),
  sourceId: z.string(),
  observedAt: z.date(),
  expiry: z.date(),
  strike: z.number().positive(),
  kind: z.enum(['CALL', 'PUT']),
  openInterest: z.number().nonnegative().nullable().default(null),
  /** Annualised implied volatility as a fraction (0.65 = 65%). */
  impliedVolatility: z.number().nonnegative().nullable().default(null),
  volume24h: z.number().nonnegative().nullable().default(null),
});
export type OptionsSnapshot = z.infer<typeof optionsSnapshotSchema>;

export const liquidationSchema = z.object({
  id: z.string(),
  coinId: z.string(),
  sourceId: z.string(),
  occurredAt: z.date(),
  instrument: z.string().min(1),
  side: z.enum(['LONG', 'SHORT']),
  quantity: z.number().nonnegative(),
  price: z.number().nonnegative(),
  valueUsd: z.number().nonnegative(),
});
export type Liquidation = z.infer<typeof liquidationSchema>;

// ─── Trades ──────────────────────────────────────────────────────────────────

export const tradeSchema = z.object({
  id: z.string(),
  coinId: z.string(),
  sourceId: z.string(),
  occurredAt: z.date(),
  venue: z.string().min(1),
  venueKind: z.enum(['CEX', 'DEX']),
  pair: z.string().min(1),
  side: z.enum(['BUY', 'SELL']),
  price: z.number().nonnegative(),
  quantity: z.number().nonnegative(),
  valueUsd: z.number().nonnegative(),
  /** DEX only: the transaction hash and the trader's address. */
  txHash: z.string().nullable().default(null),
  trader: z.string().nullable().default(null),
  chain: chainSchema.nullable().default(null),
  /** Set when the trade cleared the whale threshold at ingestion time. */
  isWhale: z.boolean().default(false),
});
export type Trade = z.infer<typeof tradeSchema>;

// ─── Venues & liquidity ──────────────────────────────────────────────────────

export const tradingPairSchema = z.object({
  id: z.string(),
  coinId: z.string(),
  sourceId: z.string(),
  venue: z.string().min(1),
  venueKind: z.enum(['CEX', 'DEX']),
  base: z.string().min(1),
  quote: z.string().min(1),
  /** Provider symbol used to poll this pair, e.g. `ETHUSDT`. */
  symbol: z.string().min(1),
  volume24hUsd: z.number().nonnegative().nullable().default(null),
  /** Bid/ask spread as a fraction of mid. */
  spread: z.number().nonnegative().nullable().default(null),
  isActive: z.boolean().default(true),
  firstSeenAt: z.date(),
  lastSeenAt: z.date(),
});
export type TradingPair = z.infer<typeof tradingPairSchema>;

/**
 * A *new* venue/pair appearing is itself a high-value event (the classic
 * "new Binance listing" alert), which is why first-seen is recorded rather
 * than treating pairs as static reference data.
 */
export const exchangeListingSchema = z.object({
  id: z.string(),
  coinId: z.string(),
  sourceId: z.string(),
  venue: z.string().min(1),
  venueKind: z.enum(['CEX', 'DEX']),
  symbol: z.string().min(1),
  detectedAt: z.date(),
  /** Announcement URL when the venue published one. */
  url: z.string().nullable().default(null),
});
export type ExchangeListing = z.infer<typeof exchangeListingSchema>;

export const liquidityPoolSchema = z.object({
  id: z.string(),
  coinId: z.string(),
  sourceId: z.string(),
  observedAt: z.date(),
  chain: chainSchema,
  dex: z.string().min(1),
  poolAddress: z.string().min(1),
  pairLabel: z.string().min(1),
  liquidityUsd: z.number().nonnegative(),
  volume24hUsd: z.number().nonnegative().nullable().default(null),
  priceUsd: z.number().nonnegative().nullable().default(null),
  /** Buy/sell transaction counts over 24h — a cheap manipulation signal. */
  buys24h: z.number().int().nonnegative().nullable().default(null),
  sells24h: z.number().int().nonnegative().nullable().default(null),
});
export type LiquidityPool = z.infer<typeof liquidityPoolSchema>;

/** Denormalised "current state" row the dashboard header reads. */
export interface MarketQuote {
  coinId: string;
  priceUsd: number;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  fdvUsd: number | null;
  priceChange1hPct: number | null;
  priceChange24hPct: number | null;
  priceChange7dPct: number | null;
  observedAt: Date;
}
