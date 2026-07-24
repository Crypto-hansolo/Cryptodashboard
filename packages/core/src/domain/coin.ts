import { z } from 'zod';
import { chainSchema, identifierKindSchema } from './enums.js';

/**
 * Assets and the user-facing organisation around them (watchlists, portfolios,
 * tags). Coins are global and shared; watchlists are per-user.
 */

export const coinIdentifierSchema = z.object({
  kind: identifierKindSchema,
  value: z.string().min(1),
  /** Only meaningful for CONTRACT / CHAIN_NATIVE identifiers. */
  chain: chainSchema.nullable().default(null),
});
export type CoinIdentifier = z.infer<typeof coinIdentifierSchema>;

export const contractRefSchema = z.object({
  chain: chainSchema,
  address: z.string().min(1),
  decimals: z.number().int().min(0).max(36).nullable().default(null),
  /** Set when this is the token's canonical deployment rather than a bridged copy. */
  isNative: z.boolean().default(false),
});
export type ContractRef = z.infer<typeof contractRefSchema>;

export const coinSchema = z.object({
  id: z.string(),
  /** URL-safe canonical key, e.g. `crypto-com-chain`. Unique. */
  slug: z.string().min(1),
  symbol: z.string().min(1),
  name: z.string().min(1),
  coingeckoId: z.string().nullable().default(null),
  coinmarketcapId: z.string().nullable().default(null),
  /** Home chain for a native asset; null for multi-chain tokens. */
  chain: chainSchema.nullable().default(null),
  imageUrl: z.string().url().nullable().default(null),
  description: z.string().nullable().default(null),
  websiteUrl: z.string().url().nullable().default(null),
  /** `owner/repo` slugs monitored by the GitHub connector. */
  githubRepos: z.array(z.string()).default([]),
  twitterHandle: z.string().nullable().default(null),
  subreddit: z.string().nullable().default(null),
  /** Snapshot IDs used by governance connectors (Snapshot.org spaces). */
  snapshotSpaces: z.array(z.string()).default([]),
  marketCapRank: z.number().int().positive().nullable().default(null),
  contracts: z.array(contractRefSchema).default([]),
  identifiers: z.array(coinIdentifierSchema).default([]),
  /** Free-text narrative buckets ("AI", "L2", "RWA") used by report generators. */
  categories: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Coin = z.infer<typeof coinSchema>;

/** Payload accepted when creating/upserting a coin from a connector. */
export const coinDraftSchema = coinSchema
  .omit({ id: true, createdAt: true, updatedAt: true })
  .partial({
    chain: true,
    imageUrl: true,
    description: true,
    websiteUrl: true,
    githubRepos: true,
    twitterHandle: true,
    subreddit: true,
    snapshotSpaces: true,
    marketCapRank: true,
    contracts: true,
    identifiers: true,
    categories: true,
    isActive: true,
    coingeckoId: true,
    coinmarketcapId: true,
  });
export type CoinDraft = z.infer<typeof coinDraftSchema>;

// ─── Watchlists ──────────────────────────────────────────────────────────────

export const watchlistItemSchema = z.object({
  id: z.string(),
  watchlistId: z.string(),
  coinId: z.string(),
  /** Pinned coins sort first and are polled at the highest cadence. */
  isPinned: z.boolean().default(false),
  position: z.number().int().min(0).default(0),
  notes: z.string().nullable().default(null),
  createdAt: z.date(),
});
export type WatchlistItem = z.infer<typeof watchlistItemSchema>;

export const watchlistSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  isDefault: z.boolean().default(false),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Watchlist = z.infer<typeof watchlistSchema>;

// ─── Portfolios ──────────────────────────────────────────────────────────────

export const portfolioHoldingSchema = z.object({
  id: z.string(),
  portfolioId: z.string(),
  coinId: z.string(),
  quantity: z.number(),
  /** Average acquisition price in the portfolio's currency; null when unknown. */
  costBasis: z.number().nullable().default(null),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type PortfolioHolding = z.infer<typeof portfolioHoldingSchema>;

export const portfolioSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  baseCurrency: z.string().length(3).default('USD'),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Portfolio = z.infer<typeof portfolioSchema>;

// ─── Tags ────────────────────────────────────────────────────────────────────

export const tagSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string().min(1),
  /** Hex colour used by the UI chip. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#6366f1'),
  createdAt: z.date(),
});
export type Tag = z.infer<typeof tagSchema>;

/** A coin joined with the per-user context the UI needs to render a row. */
export interface TrackedCoin {
  coin: Coin;
  isPinned: boolean;
  position: number;
  tags: Tag[];
}
