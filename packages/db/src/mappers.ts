import type {
  AlertTrigger,
  CandleInterval,
  Chain,
  Coin,
  Event,
  Intelligence,
  LiquidityPool,
  MarketQuote,
  OnchainEvent,
  Trade,
  Wallet,
} from '@cid/core';
import { CHAINS } from '@cid/core';
import type {
  AlertTrigger as PrismaAlertTrigger,
  CandleInterval as PrismaCandleInterval,
  Coin as PrismaCoin,
  CoinContract,
  CoinIdentifier,
  Event as PrismaEvent,
  LiquidityPool as PrismaLiquidityPool,
  MarketSnapshot as PrismaMarketSnapshot,
  OnchainEvent as PrismaOnchainEvent,
  Trade as PrismaTrade,
  Wallet as PrismaWallet,
} from '@prisma/client';

/**
 * Narrow a database chain string to the `Chain` union.
 *
 * Chains are stored as free-form text rather than a Postgres enum on purpose:
 * new chains appear constantly, and adding one should not require a migration.
 * The cost is that reads must narrow, and an unrecognised value maps to `other`
 * instead of being asserted away — a row written by a newer version of the code
 * must not crash an older reader.
 */
const CHAIN_SET = new Set<string>(CHAINS);

export function toChain(value: string): Chain {
  return CHAIN_SET.has(value) ? (value as Chain) : 'other';
}

export function toChainOrNull(value: string | null): Chain | null {
  return value === null ? null : toChain(value);
}

/** Prisma's `JsonValue` includes null and scalars; our JSON columns are objects. */
function toJsonObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Translation between Prisma rows and domain objects.
 *
 * This layer exists so that `@cid/core` never imports `@prisma/client`. That
 * keeps the domain testable without a generated client, and means a schema
 * rename is contained here rather than rippling into scoring and alerting.
 *
 * It also absorbs two genuine representation mismatches:
 *  - Prisma enum members cannot begin with a digit, so candle intervals are
 *    `ONE_MINUTE` in the database and `'1m'` in the domain.
 *  - Prisma splits `Event`'s AI fields into flat columns, while the domain
 *    groups them under `intelligence` where they belong.
 */

// ─── Candle intervals ────────────────────────────────────────────────────────

const CANDLE_TO_PRISMA: Readonly<Record<CandleInterval, PrismaCandleInterval>> = {
  '1m': 'ONE_MINUTE',
  '5m': 'FIVE_MINUTES',
  '15m': 'FIFTEEN_MINUTES',
  '1h': 'ONE_HOUR',
  '4h': 'FOUR_HOURS',
  '1d': 'ONE_DAY',
  '1w': 'ONE_WEEK',
};

const PRISMA_TO_CANDLE: Readonly<Record<PrismaCandleInterval, CandleInterval>> = {
  ONE_MINUTE: '1m',
  FIVE_MINUTES: '5m',
  FIFTEEN_MINUTES: '15m',
  ONE_HOUR: '1h',
  FOUR_HOURS: '4h',
  ONE_DAY: '1d',
  ONE_WEEK: '1w',
};

export function toPrismaInterval(interval: CandleInterval): PrismaCandleInterval {
  return CANDLE_TO_PRISMA[interval];
}

export function fromPrismaInterval(interval: PrismaCandleInterval): CandleInterval {
  return PRISMA_TO_CANDLE[interval];
}

// ─── Coin ────────────────────────────────────────────────────────────────────

export type CoinRow = PrismaCoin & {
  identifiers?: CoinIdentifier[];
  contracts?: CoinContract[];
};

export function toCoin(row: CoinRow): Coin {
  return {
    id: row.id,
    slug: row.slug,
    symbol: row.symbol,
    name: row.name,
    coingeckoId: row.coingeckoId,
    coinmarketcapId: row.coinmarketcapId,
    chain: toChainOrNull(row.chain),
    imageUrl: row.imageUrl,
    description: row.description,
    websiteUrl: row.websiteUrl,
    githubRepos: row.githubRepos,
    twitterHandle: row.twitterHandle,
    subreddit: row.subreddit,
    snapshotSpaces: row.snapshotSpaces,
    marketCapRank: row.marketCapRank,
    categories: row.categories,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    contracts: (row.contracts ?? []).map((contract) => ({
      chain: toChain(contract.chain),
      address: contract.address,
      decimals: contract.decimals,
      isNative: contract.isNative,
    })),
    identifiers: (row.identifiers ?? []).map((identifier) => ({
      kind: identifier.kind,
      value: identifier.value,
      chain: toChainOrNull(identifier.chain),
    })),
  };
}

// ─── Event ───────────────────────────────────────────────────────────────────

export function toIntelligence(row: PrismaEvent): Intelligence {
  return {
    summary: row.summary,
    explanation: row.explanation,
    sentiment: row.sentiment,
    sentimentScore: row.sentimentScore,
    importance: row.importance,
    confidence: row.confidence,
    impact: row.impact,
    narratives: row.narratives,
    isFud: row.isFud,
    model: row.model,
    enrichedAt: row.enrichedAt,
  };
}

export function toEvent(row: PrismaEvent): Event {
  return {
    id: row.id,
    occurredAt: row.occurredAt,
    ingestedAt: row.ingestedAt,
    coinId: row.coinId,
    sourceId: row.sourceId,
    category: row.category,
    subtype: row.subtype,
    headline: row.headline,
    body: row.body,
    url: row.url,
    author: row.author,
    dedupeHash: row.dedupeHash,
    clusterId: row.clusterId,
    intelligence: toIntelligence(row),
    payload: toJsonObject(row.payload),
    relatedCoinIds: row.relatedCoinIds,
  };
}

// ─── Rows carrying a chain or a JSON column ──────────────────────────────────

export function toWallet(row: PrismaWallet): Wallet {
  return { ...row, chain: toChain(row.chain) };
}

export function toOnchainEvent(row: PrismaOnchainEvent): OnchainEvent {
  return {
    ...row,
    chain: toChain(row.chain),
    // BigInt does not survive JSON serialisation, and block heights are far
    // inside Number.MAX_SAFE_INTEGER for every chain we track.
    blockNumber: row.blockNumber === null ? null : Number(row.blockNumber),
    metadata: toJsonObject(row.metadata),
  };
}

export function toTrade(row: PrismaTrade): Trade {
  return { ...row, chain: toChainOrNull(row.chain) };
}

export function toLiquidityPool(row: PrismaLiquidityPool): LiquidityPool {
  return { ...row, chain: toChain(row.chain) };
}

export function toAlertTrigger(row: PrismaAlertTrigger): AlertTrigger {
  return { ...row, payload: toJsonObject(row.payload) };
}

/** Flatten a partial `Intelligence` into the column names Prisma expects. */
export function fromIntelligence(patch: Partial<Intelligence>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (patch.summary !== undefined) data.summary = patch.summary;
  if (patch.explanation !== undefined) data.explanation = patch.explanation;
  if (patch.sentiment !== undefined) data.sentiment = patch.sentiment;
  if (patch.sentimentScore !== undefined) data.sentimentScore = patch.sentimentScore;
  if (patch.importance !== undefined) data.importance = patch.importance;
  if (patch.confidence !== undefined) data.confidence = patch.confidence;
  if (patch.impact !== undefined) data.impact = patch.impact;
  if (patch.narratives !== undefined) data.narratives = patch.narratives;
  if (patch.isFud !== undefined) data.isFud = patch.isFud;
  if (patch.model !== undefined) data.model = patch.model;
  if (patch.enrichedAt !== undefined) data.enrichedAt = patch.enrichedAt;
  return data;
}

// ─── Market ──────────────────────────────────────────────────────────────────

export function toMarketQuote(row: PrismaMarketSnapshot): MarketQuote {
  return {
    coinId: row.coinId,
    priceUsd: row.priceUsd,
    marketCapUsd: row.marketCapUsd,
    volume24hUsd: row.volume24hUsd,
    fdvUsd: row.fdvUsd,
    priceChange1hPct: row.priceChange1hPct,
    priceChange24hPct: row.priceChange24hPct,
    priceChange7dPct: row.priceChange7dPct,
    observedAt: row.observedAt,
  };
}

// ─── Keyset pagination ───────────────────────────────────────────────────────

/**
 * Timeline cursors encode (occurredAt, id).
 *
 * Keyset, not OFFSET: at a few million events `OFFSET 100000` makes Postgres
 * walk and discard 100k rows per page, and rows arriving mid-scroll shift the
 * window so the user sees duplicates. A composite cursor is stable and O(1).
 * `id` breaks ties, since many events share a timestamp.
 */
export interface TimelineCursor {
  occurredAt: Date;
  id: string;
}

export function encodeCursor(cursor: TimelineCursor): string {
  return Buffer.from(`${cursor.occurredAt.toISOString()}|${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

/** Returns null for anything malformed — a bad cursor means "start from the top". */
export function decodeCursor(raw: string | null | undefined): TimelineCursor | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    if (separator <= 0) return null;
    const occurredAt = new Date(decoded.slice(0, separator));
    const id = decoded.slice(separator + 1);
    if (Number.isNaN(occurredAt.getTime()) || id === '') return null;
    return { occurredAt, id };
  } catch {
    return null;
  }
}
