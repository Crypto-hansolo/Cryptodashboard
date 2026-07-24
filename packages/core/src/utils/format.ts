/**
 * Display formatting shared by the UI, the notification templates and the
 * report generator, so a number reads the same everywhere it appears.
 */

/**
 * Compact USD. Crypto spans 12 orders of magnitude, so fixed decimals are
 * useless: sub-cent memecoins need significant digits, BTC needs thousands
 * separators, and market caps need B/T suffixes.
 */
export function formatUsd(
  value: number | null | undefined,
  options: { compact?: boolean } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (options.compact !== false) {
    if (abs >= 1_000_000_000_000) return `${sign}$${(abs / 1_000_000_000_000).toFixed(2)}T`;
    if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
    if (abs >= 100_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  }

  if (abs >= 1) {
    return `${sign}$${abs.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  if (abs === 0) return '$0.00';
  // Sub-dollar: keep 4 significant digits so $0.00003412 stays readable.
  return `${sign}$${abs.toPrecision(4).replace(/0+$/, '').replace(/\.$/, '')}`;
}

export function formatNumber(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatPercent(
  value: number | null | undefined,
  options: { decimals?: number; signed?: boolean } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const decimals = options.decimals ?? 2;
  const sign = options.signed !== false && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

/** Funding rates and other fraction-valued fields. */
export function formatFraction(value: number | null | undefined, decimals = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const pct = value * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(decimals)}%`;
}

/**
 * Terse relative time ("3m", "2h", "5d"). Deliberately compact: the timeline
 * shows hundreds of rows and a column of "about 3 minutes ago" wastes the width
 * that headlines need.
 */
export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const deltaMs = now.getTime() - date.getTime();
  const future = deltaMs < 0;
  const abs = Math.abs(deltaMs);

  const seconds = Math.floor(abs / 1000);
  if (seconds < 10) return future ? 'now' : 'now';
  if (seconds < 60) return `${future ? 'in ' : ''}${seconds}s${future ? '' : ''}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${future ? 'in ' : ''}${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${future ? 'in ' : ''}${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${future ? 'in ' : ''}${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${future ? 'in ' : ''}${months}mo`;
  return `${future ? 'in ' : ''}${Math.floor(months / 12)}y`;
}

/** Human duration for latency/telemetry display. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Truncate on a word boundary, appending an ellipsis. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, maxLength - 1);
  const lastSpace = slice.lastIndexOf(' ');
  // Only break on a word if doing so does not lose most of the budget.
  const cut = lastSpace > maxLength * 0.6 ? lastSpace : slice.length;
  return `${slice.slice(0, cut).trimEnd()}…`;
}

/** `example.com` from a URL, for source attribution chips. */
export function formatDomain(url: string | null | undefined): string {
  if (!url) return '—';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
