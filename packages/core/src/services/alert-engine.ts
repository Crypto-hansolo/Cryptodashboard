import type { Alert, AlertRule } from '../domain/alert.js';
import type { Event } from '../domain/event.js';
import type { DerivativesSnapshot, MarketQuote } from '../domain/market.js';
import type { SocialMetric, SocialPost, OnchainEvent, TokenUnlock } from '../domain/content.js';
import type { GovernanceProposal } from '../domain/content.js';
import { pctChange } from '../utils/math.js';
import { sentimentDelta } from './sentiment.js';

/**
 * Alert evaluation.
 *
 * Rules are evaluated against typed *signals* rather than against the database.
 * Two consequences, both deliberate: evaluation is a pure function (so the whole
 * rule matrix is unit-testable without fixtures), and the worker can evaluate
 * every rule against an in-flight signal the moment it is produced, instead of
 * polling. That is what keeps alert latency inside the ~1 minute target.
 *
 * Adding a rule type = add a variant in domain/alert.ts + a case here. The
 * `satisfies` check on ALERT_RULE_TYPES and the exhaustive switch below mean the
 * compiler finds every place that needs updating.
 */

export type AlertSignal =
  | { kind: 'event'; event: Event; sourceKey: string; coinId: string | null }
  | {
      kind: 'market';
      coinId: string;
      current: MarketQuote;
      /** Reference quote `windowMinutes` ago, for change rules. */
      reference: MarketQuote | null;
      /** Trailing mean 24h volume, for spike detection. */
      baselineVolumeUsd: number | null;
    }
  | { kind: 'derivatives'; coinId: string; snapshot: DerivativesSnapshot }
  | {
      kind: 'social';
      coinId: string;
      metric: SocialMetric;
      /** Same window, one period earlier — for sentiment shift. */
      previous: SocialMetric | null;
    }
  | { kind: 'socialPost'; coinId: string | null; post: SocialPost; isVerified: boolean }
  | { kind: 'onchain'; coinId: string; onchain: OnchainEvent }
  | { kind: 'unlock'; coinId: string; unlock: TokenUnlock; circulatingSupply: number | null }
  | { kind: 'governance'; coinId: string; proposal: GovernanceProposal }
  | {
      kind: 'listing';
      coinId: string;
      venue: string;
      symbol: string;
      url: string | null;
      detectedAt: Date;
    }
  | {
      kind: 'release';
      coinId: string;
      repo: string;
      tag: string;
      title: string;
      url: string | null;
      publishedAt: Date;
    };

export type SignalKind = AlertSignal['kind'];

export interface AlertMatch {
  title: string;
  message: string;
  /** The value that crossed the threshold, for display. */
  observedValue: number | null;
  coinId: string | null;
  eventId: string | null;
  payload: Record<string, unknown>;
}

/** Which signal kinds each rule type can consume. Lets the worker skip cheaply. */
export const RULE_SIGNAL_KINDS: Readonly<Record<AlertRule['type'], readonly SignalKind[]>> =
  Object.freeze({
    PRICE_CHANGE: ['market'],
    PRICE_LEVEL: ['market'],
    VOLUME_SPIKE: ['market'],
    EVENT_MATCH: ['event'],
    EXCHANGE_LISTING: ['listing'],
    GITHUB_RELEASE: ['release'],
    WHALE_TRANSFER: ['onchain'],
    TOKEN_UNLOCK: ['unlock'],
    GOVERNANCE_PROPOSAL: ['governance'],
    SENTIMENT_SHIFT: ['social'],
    FUNDING_RATE: ['derivatives'],
    SOCIAL_VELOCITY: ['social'],
    AUTHOR_POST: ['socialPost'],
    BREAKING_NEWS: ['event'],
  });

/** `coinIds: []` means "any coin". */
function inScope(coinIds: readonly string[], coinId: string | null): boolean {
  if (coinIds.length === 0) return true;
  return coinId !== null && coinIds.includes(coinId);
}

function fmtUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toPrecision(4)}`;
}

function fmtPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function matchesDirection(change: number, direction: 'UP' | 'DOWN' | 'ANY'): boolean {
  if (direction === 'UP') return change > 0;
  if (direction === 'DOWN') return change < 0;
  return true;
}

/**
 * Evaluate a single rule against a single signal.
 * Returns `null` when the rule does not apply or does not fire.
 */
export function evaluateRule(rule: AlertRule, signal: AlertSignal): AlertMatch | null {
  // Cheap gate: skip rules that structurally cannot consume this signal.
  if (!RULE_SIGNAL_KINDS[rule.type].includes(signal.kind)) return null;

  switch (rule.type) {
    case 'PRICE_CHANGE': {
      if (signal.kind !== 'market') return null;
      if (!inScope(rule.coinIds, signal.coinId)) return null;
      if (!signal.reference) return null;

      const change = pctChange(signal.reference.priceUsd, signal.current.priceUsd);
      if (change === null) return null;
      if (Math.abs(change) < rule.thresholdPct) return null;
      if (!matchesDirection(change, rule.direction)) return null;

      return {
        title: `Price moved ${fmtPct(change)}`,
        message:
          `Price changed ${fmtPct(change)} over ${rule.windowMinutes}m ` +
          `(${fmtUsd(signal.reference.priceUsd)} → ${fmtUsd(signal.current.priceUsd)}).`,
        observedValue: change,
        coinId: signal.coinId,
        eventId: null,
        payload: {
          from: signal.reference.priceUsd,
          to: signal.current.priceUsd,
          windowMinutes: rule.windowMinutes,
        },
      };
    }

    case 'PRICE_LEVEL': {
      if (signal.kind !== 'market') return null;
      if (!inScope(rule.coinIds, signal.coinId)) return null;

      const price = signal.current.priceUsd;
      const crossed = rule.comparator === 'ABOVE' ? price > rule.price : price < rule.price;
      if (!crossed) return null;

      // Require an actual crossing when we know the previous price. Without this
      // the alert re-fires on every tick while the condition holds, and the
      // cooldown becomes the only thing standing between the user and a flood.
      if (signal.reference) {
        const wasAlready =
          rule.comparator === 'ABOVE'
            ? signal.reference.priceUsd > rule.price
            : signal.reference.priceUsd < rule.price;
        if (wasAlready) return null;
      }

      return {
        title: `Price ${rule.comparator === 'ABOVE' ? 'above' : 'below'} ${fmtUsd(rule.price)}`,
        message: `Price is ${fmtUsd(price)}, crossing the ${fmtUsd(rule.price)} threshold.`,
        observedValue: price,
        coinId: signal.coinId,
        eventId: null,
        payload: { price, threshold: rule.price, comparator: rule.comparator },
      };
    }

    case 'VOLUME_SPIKE': {
      if (signal.kind !== 'market') return null;
      if (!inScope(rule.coinIds, signal.coinId)) return null;

      const volume = signal.current.volume24hUsd;
      const baseline = signal.baselineVolumeUsd;
      if (volume === null || baseline === null || baseline <= 0) return null;

      const ratio = volume / baseline;
      if (ratio < rule.multiplier) return null;

      return {
        title: `Volume spike ${ratio.toFixed(1)}x`,
        message: `24h volume is ${fmtUsd(volume)}, ${ratio.toFixed(1)}x the recent baseline of ${fmtUsd(baseline)}.`,
        observedValue: ratio,
        coinId: signal.coinId,
        eventId: null,
        payload: { volume, baseline, ratio },
      };
    }

    case 'EVENT_MATCH': {
      if (signal.kind !== 'event') return null;
      const { event } = signal;
      if (!inScope(rule.coinIds, signal.coinId)) return null;

      if (rule.categories.length > 0 && !rule.categories.includes(event.category)) return null;
      if (rule.sourceKeys.length > 0 && !rule.sourceKeys.includes(signal.sourceKey)) return null;
      if (
        rule.subtypes.length > 0 &&
        (event.subtype === null || !rule.subtypes.includes(event.subtype))
      ) {
        return null;
      }

      const { sentiment, impact, importance } = event.intelligence;
      if (
        rule.sentiments.length > 0 &&
        (sentiment === null || !rule.sentiments.includes(sentiment))
      )
        return null;
      if (rule.impacts.length > 0 && (impact === null || !rule.impacts.includes(impact)))
        return null;
      if (rule.minImportance !== null && (importance === null || importance < rule.minImportance))
        return null;

      if (rule.keywords.length > 0) {
        const haystack = `${event.headline} ${event.body ?? ''}`.toLowerCase();
        const hit = rule.keywords.some((kw) => haystack.includes(kw.toLowerCase()));
        if (!hit) return null;
      }

      return {
        title: event.headline,
        message: event.intelligence.summary ?? event.headline,
        observedValue: importance,
        coinId: signal.coinId,
        eventId: event.id,
        payload: { category: event.category, subtype: event.subtype, url: event.url },
      };
    }

    case 'BREAKING_NEWS': {
      if (signal.kind !== 'event') return null;
      const { event } = signal;
      if (!inScope(rule.coinIds, signal.coinId)) return null;
      // Editorial + regulatory + security are what "breaking news" means here;
      // a price tick clearing an importance bar is not news.
      const newsy: readonly Event['category'][] = ['NEWS', 'SECURITY', 'REGULATORY', 'PARTNERSHIP'];
      if (!newsy.includes(event.category)) return null;

      const importance = event.intelligence.importance;
      if (importance === null || importance < rule.minImportance) return null;

      return {
        title: `Breaking: ${event.headline}`,
        message: event.intelligence.summary ?? event.headline,
        observedValue: importance,
        coinId: signal.coinId,
        eventId: event.id,
        payload: { url: event.url, importance },
      };
    }

    case 'EXCHANGE_LISTING': {
      if (signal.kind !== 'listing') return null;
      if (!inScope(rule.coinIds, signal.coinId)) return null;
      if (
        rule.venues.length > 0 &&
        !rule.venues.some((v) => v.toLowerCase() === signal.venue.toLowerCase())
      ) {
        return null;
      }

      return {
        title: `New listing on ${signal.venue}`,
        message: `${signal.symbol} is now trading on ${signal.venue}.`,
        observedValue: null,
        coinId: signal.coinId,
        eventId: null,
        payload: { venue: signal.venue, symbol: signal.symbol, url: signal.url },
      };
    }

    case 'GITHUB_RELEASE': {
      if (signal.kind !== 'release') return null;
      if (!inScope(rule.coinIds, signal.coinId)) return null;
      if (
        rule.repos.length > 0 &&
        !rule.repos.some((r) => r.toLowerCase() === signal.repo.toLowerCase())
      ) {
        return null;
      }

      return {
        title: `${signal.repo} released ${signal.tag}`,
        message: signal.title || `New release ${signal.tag} in ${signal.repo}.`,
        observedValue: null,
        coinId: signal.coinId,
        eventId: null,
        payload: { repo: signal.repo, tag: signal.tag, url: signal.url },
      };
    }

    case 'WHALE_TRANSFER': {
      if (signal.kind !== 'onchain') return null;
      if (!inScope(rule.coinIds, signal.coinId)) return null;
      if (rule.types.length > 0 && !rule.types.includes(signal.onchain.type)) return null;

      const amountUsd = signal.onchain.amountUsd;
      if (amountUsd === null || amountUsd < rule.minUsd) return null;

      const direction =
        signal.onchain.toLabel === 'EXCHANGE'
          ? ' into an exchange'
          : signal.onchain.fromLabel === 'EXCHANGE'
            ? ' out of an exchange'
            : '';

      return {
        title: `Whale transfer ${fmtUsd(amountUsd)}${direction}`,
        message:
          `${signal.onchain.type.replace(/_/g, ' ').toLowerCase()} of ${fmtUsd(amountUsd)} ` +
          `on ${signal.onchain.chain}${direction}.`,
        observedValue: amountUsd,
        coinId: signal.coinId,
        eventId: signal.onchain.eventId,
        payload: {
          txHash: signal.onchain.txHash,
          from: signal.onchain.fromAddress,
          to: signal.onchain.toAddress,
          type: signal.onchain.type,
        },
      };
    }

    case 'TOKEN_UNLOCK': {
      if (signal.kind !== 'unlock') return null;
      if (!inScope(rule.coinIds, signal.coinId)) return null;

      // Prefer the stored share of circulating supply; derive it when absent.
      const pct =
        signal.unlock.pctOfCirculating ??
        (signal.circulatingSupply && signal.circulatingSupply > 0
          ? signal.unlock.amount / signal.circulatingSupply
          : null);
      if (pct === null || pct < rule.minPctOfCirculating) return null;

      return {
        title: `Token unlock in ${rule.leadTimeHours}h`,
        message:
          `${(pct * 100).toFixed(2)}% of circulating supply unlocks at ` +
          `${signal.unlock.unlockAt.toISOString()}` +
          `${signal.unlock.amountUsd !== null ? ` (${fmtUsd(signal.unlock.amountUsd)})` : ''}.`,
        observedValue: pct * 100,
        coinId: signal.coinId,
        eventId: null,
        payload: {
          unlockAt: signal.unlock.unlockAt.toISOString(),
          amount: signal.unlock.amount,
          category: signal.unlock.category,
        },
      };
    }

    case 'GOVERNANCE_PROPOSAL': {
      if (signal.kind !== 'governance') return null;
      if (!inScope(rule.coinIds, signal.coinId)) return null;
      if (rule.states.length > 0 && !rule.states.includes(signal.proposal.state)) return null;

      return {
        title: `Governance: ${signal.proposal.title}`,
        message: `Proposal in ${signal.proposal.space} is ${signal.proposal.state}.`,
        observedValue: null,
        coinId: signal.coinId,
        eventId: signal.proposal.eventId,
        payload: {
          space: signal.proposal.space,
          state: signal.proposal.state,
          url: signal.proposal.url,
        },
      };
    }

    case 'SENTIMENT_SHIFT': {
      if (signal.kind !== 'social') return null;
      if (!inScope(rule.coinIds, signal.coinId)) return null;

      const delta = sentimentDelta(
        signal.previous?.sentimentScore ?? null,
        signal.metric.sentimentScore,
      );
      if (delta === null || Math.abs(delta) < rule.minDelta) return null;
      if (!matchesDirection(delta, rule.direction)) return null;

      return {
        title: `Sentiment shifted ${delta > 0 ? 'bullish' : 'bearish'}`,
        message:
          `Mean sentiment moved by ${delta.toFixed(2)} on ${signal.metric.platform} ` +
          `over the last ${signal.metric.windowMinutes}m.`,
        observedValue: delta,
        coinId: signal.coinId,
        eventId: null,
        payload: {
          platform: signal.metric.platform,
          from: signal.previous?.sentimentScore ?? null,
          to: signal.metric.sentimentScore,
        },
      };
    }

    case 'FUNDING_RATE': {
      if (signal.kind !== 'derivatives') return null;
      if (!inScope(rule.coinIds, signal.coinId)) return null;

      const rate = signal.snapshot.fundingRate;
      if (rate === null) return null;
      const crossed = rule.comparator === 'ABOVE' ? rate > rule.threshold : rate < rule.threshold;
      if (!crossed) return null;

      return {
        title: `Funding rate ${(rate * 100).toFixed(4)}%`,
        message:
          `Funding on ${signal.snapshot.instrument} is ${(rate * 100).toFixed(4)}%, ` +
          `${rule.comparator === 'ABOVE' ? 'above' : 'below'} the ${(rule.threshold * 100).toFixed(4)}% threshold.`,
        observedValue: rate,
        coinId: signal.coinId,
        eventId: null,
        payload: { instrument: signal.snapshot.instrument, fundingRate: rate },
      };
    }

    case 'SOCIAL_VELOCITY': {
      if (signal.kind !== 'social') return null;
      if (!inScope(rule.coinIds, signal.coinId)) return null;
      if (rule.platforms.length > 0 && !rule.platforms.includes(signal.metric.platform))
        return null;

      const velocity = signal.metric.velocity;
      if (velocity === null || !Number.isFinite(velocity) || velocity < rule.minVelocity)
        return null;

      return {
        title: `Social velocity ${velocity.toFixed(1)}x`,
        message:
          `${signal.metric.mentions} mentions on ${signal.metric.platform} in the last ` +
          `${signal.metric.windowMinutes}m — ${velocity.toFixed(1)}x the baseline.`,
        observedValue: velocity,
        coinId: signal.coinId,
        eventId: null,
        payload: {
          platform: signal.metric.platform,
          mentions: signal.metric.mentions,
          topHashtags: signal.metric.topHashtags,
        },
      };
    }

    case 'AUTHOR_POST': {
      if (signal.kind !== 'socialPost') return null;
      if (!inScope(rule.coinIds, signal.coinId)) return null;
      if (rule.verifiedOnly && !signal.isVerified) return null;

      const handle = signal.post.authorHandle?.replace(/^@/, '').toLowerCase() ?? null;
      if (rule.handles.length > 0) {
        if (handle === null) return null;
        const wanted = rule.handles.map((h) => h.replace(/^@/, '').toLowerCase());
        if (!wanted.includes(handle)) return null;
      }

      const preview =
        signal.post.text.length > 180 ? `${signal.post.text.slice(0, 177)}…` : signal.post.text;

      return {
        title: `@${handle ?? 'unknown'} posted`,
        message: preview,
        observedValue: signal.post.engagementScore,
        coinId: signal.coinId,
        eventId: signal.post.eventId,
        payload: { platform: signal.post.platform, url: signal.post.url, handle },
      };
    }

    default: {
      // Exhaustiveness guard: adding a rule variant without a case here is a
      // compile error, not a silently-ignored alert.
      const _exhaustive: never = rule;
      return _exhaustive;
    }
  }
}

/** True when `alert` is still inside its cooldown window at `now`. */
export function isInCooldown(
  alert: Pick<Alert, 'cooldownSeconds' | 'lastTriggeredAt'>,
  now: Date,
): boolean {
  if (alert.lastTriggeredAt === null || alert.cooldownSeconds <= 0) return false;
  const elapsedMs = now.getTime() - alert.lastTriggeredAt.getTime();
  return elapsedMs < alert.cooldownSeconds * 1000;
}

export interface EvaluationOutcome {
  alert: Alert;
  match: AlertMatch;
}

/**
 * Evaluate many alerts against one signal, honouring `isEnabled` and cooldown.
 * Order is preserved so callers get deterministic notification ordering.
 */
export function evaluateAlerts(
  alerts: readonly Alert[],
  signal: AlertSignal,
  now: Date = new Date(),
): EvaluationOutcome[] {
  const outcomes: EvaluationOutcome[] = [];
  for (const alert of alerts) {
    if (!alert.isEnabled) continue;
    if (isInCooldown(alert, now)) continue;
    const match = evaluateRule(alert.rule, signal);
    if (match !== null) outcomes.push({ alert, match });
  }
  return outcomes;
}
