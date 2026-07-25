import { describe, expect, it } from 'vitest';
import {
  formatDomain,
  formatDuration,
  formatFraction,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatUsd,
  truncate,
} from './format.js';

/**
 * These functions are shared by the UI, the notification templates and the
 * report generator, so a number must read identically in all three. That makes
 * them worth pinning: a change here silently changes every alert message.
 */

describe('formatUsd', () => {
  it('renders large values with magnitude suffixes', () => {
    expect(formatUsd(2_540_000_000_000)).toBe('$2.54T');
    expect(formatUsd(1_783_000_000_000)).toBe('$1.78T');
    expect(formatUsd(24_100_000_000)).toBe('$24.10B');
    expect(formatUsd(4_500_000)).toBe('$4.50M');
    expect(formatUsd(250_000)).toBe('$250.0K');
  });

  it('keeps values below the compact floor fully written out', () => {
    // 100K is the compact threshold, so 99,999 stays long-form.
    expect(formatUsd(99_999)).toBe('$99,999.00');
    expect(formatUsd(89_948.29)).toBe('$89,948.29');
  });

  it('honours compact: false for mid-range values', () => {
    expect(formatUsd(4_500_000, { compact: false })).toBe('$4,500,000.00');
  });

  it('keeps four significant digits below a dollar', () => {
    expect(formatUsd(0.1279)).toBe('$0.1279');
    expect(formatUsd(0.00003412)).toBe('$0.00003412');
    expect(formatUsd(0.5)).toBe('$0.5');
  });

  it('expands very small values instead of showing exponent notation', () => {
    /*
     * The regression this guards: `toPrecision` returns "1.234e-9" below 1e-7,
     * and memecoins genuinely trade at those prices. "$1.234e-9" is not a price
     * a human reads off a terminal.
     */
    expect(formatUsd(0.000000001234)).toBe('$0.000000001234');
    expect(formatUsd(1e-9)).toBe('$0.000000001');
    expect(formatUsd(0.000000001234)).not.toContain('e');
  });

  it('carries the sign without disturbing the magnitude', () => {
    expect(formatUsd(-4_500_000)).toBe('-$4.50M');
    expect(formatUsd(-0.1279)).toBe('-$0.1279');
  });

  it('renders exact zero as a currency amount, not a dash', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('renders absent and non-finite values as a dash', () => {
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd(undefined)).toBe('—');
    expect(formatUsd(Number.NaN)).toBe('—');
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatNumber', () => {
  it('abbreviates above ten thousand', () => {
    expect(formatNumber(1_400_000_000)).toBe('1.40B');
    expect(formatNumber(2_500_000)).toBe('2.50M');
    expect(formatNumber(12_400)).toBe('12.4K');
  });

  it('keeps small counts exact', () => {
    expect(formatNumber(9_999)).toBe('9,999');
    expect(formatNumber(41)).toBe('41');
  });

  it('applies the requested decimals below the abbreviation floor', () => {
    expect(formatNumber(41.5, 2)).toBe('41.50');
  });

  it('preserves negatives', () => {
    expect(formatNumber(-2_500_000)).toBe('-2.50M');
  });

  it('renders absent values as a dash', () => {
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(Number.NaN)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('signs positive changes so a green row is unambiguous', () => {
    expect(formatPercent(3.22)).toBe('+3.22%');
    expect(formatPercent(-0.11)).toBe('-0.11%');
    expect(formatPercent(0)).toBe('0.00%');
  });

  it('can suppress the leading plus', () => {
    expect(formatPercent(3.22, { signed: false })).toBe('3.22%');
  });

  it('respects a decimal override', () => {
    expect(formatPercent(3.229, { decimals: 1 })).toBe('+3.2%');
    expect(formatPercent(3.229, { decimals: 0 })).toBe('+3%');
  });

  it('renders absent values as a dash', () => {
    expect(formatPercent(undefined)).toBe('—');
  });
});

describe('formatFraction', () => {
  it('converts a fraction to a percentage with basis-point resolution', () => {
    // Funding rates are tiny; 0.0001 is one basis point per interval.
    expect(formatFraction(0.0001)).toBe('+0.0100%');
    expect(formatFraction(-0.00025)).toBe('-0.0250%');
  });

  it('always signs, including zero, so a funding column aligns', () => {
    expect(formatFraction(0)).toBe('+0.0000%');
  });

  it('respects a decimal override', () => {
    expect(formatFraction(0.0125, 2)).toBe('+1.25%');
  });

  it('renders absent values as a dash', () => {
    expect(formatFraction(null)).toBe('—');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-07-25T12:00:00.000Z');
  const ago = (ms: number): Date => new Date(now.getTime() - ms);

  it('collapses anything under ten seconds to "now"', () => {
    expect(formatRelativeTime(ago(0), now)).toBe('now');
    expect(formatRelativeTime(ago(9_000), now)).toBe('now');
  });

  it('steps through units as the gap widens', () => {
    expect(formatRelativeTime(ago(45_000), now)).toBe('45s');
    expect(formatRelativeTime(ago(3 * 60_000), now)).toBe('3m');
    expect(formatRelativeTime(ago(2 * 3_600_000), now)).toBe('2h');
    expect(formatRelativeTime(ago(5 * 86_400_000), now)).toBe('5d');
    expect(formatRelativeTime(ago(45 * 86_400_000), now)).toBe('1mo');
    expect(formatRelativeTime(ago(400 * 86_400_000), now)).toBe('1y');
  });

  it('marks future times with a prefix', () => {
    // Token unlocks are scheduled ahead, so future formatting is load-bearing.
    const future = new Date(now.getTime() + 3 * 86_400_000);
    expect(formatRelativeTime(future, now)).toBe('in 3d');
    expect(formatRelativeTime(new Date(now.getTime() + 90_000), now)).toBe('in 1m');
  });

  it('reads the boundary between units without off-by-one drift', () => {
    expect(formatRelativeTime(ago(59_999), now)).toBe('59s');
    expect(formatRelativeTime(ago(60_000), now)).toBe('1m');
    expect(formatRelativeTime(ago(3_599_999), now)).toBe('59m');
    expect(formatRelativeTime(ago(3_600_000), now)).toBe('1h');
    expect(formatRelativeTime(ago(86_399_999), now)).toBe('23h');
    expect(formatRelativeTime(ago(86_400_000), now)).toBe('1d');
  });
});

describe('formatDuration', () => {
  it('uses milliseconds below a second', () => {
    expect(formatDuration(3)).toBe('3ms');
    expect(formatDuration(412.6)).toBe('413ms');
  });

  it('uses seconds below a minute', () => {
    expect(formatDuration(1_500)).toBe('1.5s');
    expect(formatDuration(41_200)).toBe('41.2s');
  });

  it('uses minutes and seconds above that', () => {
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(3_600_000)).toBe('60m 0s');
  });

  it('rejects nonsense rather than rendering it', () => {
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('Binance lists CRO', 40)).toBe('Binance lists CRO');
  });

  it('breaks on a word boundary when one is close enough to the limit', () => {
    const headline = 'Ethereum developers delay the Pectra upgrade to September';
    const result = truncate(headline, 30);
    expect(result).toBe('Ethereum developers delay…');
    expect(result.length).toBeLessThanOrEqual(30);
    // The kept text ends at a real word boundary in the original.
    const kept = result.slice(0, -1);
    expect(headline.startsWith(kept)).toBe(true);
    expect(headline[kept.length]).toBe(' ');
  });

  it('cuts mid-word rather than losing most of the budget', () => {
    // The only space is at index 1, far below 60% of the limit, so breaking
    // there would return "a…" and throw away the whole headline.
    expect(truncate('a Supercalifragilisticexpialidocious', 20)).toBe('a Supercalifragilis…');
  });

  it('trims trailing whitespace before the ellipsis', () => {
    expect(truncate('one two three four', 8)).toBe('one two…');
  });

  it('handles a limit at the exact text length', () => {
    expect(truncate('exactly', 7)).toBe('exactly');
  });
});

describe('formatDomain', () => {
  it('extracts the hostname and drops the www prefix', () => {
    expect(formatDomain('https://www.coindesk.com/markets/2026/07/25/x')).toBe('coindesk.com');
    expect(formatDomain('https://blog.ethereum.org/2026/07/25/pectra')).toBe('blog.ethereum.org');
  });

  it('returns the input unchanged when it is not a URL', () => {
    // Some feeds put a bare title or an internal id in the link field.
    expect(formatDomain('not a url')).toBe('not a url');
  });

  it('renders absent values as a dash', () => {
    expect(formatDomain(null)).toBe('—');
    expect(formatDomain('')).toBe('—');
  });
});
