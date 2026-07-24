import {
  IMPACT_IMPORTANCE_FLOOR,
  type EventCategory,
  type ImpactLevel,
  type SentimentLabel,
} from '../domain/enums.js';
import { AUTHOR_ROLE_WEIGHT, type AuthorRole } from '../domain/content.js';
import { clamp, logNormalize, timeDecay, toScore100, weightedScore } from '../utils/math.js';

/**
 * Deterministic scoring.
 *
 * The LLM proposes; this module decides. Keeping the final numbers in pure,
 * tested code rather than trusting whatever an 8B model emits buys three things:
 * scores are reproducible, they are comparable across coins and across days, and
 * they do not silently drift when someone swaps the model. The model's opinion
 * enters as one weighted input among several.
 */

// ─── Importance ──────────────────────────────────────────────────────────────

/**
 * Structural prior per category, on [0,100], before any content is considered.
 * An exchange listing is inherently more market-moving than a forum post; that
 * fact should not depend on how excitedly the headline was written.
 */
export const CATEGORY_IMPORTANCE_PRIOR: Readonly<Record<EventCategory, number>> = Object.freeze({
  SECURITY: 88,
  REGULATORY: 78,
  EXCHANGE_LISTING: 76,
  TOKENOMICS: 62,
  GOVERNANCE: 58,
  WHALE: 60,
  LIQUIDATION: 55,
  ONCHAIN: 50,
  DERIVATIVES: 48,
  PARTNERSHIP: 55,
  NEWS: 50,
  MARKET_STRUCTURE: 45,
  DEVELOPMENT: 42,
  PRICE_ACTION: 40,
  MACRO: 45,
  SOCIAL: 30,
  OTHER: 25,
});

export interface ImportanceInput {
  category: EventCategory;
  /** Source credibility on [0,1]. */
  sourceCredibility: number;
  /** LLM importance estimate on [1,100], when enrichment has run. */
  modelImportance?: number | null;
  /** Connector-supplied prior on [1,100] (e.g. "this is a Binance listing"). */
  connectorHint?: number | null;
  /**
   * Magnitude of the underlying quantity in USD (transfer size, liquidation
   * size, market cap of the affected asset). Log-normalised.
   */
  magnitudeUsd?: number | null;
  /** Author authority, for social/blog items. */
  authorRole?: AuthorRole | null;
  /** Engagement on [0,1] for social items. */
  engagement?: number | null;
  /** Number of independent sources reporting the same story. */
  corroborationCount?: number;
  /** Age of the event; older news is less actionable. */
  ageMs?: number;
}

/**
 * Composite importance on [1,100].
 *
 * Weights were chosen so that no single input can dominate: a maximally
 * confident model cannot push a SOCIAL item into "critical" territory on its
 * own, and a high-credibility source cannot rescue a trivial one.
 */
export function computeImportance(input: ImportanceInput): number {
  const prior = CATEGORY_IMPORTANCE_PRIOR[input.category];

  const magnitude =
    input.magnitudeUsd != null && input.magnitudeUsd > 0
      ? // $1M is the midpoint: that is the default whale threshold.
        logNormalize(input.magnitudeUsd, 1_000_000, 1.2) * 100
      : null;

  const authority = input.authorRole != null ? AUTHOR_ROLE_WEIGHT[input.authorRole] * 100 : null;

  // Corroboration saturates fast: 3 independent outlets is strong, 30 is not
  // 10x stronger — it just means the story got picked up.
  const corroboration =
    input.corroborationCount != null && input.corroborationCount > 1
      ? clamp(50 + Math.log2(input.corroborationCount) * 18, 0, 100)
      : null;

  const base = weightedScore([
    { value: prior, weight: 3 },
    { value: input.modelImportance ?? null, weight: 2.5 },
    { value: input.connectorHint ?? null, weight: 2 },
    { value: magnitude, weight: 2 },
    { value: authority, weight: 1.2 },
    { value: input.engagement != null ? input.engagement * 100 : null, weight: 1 },
    { value: corroboration, weight: 1.5 },
    { value: input.sourceCredibility * 100, weight: 1.5 },
  ]);

  if (base === null) return 1;

  // Recency multiplier: 24h half-life, floored at 0.6 so genuinely important
  // older events stay visible instead of decaying into the noise.
  const decay = input.ageMs != null ? Math.max(0.6, timeDecay(input.ageMs, 86_400_000)) : 1;

  return Math.max(1, toScore100(base * decay));
}

/**
 * Map an importance score to a market-impact bucket.
 * The thresholds are the single source of truth shared with the UI legend.
 */
export function importanceToImpact(importance: number): ImpactLevel {
  const score = clamp(importance, 0, 100);
  if (score >= IMPACT_IMPORTANCE_FLOOR.CRITICAL) return 'CRITICAL';
  if (score >= IMPACT_IMPORTANCE_FLOOR.HIGH) return 'HIGH';
  if (score >= IMPACT_IMPORTANCE_FLOOR.MEDIUM) return 'MEDIUM';
  return 'LOW';
}

/**
 * Confidence on [1,100]: how much we trust our own assessment.
 *
 * Deliberately independent of importance — "probably catastrophic, but from one
 * anonymous account" must be representable, and is exactly the case where a
 * trader wants to see low confidence rather than a hedged importance score.
 */
export function computeConfidence(input: {
  sourceCredibility: number;
  modelConfidence?: number | null;
  corroborationCount?: number;
  /** Whether the lexicon and the model agreed on direction. */
  signalsAgree?: boolean;
  /** True when the underlying record has verifiable on-chain/exchange data. */
  hasHardData?: boolean;
}): number {
  const corroboration =
    input.corroborationCount != null && input.corroborationCount > 1
      ? clamp(40 + Math.log2(input.corroborationCount) * 20, 0, 100)
      : null;

  const base = weightedScore([
    { value: input.sourceCredibility * 100, weight: 3 },
    { value: input.modelConfidence ?? null, weight: 2 },
    { value: corroboration, weight: 2 },
    { value: input.hasHardData ? 95 : null, weight: 2.5 },
  ]);

  if (base === null) return 30;
  // Contradictory signals cap confidence hard.
  const penalty = input.signalsAgree === false ? 0.65 : 1;
  return Math.max(1, toScore100(base * penalty));
}

// ─── Social scoring ──────────────────────────────────────────────────────────

export interface EngagementInput {
  likes: number;
  reposts: number;
  replies: number;
  views?: number | null;
  followers?: number | null;
}

/**
 * Normalised engagement on [0,1].
 *
 * Reposts are weighted highest (they carry reach), replies next (they signal
 * genuine discussion, including argument), likes lowest. The result is
 * *relative to the author's audience* when follower count is known, which stops
 * mega-accounts from occupying every trending slot with routine posts.
 */
export function computeEngagement(input: EngagementInput): number {
  const raw = input.likes + input.reposts * 3 + input.replies * 2;
  if (raw <= 0) return 0;

  if (input.followers != null && input.followers > 100) {
    // Engagement rate against audience size. 1% is strong on X, so that is the
    // logistic midpoint.
    const rate = raw / input.followers;
    return clamp(logNormalize(rate, 0.01, 1.5), 0, 1);
  }

  if (input.views != null && input.views > 0) {
    return clamp(logNormalize(raw / input.views, 0.02, 1.5), 0, 1);
  }

  // No denominator available: fall back to absolute volume, midpoint 500.
  return clamp(logNormalize(raw, 500, 1), 0, 1);
}

/**
 * Trending score on [0,100] combining how *unusual* current chatter is
 * (velocity) with how much of it there is (volume) and who is doing the talking.
 *
 * Velocity is the dominant term on purpose: 40 mentions for a coin that normally
 * gets 2 is a far more useful alert than 4,000 mentions for Bitcoin.
 */
export function computeTrendingScore(input: {
  /** Mentions in the current window relative to the trailing baseline. */
  velocity: number | null;
  mentions: number;
  uniqueAuthors: number;
  meanEngagement: number | null;
}): number {
  const velocityComponent =
    input.velocity != null && Number.isFinite(input.velocity)
      ? // 3x normal maps to ~0.5.
        logNormalize(Math.max(input.velocity, 0.01), 3, 1.4) * 100
      : null;

  const volumeComponent = input.mentions > 0 ? logNormalize(input.mentions, 50, 1) * 100 : 0;

  // Breadth guards against a single account spamming 200 posts.
  const breadthComponent =
    input.mentions > 0
      ? clamp((input.uniqueAuthors / Math.max(input.mentions, 1)) * 100, 0, 100)
      : 0;

  const score = weightedScore([
    { value: velocityComponent, weight: 4 },
    { value: volumeComponent, weight: 2 },
    { value: breadthComponent, weight: 1.5 },
    { value: input.meanEngagement != null ? input.meanEngagement * 100 : null, weight: 1.5 },
  ]);

  return score === null ? 0 : toScore100(score);
}

// ─── Development activity ────────────────────────────────────────────────────

/**
 * Development-activity score on [0,100].
 *
 * Commit count alone is trivially gameable (and misleading for projects that
 * squash-merge), so contributor breadth and release cadence carry real weight.
 * Stars are included but deliberately down-weighted: they measure attention,
 * not engineering.
 */
export function computeDevActivityScore(input: {
  commits30d: number | null;
  contributors30d: number | null;
  releases90d: number | null;
  openIssues: number | null;
  stars: number | null;
  /** Days since the most recent commit. */
  daysSinceLastCommit: number | null;
}): number {
  const commits =
    input.commits30d != null ? logNormalize(Math.max(input.commits30d, 0.5), 60, 1) * 100 : null;
  const contributors =
    input.contributors30d != null
      ? logNormalize(Math.max(input.contributors30d, 0.5), 8, 1.2) * 100
      : null;
  const releases =
    input.releases90d != null ? logNormalize(Math.max(input.releases90d, 0.5), 4, 1.2) * 100 : null;
  const stars =
    input.stars != null ? logNormalize(Math.max(input.stars, 1), 3_000, 0.8) * 100 : null;

  // Freshness: full marks within a week, decaying to ~0 by a quarter.
  const freshness =
    input.daysSinceLastCommit != null
      ? clamp(100 - Math.max(0, input.daysSinceLastCommit - 7) * (100 / 83), 0, 100)
      : null;

  const score = weightedScore([
    { value: commits, weight: 3 },
    { value: contributors, weight: 3 },
    { value: releases, weight: 2 },
    { value: freshness, weight: 2.5 },
    { value: stars, weight: 1 },
  ]);

  return score === null ? 0 : toScore100(score);
}

// ─── Whale activity ──────────────────────────────────────────────────────────

/**
 * Whale-activity score on [0,100] for a window of large transfers.
 *
 * Direction matters more than gross volume: $50M moving onto exchanges is a
 * different signal from $50M moving into cold storage, so net flow drives the
 * result and gross volume only scales the confidence in it.
 */
export function computeWhaleActivityScore(input: {
  inflowUsd: number;
  outflowUsd: number;
  transferCount: number;
  /** Market cap, to judge whether the flow is material for this asset. */
  marketCapUsd: number | null;
}): { score: number; netFlowUsd: number; sentiment: SentimentLabel } {
  const netFlowUsd = input.outflowUsd - input.inflowUsd;
  const grossUsd = input.inflowUsd + input.outflowUsd;

  const materiality =
    input.marketCapUsd != null && input.marketCapUsd > 0
      ? clamp((grossUsd / input.marketCapUsd) * 100, 0, 1) // 1% of cap = full marks
      : logNormalize(grossUsd, 10_000_000, 1);

  const volumeComponent = grossUsd > 0 ? logNormalize(grossUsd, 5_000_000, 1) * 100 : 0;
  const countComponent =
    input.transferCount > 0 ? logNormalize(input.transferCount, 10, 1) * 100 : 0;

  const score = weightedScore([
    { value: volumeComponent, weight: 3 },
    { value: materiality * 100, weight: 3 },
    { value: countComponent, weight: 1.5 },
  ]);

  // Exchange inflows are distribution (bearish), outflows are accumulation.
  const bias = grossUsd === 0 ? 0 : netFlowUsd / grossUsd;
  const sentiment: SentimentLabel =
    bias > 0.5
      ? 'VERY_BULLISH'
      : bias > 0.15
        ? 'BULLISH'
        : bias < -0.5
          ? 'VERY_BEARISH'
          : bias < -0.15
            ? 'BEARISH'
            : 'NEUTRAL';

  return { score: score === null ? 0 : toScore100(score), netFlowUsd, sentiment };
}
