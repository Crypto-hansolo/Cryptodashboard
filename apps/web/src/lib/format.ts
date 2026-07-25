/**
 * Re-exports the shared formatters plus UI-only presentation helpers.
 *
 * Formatting lives in @cid/core so a number reads identically in the UI, a
 * notification and a report; the class-name maps below are UI-only and belong
 * here.
 */
export {
  formatUsd,
  formatNumber,
  formatPercent,
  formatFraction,
  formatRelativeTime,
  formatDuration,
  formatDomain,
  truncate,
} from '@cid/core';

import type { EventCategory, ImpactLevel, SentimentLabel } from '@cid/core';

/** Directional colour for a signed change. */
export function changeClass(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'text-ink-faint';
  if (value > 0) return 'text-bull';
  if (value < 0) return 'text-bear';
  return 'text-ink-muted';
}

export const SENTIMENT_STYLE: Readonly<
  Record<SentimentLabel, { label: string; className: string }>
> = {
  VERY_BULLISH: { label: 'Very bullish', className: 'bg-bull/20 text-bull' },
  BULLISH: { label: 'Bullish', className: 'bg-bull/12 text-bull/90' },
  NEUTRAL: { label: 'Neutral', className: 'bg-base-700 text-ink-muted' },
  BEARISH: { label: 'Bearish', className: 'bg-bear/12 text-bear/90' },
  VERY_BEARISH: { label: 'Very bearish', className: 'bg-bear/20 text-bear' },
};

export const IMPACT_STYLE: Readonly<Record<ImpactLevel, { label: string; className: string }>> = {
  CRITICAL: { label: 'Critical', className: 'bg-bear/25 text-bear' },
  HIGH: { label: 'High', className: 'bg-warn/20 text-warn' },
  MEDIUM: { label: 'Medium', className: 'bg-accent/15 text-accent' },
  LOW: { label: 'Low', className: 'bg-base-700 text-ink-faint' },
};

/**
 * Category labels and colours.
 *
 * Security/regulatory read as warnings, development/governance as informational,
 * so the timeline is scannable by colour alone.
 */
export const CATEGORY_STYLE: Readonly<Record<EventCategory, { label: string; className: string }>> =
  {
    SECURITY: { label: 'Security', className: 'bg-bear/20 text-bear' },
    REGULATORY: { label: 'Regulatory', className: 'bg-warn/20 text-warn' },
    EXCHANGE_LISTING: { label: 'Listing', className: 'bg-bull/20 text-bull' },
    TOKENOMICS: { label: 'Tokenomics', className: 'bg-accent/15 text-accent' },
    GOVERNANCE: { label: 'Governance', className: 'bg-accent/15 text-accent' },
    WHALE: { label: 'Whale', className: 'bg-warn/15 text-warn' },
    ONCHAIN: { label: 'On-chain', className: 'bg-base-700 text-ink-muted' },
    DEVELOPMENT: { label: 'Dev', className: 'bg-base-700 text-ink-muted' },
    DERIVATIVES: { label: 'Derivatives', className: 'bg-base-700 text-ink-muted' },
    LIQUIDATION: { label: 'Liquidation', className: 'bg-bear/15 text-bear/90' },
    PARTNERSHIP: { label: 'Partnership', className: 'bg-bull/15 text-bull/90' },
    NEWS: { label: 'News', className: 'bg-base-700 text-ink-muted' },
    MARKET_STRUCTURE: { label: 'Market', className: 'bg-base-700 text-ink-muted' },
    PRICE_ACTION: { label: 'Price', className: 'bg-base-700 text-ink-muted' },
    SOCIAL: { label: 'Social', className: 'bg-base-700 text-ink-faint' },
    MACRO: { label: 'Macro', className: 'bg-base-700 text-ink-muted' },
    OTHER: { label: 'Other', className: 'bg-base-700 text-ink-faint' },
  };

/** Importance bar colour, matching the impact thresholds in @cid/core. */
export function importanceClass(importance: number | null): string {
  if (importance === null) return 'bg-base-600';
  if (importance >= 85) return 'bg-bear';
  if (importance >= 65) return 'bg-warn';
  if (importance >= 40) return 'bg-accent';
  return 'bg-base-500';
}

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}
