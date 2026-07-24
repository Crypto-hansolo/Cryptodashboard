import { z } from 'zod';
import { chainSchema, onchainEventTypeSchema, proposalStateSchema } from './enums.js';

/**
 * Editorial, social, on-chain, development, governance and tokenomics records.
 *
 * Each of these carries the source-specific fidelity that the generic `Event`
 * row cannot, and each points back at its Event via `eventId` so the timeline
 * and the detail panes stay in sync.
 */

// ─── News ────────────────────────────────────────────────────────────────────

export const newsArticleSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  sourceId: z.string(),
  title: z.string().min(1),
  author: z.string().nullable().default(null),
  publishedAt: z.date(),
  url: z.string().min(1),
  /** Raw excerpt from the feed, before AI summarisation. */
  excerpt: z.string().nullable().default(null),
  content: z.string().nullable().default(null),
  imageUrl: z.string().nullable().default(null),
  language: z.string().length(2).default('en'),
  tags: z.array(z.string()).default([]),
  /** Coins the matcher found in the text, primary subject first. */
  coinIds: z.array(z.string()).default([]),
});
export type NewsArticle = z.infer<typeof newsArticleSchema>;

// ─── Social ──────────────────────────────────────────────────────────────────

export const SOCIAL_PLATFORMS = [
  'X',
  'REDDIT',
  'TELEGRAM',
  'DISCORD',
  'FARCASTER',
  'LENS',
  'YOUTUBE',
  'TIKTOK',
  'GITHUB',
] as const;
export const socialPlatformSchema = z.enum(SOCIAL_PLATFORMS);
export type SocialPlatform = z.infer<typeof socialPlatformSchema>;

/**
 * How much weight an author's posts carry. Founders and core devs saying
 * something is categorically different from an anonymous account saying it,
 * and importance scoring leans on this hard.
 */
export const AUTHOR_ROLES = [
  'FOUNDER',
  'CORE_DEV',
  'TEAM',
  'COMMUNITY_MANAGER',
  'INFLUENCER',
  'EXCHANGE',
  'MEDIA',
  'ANONYMOUS',
] as const;
export const authorRoleSchema = z.enum(AUTHOR_ROLES);
export type AuthorRole = z.infer<typeof authorRoleSchema>;

export const AUTHOR_ROLE_WEIGHT: Readonly<Record<AuthorRole, number>> = Object.freeze({
  FOUNDER: 1,
  CORE_DEV: 0.9,
  TEAM: 0.8,
  EXCHANGE: 0.85,
  COMMUNITY_MANAGER: 0.6,
  MEDIA: 0.6,
  INFLUENCER: 0.5,
  ANONYMOUS: 0.25,
});

export const socialAuthorSchema = z.object({
  id: z.string(),
  platform: socialPlatformSchema,
  /** Platform-native id; stable across handle changes where the API provides it. */
  externalId: z.string().min(1),
  handle: z.string().min(1),
  displayName: z.string().nullable().default(null),
  role: authorRoleSchema.default('ANONYMOUS'),
  isVerified: z.boolean().default(false),
  followers: z.number().int().nonnegative().nullable().default(null),
  /** Coins this author is affiliated with (a founder of, a dev on). */
  affiliatedCoinIds: z.array(z.string()).default([]),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type SocialAuthor = z.infer<typeof socialAuthorSchema>;

export const socialPostSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  sourceId: z.string(),
  platform: socialPlatformSchema,
  externalId: z.string().min(1),
  authorId: z.string().nullable().default(null),
  authorHandle: z.string().nullable().default(null),
  postedAt: z.date(),
  text: z.string(),
  url: z.string().nullable().default(null),
  likes: z.number().int().nonnegative().default(0),
  reposts: z.number().int().nonnegative().default(0),
  replies: z.number().int().nonnegative().default(0),
  views: z.number().int().nonnegative().nullable().default(null),
  /** Normalised engagement on [0,1] — see services/scoring.ts. */
  engagementScore: z.number().min(0).max(1).nullable().default(null),
  hashtags: z.array(z.string()).default([]),
  coinIds: z.array(z.string()).default([]),
});
export type SocialPost = z.infer<typeof socialPostSchema>;

/** Per-coin, per-platform aggregate. Powers the social-activity chart. */
export const socialMetricSchema = z.object({
  id: z.string(),
  coinId: z.string(),
  platform: socialPlatformSchema,
  observedAt: z.date(),
  /** Window the aggregate covers, in minutes. */
  windowMinutes: z.number().int().positive(),
  mentions: z.number().int().nonnegative(),
  uniqueAuthors: z.number().int().nonnegative(),
  totalEngagement: z.number().nonnegative(),
  /** Mean sentiment across the window on [-1,1]. */
  sentimentScore: z.number().min(-1).max(1).nullable().default(null),
  /** Mentions relative to the trailing baseline: 1 = normal, 5 = 5x spike. */
  velocity: z.number().nonnegative().nullable().default(null),
  trendingScore: z.number().min(0).max(100).nullable().default(null),
  topHashtags: z.array(z.string()).default([]),
});
export type SocialMetric = z.infer<typeof socialMetricSchema>;

// ─── On-chain ────────────────────────────────────────────────────────────────

export const WALLET_LABELS = [
  'EXCHANGE',
  'TREASURY',
  'FOUNDATION',
  'TEAM',
  'WHALE',
  'BRIDGE',
  'CONTRACT',
  'BURN',
  'STAKING',
  'MARKET_MAKER',
  'UNKNOWN',
] as const;
export const walletLabelSchema = z.enum(WALLET_LABELS);
export type WalletLabel = z.infer<typeof walletLabelSchema>;

export const walletSchema = z.object({
  id: z.string(),
  chain: chainSchema,
  address: z.string().min(1),
  label: walletLabelSchema.default('UNKNOWN'),
  /** Human name when known, e.g. "Binance 14", "Ethereum Foundation". */
  entityName: z.string().nullable().default(null),
  coinIds: z.array(z.string()).default([]),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Wallet = z.infer<typeof walletSchema>;

export const onchainEventSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  coinId: z.string(),
  sourceId: z.string(),
  type: onchainEventTypeSchema,
  occurredAt: z.date(),
  chain: chainSchema,
  txHash: z.string().nullable().default(null),
  blockNumber: z.number().int().nonnegative().nullable().default(null),
  fromAddress: z.string().nullable().default(null),
  toAddress: z.string().nullable().default(null),
  fromLabel: walletLabelSchema.nullable().default(null),
  toLabel: walletLabelSchema.nullable().default(null),
  amount: z.number().nonnegative().nullable().default(null),
  amountUsd: z.number().nonnegative().nullable().default(null),
  /** Free-form provider annotations (Arkham entity ids, Nansen labels, ...). */
  metadata: z.record(z.unknown()).default({}),
});
export type OnchainEvent = z.infer<typeof onchainEventSchema>;

/** Provider-computed on-chain analytics (Glassnode/Santiment/IntoTheBlock style). */
export const onchainMetricSchema = z.object({
  id: z.string(),
  coinId: z.string(),
  sourceId: z.string(),
  observedAt: z.date(),
  /** Provider metric key, e.g. `active_addresses_24h`, `mvrv_z_score`. */
  metric: z.string().min(1),
  value: z.number(),
  unit: z.string().nullable().default(null),
});
export type OnchainMetric = z.infer<typeof onchainMetricSchema>;

// ─── Development ─────────────────────────────────────────────────────────────

export const GITHUB_ACTIVITY_TYPES = [
  'COMMIT',
  'RELEASE',
  'PULL_REQUEST',
  'ISSUE',
  'FORK',
  'STAR_MILESTONE',
] as const;
export const githubActivityTypeSchema = z.enum(GITHUB_ACTIVITY_TYPES);
export type GithubActivityType = z.infer<typeof githubActivityTypeSchema>;

export const githubActivitySchema = z.object({
  id: z.string(),
  eventId: z.string(),
  coinId: z.string(),
  sourceId: z.string(),
  repo: z.string().min(1),
  type: githubActivityTypeSchema,
  occurredAt: z.date(),
  /** Commit SHA / PR number / release tag, depending on `type`. */
  externalId: z.string().min(1),
  title: z.string(),
  author: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  additions: z.number().int().nonnegative().nullable().default(null),
  deletions: z.number().int().nonnegative().nullable().default(null),
});
export type GithubActivity = z.infer<typeof githubActivitySchema>;

export const githubRepoSnapshotSchema = z.object({
  id: z.string(),
  coinId: z.string(),
  sourceId: z.string(),
  repo: z.string().min(1),
  observedAt: z.date(),
  stars: z.number().int().nonnegative(),
  forks: z.number().int().nonnegative(),
  openIssues: z.number().int().nonnegative(),
  watchers: z.number().int().nonnegative().nullable().default(null),
  commits30d: z.number().int().nonnegative().nullable().default(null),
  contributors30d: z.number().int().nonnegative().nullable().default(null),
  /** Composite 0-100 development-activity score; see services/scoring.ts. */
  activityScore: z.number().min(0).max(100).nullable().default(null),
});
export type GithubRepoSnapshot = z.infer<typeof githubRepoSnapshotSchema>;

// ─── Governance ──────────────────────────────────────────────────────────────

export const governanceProposalSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  coinId: z.string(),
  sourceId: z.string(),
  /** Governance venue: a Snapshot space, a Tally governor, a Cosmos chain id. */
  space: z.string().min(1),
  externalId: z.string().min(1),
  title: z.string().min(1),
  body: z.string().nullable().default(null),
  author: z.string().nullable().default(null),
  state: proposalStateSchema,
  createdAt: z.date(),
  startsAt: z.date().nullable().default(null),
  endsAt: z.date().nullable().default(null),
  url: z.string().nullable().default(null),
  choices: z.array(z.string()).default([]),
  /** Vote weight per choice, index-aligned with `choices`. */
  scores: z.array(z.number()).default([]),
  totalVotes: z.number().int().nonnegative().nullable().default(null),
  quorum: z.number().nonnegative().nullable().default(null),
});
export type GovernanceProposal = z.infer<typeof governanceProposalSchema>;

// ─── Tokenomics ──────────────────────────────────────────────────────────────

export const tokenUnlockSchema = z.object({
  id: z.string(),
  coinId: z.string(),
  sourceId: z.string(),
  unlockAt: z.date(),
  amount: z.number().nonnegative(),
  amountUsd: z.number().nonnegative().nullable().default(null),
  /** Share of circulating supply released, as a fraction. */
  pctOfCirculating: z.number().nonnegative().nullable().default(null),
  /** Recipient bucket: "team", "investors", "ecosystem", ... */
  category: z.string().nullable().default(null),
  isCliff: z.boolean().default(false),
  notes: z.string().nullable().default(null),
});
export type TokenUnlock = z.infer<typeof tokenUnlockSchema>;

export const tokenomicsSnapshotSchema = z.object({
  id: z.string(),
  coinId: z.string(),
  sourceId: z.string(),
  observedAt: z.date(),
  /** Annualised inflation as a fraction (0.043 = 4.3%). */
  inflationRate: z.number().nullable().default(null),
  emissions24h: z.number().nonnegative().nullable().default(null),
  burned24h: z.number().nonnegative().nullable().default(null),
  stakingApy: z.number().nullable().default(null),
  stakedSupply: z.number().nonnegative().nullable().default(null),
  stakedPct: z.number().min(0).max(1).nullable().default(null),
  validatorCount: z.number().int().nonnegative().nullable().default(null),
  treasuryUsd: z.number().nonnegative().nullable().default(null),
  /** Total value locked, for protocol tokens. */
  tvlUsd: z.number().nonnegative().nullable().default(null),
});
export type TokenomicsSnapshot = z.infer<typeof tokenomicsSnapshotSchema>;
