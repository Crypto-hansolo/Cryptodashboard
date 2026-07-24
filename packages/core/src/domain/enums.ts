import { z } from 'zod';

/**
 * The shared vocabulary of the platform.
 *
 * These are declared as const object + zod schema pairs rather than TS `enum`s
 * so that the exact same values are used for (a) compile-time types,
 * (b) runtime validation of LLM output and API payloads, and (c) the Prisma
 * enums. `zod.enum` also gives us free parsing of untrusted strings, which
 * matters a lot when a local 8B model is asked to emit `"VERY_BULLISH"`.
 */

// ─── Sentiment ───────────────────────────────────────────────────────────────

export const SENTIMENT_LABELS = [
  'VERY_BEARISH',
  'BEARISH',
  'NEUTRAL',
  'BULLISH',
  'VERY_BULLISH',
] as const;

export const sentimentLabelSchema = z.enum(SENTIMENT_LABELS);
export type SentimentLabel = z.infer<typeof sentimentLabelSchema>;

/**
 * Canonical numeric anchor for each label, on [-1, 1].
 * Aggregation always happens in numeric space; labels are a presentation
 * concern. Keeping the mapping in one place stops the UI and the scoring
 * engine from disagreeing about what "bullish" means.
 */
export const SENTIMENT_SCORES: Readonly<Record<SentimentLabel, number>> = Object.freeze({
  VERY_BEARISH: -1,
  BEARISH: -0.5,
  NEUTRAL: 0,
  BULLISH: 0.5,
  VERY_BULLISH: 1,
});

// ─── Market impact ───────────────────────────────────────────────────────────

export const IMPACT_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const impactLevelSchema = z.enum(IMPACT_LEVELS);
export type ImpactLevel = z.infer<typeof impactLevelSchema>;

/** Lower bound of the importance score that each impact level implies. */
export const IMPACT_IMPORTANCE_FLOOR: Readonly<Record<ImpactLevel, number>> = Object.freeze({
  LOW: 0,
  MEDIUM: 40,
  HIGH: 65,
  CRITICAL: 85,
});

// ─── Event taxonomy ──────────────────────────────────────────────────────────

/**
 * Every ingested item normalises into exactly one category. The timeline,
 * alert rules and report generators all filter on this, so the list is
 * deliberately coarse — sub-typing lives in `Event.subtype`.
 */
export const EVENT_CATEGORIES = [
  'PRICE_ACTION',
  'MARKET_STRUCTURE',
  'DERIVATIVES',
  'LIQUIDATION',
  'EXCHANGE_LISTING',
  'NEWS',
  'SOCIAL',
  'ONCHAIN',
  'WHALE',
  'DEVELOPMENT',
  'GOVERNANCE',
  'TOKENOMICS',
  'SECURITY',
  'REGULATORY',
  'PARTNERSHIP',
  'MACRO',
  'OTHER',
] as const;

export const eventCategorySchema = z.enum(EVENT_CATEGORIES);
export type EventCategory = z.infer<typeof eventCategorySchema>;

// ─── Source taxonomy ─────────────────────────────────────────────────────────

export const SOURCE_KINDS = [
  'MARKET_DATA',
  'DERIVATIVES',
  'DEX',
  'NEWS',
  'BLOG',
  'SOCIAL',
  'FORUM',
  'VIDEO',
  'ONCHAIN',
  'ANALYTICS',
  'CODE',
  'GOVERNANCE',
  'INTERNAL',
] as const;

export const sourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof sourceKindSchema>;

// ─── Chains / asset namespaces ───────────────────────────────────────────────

export const CHAINS = [
  'ethereum',
  'arbitrum',
  'optimism',
  'base',
  'polygon',
  'bsc',
  'avalanche',
  'linea',
  'scroll',
  'zksync',
  'blast',
  'mantle',
  'cronos',
  'fantom',
  'gnosis',
  'celo',
  'solana',
  'bitcoin',
  'litecoin',
  'dogecoin',
  'cosmos',
  'osmosis',
  'celestia',
  'injective',
  'sei',
  'near',
  'aptos',
  'sui',
  'tron',
  'ton',
  'cardano',
  'polkadot',
  'ripple',
  'stellar',
  'algorand',
  'hedera',
  'other',
] as const;

export const chainSchema = z.enum(CHAINS);
export type Chain = z.infer<typeof chainSchema>;

/**
 * How a chain's addresses are shaped. Used by the identifier parser to decide
 * whether `0xabc…` or `EPjFW…` is a plausible contract address.
 */
export const ADDRESS_FORMAT_BY_CHAIN: Readonly<
  Record<Chain, 'evm' | 'base58' | 'bech32' | 'other'>
> = Object.freeze({
  ethereum: 'evm',
  arbitrum: 'evm',
  optimism: 'evm',
  base: 'evm',
  polygon: 'evm',
  bsc: 'evm',
  avalanche: 'evm',
  linea: 'evm',
  scroll: 'evm',
  zksync: 'evm',
  blast: 'evm',
  mantle: 'evm',
  cronos: 'evm',
  fantom: 'evm',
  gnosis: 'evm',
  celo: 'evm',
  solana: 'base58',
  bitcoin: 'other',
  litecoin: 'other',
  dogecoin: 'other',
  cosmos: 'bech32',
  osmosis: 'bech32',
  celestia: 'bech32',
  injective: 'bech32',
  sei: 'bech32',
  near: 'other',
  aptos: 'evm',
  sui: 'evm',
  tron: 'other',
  ton: 'other',
  cardano: 'bech32',
  polkadot: 'other',
  ripple: 'other',
  stellar: 'other',
  algorand: 'other',
  hedera: 'other',
  other: 'other',
});

export const EVM_CHAINS: readonly Chain[] = Object.freeze(
  CHAINS.filter((c) => ADDRESS_FORMAT_BY_CHAIN[c] === 'evm'),
);

// ─── Coin identifiers ────────────────────────────────────────────────────────

/**
 * The ways a user can name an asset. A single coin usually accumulates
 * several of these, which is why they live in their own table rather than as
 * columns on `Coin`.
 */
export const IDENTIFIER_KINDS = [
  'COINGECKO',
  'COINMARKETCAP',
  'SYMBOL',
  'CONTRACT',
  'SLUG',
  'CHAIN_NATIVE',
] as const;

export const identifierKindSchema = z.enum(IDENTIFIER_KINDS);
export type IdentifierKind = z.infer<typeof identifierKindSchema>;

// ─── On-chain event subtypes ─────────────────────────────────────────────────

export const ONCHAIN_EVENT_TYPES = [
  'WHALE_TRANSFER',
  'EXCHANGE_INFLOW',
  'EXCHANGE_OUTFLOW',
  'TREASURY_MOVEMENT',
  'FOUNDATION_MOVEMENT',
  'TOKEN_UNLOCK',
  'BRIDGE_TRANSFER',
  'STAKE',
  'UNSTAKE',
  'BURN',
  'MINT',
  'CONTRACT_UPGRADE',
  'CONTRACT_DEPLOY',
  'GOVERNANCE_ACTION',
  'LIQUIDITY_ADD',
  'LIQUIDITY_REMOVE',
] as const;

export const onchainEventTypeSchema = z.enum(ONCHAIN_EVENT_TYPES);
export type OnchainEventType = z.infer<typeof onchainEventTypeSchema>;

// ─── Governance ──────────────────────────────────────────────────────────────

export const PROPOSAL_STATES = [
  'PENDING',
  'ACTIVE',
  'PASSED',
  'FAILED',
  'QUEUED',
  'EXECUTED',
  'CANCELLED',
  'EXPIRED',
] as const;

export const proposalStateSchema = z.enum(PROPOSAL_STATES);
export type ProposalState = z.infer<typeof proposalStateSchema>;

// ─── Alerts & notifications ──────────────────────────────────────────────────

export const NOTIFICATION_CHANNELS = [
  'DESKTOP',
  'DISCORD',
  'TELEGRAM',
  'EMAIL',
  'WEBHOOK',
] as const;

export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export const DELIVERY_STATUSES = ['PENDING', 'SENT', 'FAILED', 'SUPPRESSED'] as const;
export const deliveryStatusSchema = z.enum(DELIVERY_STATUSES);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

// ─── Reports ─────────────────────────────────────────────────────────────────

export const REPORT_KINDS = [
  'HOURLY',
  'MORNING',
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'PORTFOLIO',
  'NARRATIVE',
  'ON_DEMAND',
] as const;

export const reportKindSchema = z.enum(REPORT_KINDS);
export type ReportKind = z.infer<typeof reportKindSchema>;

// ─── Collector telemetry ─────────────────────────────────────────────────────

export const RUN_STATUSES = ['SUCCESS', 'PARTIAL', 'FAILED', 'SKIPPED'] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;

// ─── Time ────────────────────────────────────────────────────────────────────

export const CANDLE_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'] as const;
export const candleIntervalSchema = z.enum(CANDLE_INTERVALS);
export type CandleInterval = z.infer<typeof candleIntervalSchema>;

export const CANDLE_INTERVAL_MS: Readonly<Record<CandleInterval, number>> = Object.freeze({
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
});
