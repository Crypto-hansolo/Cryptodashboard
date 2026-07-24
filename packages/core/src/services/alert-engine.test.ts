import { describe, expect, it } from 'vitest';
import {
  evaluateAlerts,
  evaluateRule,
  isInCooldown,
  RULE_SIGNAL_KINDS,
  type AlertSignal,
} from './alert-engine.js';
import { ALERT_RULE_TYPES, alertRuleSchema, type Alert, type AlertRule } from '../domain/alert.js';
import type { Event } from '../domain/event.js';
import type { MarketQuote } from '../domain/market.js';

const NOW = new Date('2026-05-01T12:00:00Z');

function quote(overrides: Partial<MarketQuote> = {}): MarketQuote {
  return {
    coinId: 'cro',
    priceUsd: 100,
    marketCapUsd: 1_000_000_000,
    volume24hUsd: 50_000_000,
    fdvUsd: null,
    priceChange1hPct: null,
    priceChange24hPct: null,
    priceChange7dPct: null,
    observedAt: NOW,
    ...overrides,
  };
}

function marketSignal(
  current: Partial<MarketQuote>,
  reference: Partial<MarketQuote> | null,
  baseline?: number | null,
): AlertSignal {
  return {
    kind: 'market',
    coinId: 'cro',
    current: quote(current),
    reference: reference === null ? null : quote(reference),
    baselineVolumeUsd: baseline ?? null,
  };
}

function event(overrides: Partial<Event> = {}): Event {
  return {
    id: 'ev1',
    occurredAt: NOW,
    ingestedAt: NOW,
    coinId: 'cro',
    sourceId: 'src1',
    category: 'NEWS',
    subtype: null,
    headline: 'Crypto.com secures a major payments partnership',
    body: null,
    url: 'https://example.com/a',
    author: null,
    dedupeHash: 'h',
    clusterId: null,
    payload: {},
    relatedCoinIds: [],
    intelligence: {
      summary: 'A summary.',
      explanation: null,
      sentiment: 'BULLISH',
      sentimentScore: 0.5,
      importance: 80,
      confidence: 70,
      impact: 'HIGH',
      narratives: [],
      isFud: false,
      model: null,
      enrichedAt: NOW,
    },
    ...overrides,
  };
}

function alert(rule: AlertRule, overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'a1',
    userId: 'u1',
    name: 'Test alert',
    rule,
    channels: ['DESKTOP'],
    isEnabled: true,
    cooldownSeconds: 300,
    lastTriggeredAt: null,
    triggerCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('rule/signal registry', () => {
  it('declares a signal kind for every rule type', () => {
    for (const type of ALERT_RULE_TYPES) {
      expect(RULE_SIGNAL_KINDS[type]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('returns null instead of firing when the signal kind does not apply', () => {
    const rule = alertRuleSchema.parse({ type: 'PRICE_LEVEL', comparator: 'ABOVE', price: 1 });
    const signal: AlertSignal = {
      kind: 'release',
      coinId: 'cro',
      repo: 'a/b',
      tag: 'v1',
      title: 't',
      url: null,
      publishedAt: NOW,
    };
    expect(evaluateRule(rule, signal)).toBeNull();
  });
});

describe('PRICE_CHANGE', () => {
  const rule = alertRuleSchema.parse({
    type: 'PRICE_CHANGE',
    thresholdPct: 5,
    windowMinutes: 60,
  });

  it('fires on a move beyond the threshold', () => {
    const match = evaluateRule(rule, marketSignal({ priceUsd: 110 }, { priceUsd: 100 }));
    expect(match).not.toBeNull();
    expect(match?.observedValue).toBeCloseTo(10);
  });

  it('stays quiet below the threshold', () => {
    expect(evaluateRule(rule, marketSignal({ priceUsd: 102 }, { priceUsd: 100 }))).toBeNull();
  });

  it('fires on a down move when direction is ANY', () => {
    const match = evaluateRule(rule, marketSignal({ priceUsd: 90 }, { priceUsd: 100 }));
    expect(match?.observedValue).toBeCloseTo(-10);
  });

  it('respects a direction filter', () => {
    const upOnly = alertRuleSchema.parse({
      type: 'PRICE_CHANGE',
      thresholdPct: 5,
      direction: 'UP',
    });
    expect(evaluateRule(upOnly, marketSignal({ priceUsd: 90 }, { priceUsd: 100 }))).toBeNull();
    expect(evaluateRule(upOnly, marketSignal({ priceUsd: 110 }, { priceUsd: 100 }))).not.toBeNull();
  });

  it('needs a reference quote', () => {
    expect(evaluateRule(rule, marketSignal({ priceUsd: 200 }, null))).toBeNull();
  });

  it('handles a zero reference price without dividing by zero', () => {
    expect(evaluateRule(rule, marketSignal({ priceUsd: 1 }, { priceUsd: 0 }))).toBeNull();
  });

  it('honours coin scope', () => {
    const scoped = alertRuleSchema.parse({
      type: 'PRICE_CHANGE',
      thresholdPct: 5,
      coinIds: ['btc'],
    });
    expect(evaluateRule(scoped, marketSignal({ priceUsd: 200 }, { priceUsd: 100 }))).toBeNull();
  });
});

describe('PRICE_LEVEL', () => {
  const rule = alertRuleSchema.parse({ type: 'PRICE_LEVEL', comparator: 'ABOVE', price: 100 });

  it('fires on an upward crossing', () => {
    expect(evaluateRule(rule, marketSignal({ priceUsd: 101 }, { priceUsd: 99 }))).not.toBeNull();
  });

  it('does not re-fire while the condition merely persists', () => {
    // Without this guard the alert fires on every 10s price tick.
    expect(evaluateRule(rule, marketSignal({ priceUsd: 120 }, { priceUsd: 110 }))).toBeNull();
  });

  it('fires without a reference quote, since no crossing can be established', () => {
    expect(evaluateRule(rule, marketSignal({ priceUsd: 101 }, null))).not.toBeNull();
  });

  it('supports BELOW', () => {
    const below = alertRuleSchema.parse({ type: 'PRICE_LEVEL', comparator: 'BELOW', price: 100 });
    expect(evaluateRule(below, marketSignal({ priceUsd: 99 }, { priceUsd: 101 }))).not.toBeNull();
    expect(evaluateRule(below, marketSignal({ priceUsd: 101 }, { priceUsd: 99 }))).toBeNull();
  });
});

describe('VOLUME_SPIKE', () => {
  const rule = alertRuleSchema.parse({ type: 'VOLUME_SPIKE', multiplier: 3 });

  it('fires at or above the multiplier', () => {
    const match = evaluateRule(rule, marketSignal({ volume24hUsd: 30_000_000 }, null, 10_000_000));
    expect(match?.observedValue).toBeCloseTo(3);
  });

  it('stays quiet below the multiplier', () => {
    expect(
      evaluateRule(rule, marketSignal({ volume24hUsd: 20_000_000 }, null, 10_000_000)),
    ).toBeNull();
  });

  it('needs a usable baseline', () => {
    expect(evaluateRule(rule, marketSignal({ volume24hUsd: 1e9 }, null, 0))).toBeNull();
    expect(evaluateRule(rule, marketSignal({ volume24hUsd: 1e9 }, null, null))).toBeNull();
  });
});

describe('EVENT_MATCH', () => {
  it('matches on category, importance and keyword together', () => {
    const rule = alertRuleSchema.parse({
      type: 'EVENT_MATCH',
      categories: ['NEWS'],
      minImportance: 70,
      keywords: ['partnership'],
    });
    const signal: AlertSignal = {
      kind: 'event',
      event: event(),
      sourceKey: 'coindesk',
      coinId: 'cro',
    };
    expect(evaluateRule(rule, signal)).not.toBeNull();
  });

  it('rejects when any single criterion fails', () => {
    const signal: AlertSignal = {
      kind: 'event',
      event: event(),
      sourceKey: 'coindesk',
      coinId: 'cro',
    };
    const cases: unknown[] = [
      { type: 'EVENT_MATCH', categories: ['SECURITY'] },
      { type: 'EVENT_MATCH', minImportance: 95 },
      { type: 'EVENT_MATCH', keywords: ['exploit'] },
      { type: 'EVENT_MATCH', sourceKeys: ['theblock'] },
      { type: 'EVENT_MATCH', sentiments: ['VERY_BEARISH'] },
      { type: 'EVENT_MATCH', impacts: ['CRITICAL'] },
      { type: 'EVENT_MATCH', subtypes: ['SOMETHING'] },
    ];
    for (const raw of cases) {
      expect(evaluateRule(alertRuleSchema.parse(raw), signal)).toBeNull();
    }
  });

  it('does not match importance filters against an unenriched event', () => {
    const unenriched = event({
      intelligence: { ...event().intelligence, importance: null, sentiment: null, impact: null },
    });
    const rule = alertRuleSchema.parse({ type: 'EVENT_MATCH', minImportance: 50 });
    expect(
      evaluateRule(rule, { kind: 'event', event: unenriched, sourceKey: 'x', coinId: 'cro' }),
    ).toBeNull();
  });

  it('searches the body as well as the headline', () => {
    const withBody = event({ body: 'Details mention a token unlock schedule.' });
    const rule = alertRuleSchema.parse({ type: 'EVENT_MATCH', keywords: ['unlock'] });
    expect(
      evaluateRule(rule, { kind: 'event', event: withBody, sourceKey: 'x', coinId: 'cro' }),
    ).not.toBeNull();
  });
});

describe('BREAKING_NEWS', () => {
  const rule = alertRuleSchema.parse({ type: 'BREAKING_NEWS', minImportance: 75 });

  it('fires for important editorial categories', () => {
    const signal: AlertSignal = { kind: 'event', event: event(), sourceKey: 'x', coinId: 'cro' };
    expect(evaluateRule(rule, signal)?.title).toMatch(/^Breaking:/);
  });

  it('ignores a high-importance price tick — that is not news', () => {
    const priceEvent = event({ category: 'PRICE_ACTION' });
    expect(
      evaluateRule(rule, { kind: 'event', event: priceEvent, sourceKey: 'x', coinId: 'cro' }),
    ).toBeNull();
  });

  it('ignores news below the importance bar', () => {
    const minor = event({ intelligence: { ...event().intelligence, importance: 20 } });
    expect(
      evaluateRule(rule, { kind: 'event', event: minor, sourceKey: 'x', coinId: 'cro' }),
    ).toBeNull();
  });
});

describe('EXCHANGE_LISTING', () => {
  const signal: AlertSignal = {
    kind: 'listing',
    coinId: 'cro',
    venue: 'Binance',
    symbol: 'CROUSDT',
    url: null,
    detectedAt: NOW,
  };

  it('fires for any venue by default', () => {
    expect(
      evaluateRule(alertRuleSchema.parse({ type: 'EXCHANGE_LISTING' }), signal),
    ).not.toBeNull();
  });

  it('filters by venue, case-insensitively', () => {
    expect(
      evaluateRule(
        alertRuleSchema.parse({ type: 'EXCHANGE_LISTING', venues: ['binance'] }),
        signal,
      ),
    ).not.toBeNull();
    expect(
      evaluateRule(alertRuleSchema.parse({ type: 'EXCHANGE_LISTING', venues: ['kraken'] }), signal),
    ).toBeNull();
  });
});

describe('WHALE_TRANSFER', () => {
  const onchainSignal = (
    amountUsd: number | null,
    toLabel: 'EXCHANGE' | null = null,
  ): AlertSignal => ({
    kind: 'onchain',
    coinId: 'cro',
    onchain: {
      id: 'o1',
      eventId: 'ev1',
      coinId: 'cro',
      sourceId: 's',
      type: 'WHALE_TRANSFER',
      occurredAt: NOW,
      chain: 'ethereum',
      txHash: '0xabc',
      blockNumber: 1,
      fromAddress: '0x1',
      toAddress: '0x2',
      fromLabel: null,
      toLabel,
      amount: 1000,
      amountUsd,
      metadata: {},
    },
  });

  it('fires above the USD floor', () => {
    const rule = alertRuleSchema.parse({ type: 'WHALE_TRANSFER', minUsd: 1_000_000 });
    expect(evaluateRule(rule, onchainSignal(5_000_000))?.observedValue).toBe(5_000_000);
  });

  it('stays quiet below the floor, and when USD value is unknown', () => {
    const rule = alertRuleSchema.parse({ type: 'WHALE_TRANSFER', minUsd: 1_000_000 });
    expect(evaluateRule(rule, onchainSignal(500_000))).toBeNull();
    expect(evaluateRule(rule, onchainSignal(null))).toBeNull();
  });

  it('describes exchange direction in the message', () => {
    const rule = alertRuleSchema.parse({ type: 'WHALE_TRANSFER', minUsd: 1_000 });
    expect(evaluateRule(rule, onchainSignal(2_000_000, 'EXCHANGE'))?.title).toContain(
      'into an exchange',
    );
  });

  it('filters by transfer type', () => {
    const rule = alertRuleSchema.parse({ type: 'WHALE_TRANSFER', minUsd: 1_000, types: ['BURN'] });
    expect(evaluateRule(rule, onchainSignal(2_000_000))).toBeNull();
  });
});

describe('TOKEN_UNLOCK', () => {
  const unlockSignal = (pct: number | null, supply: number | null): AlertSignal => ({
    kind: 'unlock',
    coinId: 'cro',
    circulatingSupply: supply,
    unlock: {
      id: 'u1',
      coinId: 'cro',
      sourceId: 's',
      unlockAt: new Date(NOW.getTime() + 86_400_000),
      amount: 5_000_000,
      amountUsd: 25_000_000,
      pctOfCirculating: pct,
      category: 'investors',
      isCliff: true,
      notes: null,
    },
  });

  it('fires for a material unlock', () => {
    const rule = alertRuleSchema.parse({ type: 'TOKEN_UNLOCK', minPctOfCirculating: 0.005 });
    expect(evaluateRule(rule, unlockSignal(0.02, null))?.observedValue).toBeCloseTo(2);
  });

  it('ignores an immaterial unlock', () => {
    const rule = alertRuleSchema.parse({ type: 'TOKEN_UNLOCK', minPctOfCirculating: 0.005 });
    expect(evaluateRule(rule, unlockSignal(0.001, null))).toBeNull();
  });

  it('derives the share of supply when it is not stored', () => {
    const rule = alertRuleSchema.parse({ type: 'TOKEN_UNLOCK', minPctOfCirculating: 0.005 });
    // 5M of 100M circulating = 5%.
    expect(evaluateRule(rule, unlockSignal(null, 100_000_000))).not.toBeNull();
    expect(evaluateRule(rule, unlockSignal(null, null))).toBeNull();
  });
});

describe('FUNDING_RATE', () => {
  const derivSignal = (fundingRate: number | null): AlertSignal => ({
    kind: 'derivatives',
    coinId: 'cro',
    snapshot: {
      id: 'd1',
      coinId: 'cro',
      sourceId: 's',
      observedAt: NOW,
      instrument: 'CROUSDT',
      fundingRate,
      nextFundingAt: null,
      openInterest: null,
      openInterestUsd: null,
      markPrice: null,
      indexPrice: null,
      longShortRatio: null,
      volume24hUsd: null,
    },
  });

  it('fires above a positive threshold', () => {
    const rule = alertRuleSchema.parse({
      type: 'FUNDING_RATE',
      comparator: 'ABOVE',
      threshold: 0.001,
    });
    expect(evaluateRule(rule, derivSignal(0.002))).not.toBeNull();
    expect(evaluateRule(rule, derivSignal(0.0005))).toBeNull();
  });

  it('fires below a negative threshold', () => {
    const rule = alertRuleSchema.parse({
      type: 'FUNDING_RATE',
      comparator: 'BELOW',
      threshold: -0.001,
    });
    expect(evaluateRule(rule, derivSignal(-0.002))).not.toBeNull();
    expect(evaluateRule(rule, derivSignal(0.002))).toBeNull();
  });

  it('needs a funding rate', () => {
    const rule = alertRuleSchema.parse({ type: 'FUNDING_RATE', comparator: 'ABOVE', threshold: 0 });
    expect(evaluateRule(rule, derivSignal(null))).toBeNull();
  });
});

describe('SOCIAL_VELOCITY and SENTIMENT_SHIFT', () => {
  const socialSignal = (
    velocity: number | null,
    current: number | null,
    previous: number | null,
  ): AlertSignal => ({
    kind: 'social',
    coinId: 'cro',
    metric: {
      id: 'm1',
      coinId: 'cro',
      platform: 'X',
      observedAt: NOW,
      windowMinutes: 60,
      mentions: 120,
      uniqueAuthors: 90,
      totalEngagement: 5000,
      sentimentScore: current,
      velocity,
      trendingScore: 70,
      topHashtags: ['cro'],
    },
    previous:
      previous === null
        ? null
        : {
            id: 'm0',
            coinId: 'cro',
            platform: 'X',
            observedAt: new Date(NOW.getTime() - 3_600_000),
            windowMinutes: 60,
            mentions: 20,
            uniqueAuthors: 18,
            totalEngagement: 400,
            sentimentScore: previous,
            velocity: 1,
            trendingScore: 20,
            topHashtags: [],
          },
  });

  it('fires on a velocity spike', () => {
    const rule = alertRuleSchema.parse({ type: 'SOCIAL_VELOCITY', minVelocity: 4 });
    expect(evaluateRule(rule, socialSignal(6, null, null))?.observedValue).toBe(6);
    expect(evaluateRule(rule, socialSignal(2, null, null))).toBeNull();
  });

  it('ignores a non-finite velocity rather than firing on Infinity', () => {
    const rule = alertRuleSchema.parse({ type: 'SOCIAL_VELOCITY', minVelocity: 4 });
    expect(evaluateRule(rule, socialSignal(Number.POSITIVE_INFINITY, null, null))).toBeNull();
  });

  it('filters by platform', () => {
    const rule = alertRuleSchema.parse({
      type: 'SOCIAL_VELOCITY',
      minVelocity: 1,
      platforms: ['REDDIT'],
    });
    expect(evaluateRule(rule, socialSignal(10, null, null))).toBeNull();
  });

  it('fires on a sentiment shift and needs both windows', () => {
    const rule = alertRuleSchema.parse({ type: 'SENTIMENT_SHIFT', minDelta: 0.4 });
    expect(evaluateRule(rule, socialSignal(1, 0.5, -0.3))?.observedValue).toBeCloseTo(0.8);
    expect(evaluateRule(rule, socialSignal(1, 0.5, 0.4))).toBeNull();
    expect(evaluateRule(rule, socialSignal(1, 0.5, null))).toBeNull();
  });

  it('respects shift direction', () => {
    const rule = alertRuleSchema.parse({
      type: 'SENTIMENT_SHIFT',
      minDelta: 0.4,
      direction: 'DOWN',
    });
    expect(evaluateRule(rule, socialSignal(1, 0.5, -0.3))).toBeNull();
    expect(evaluateRule(rule, socialSignal(1, -0.5, 0.3))).not.toBeNull();
  });
});

describe('AUTHOR_POST', () => {
  const postSignal = (handle: string | null, verified: boolean): AlertSignal => ({
    kind: 'socialPost',
    coinId: 'cro',
    isVerified: verified,
    post: {
      id: 'p1',
      eventId: 'ev1',
      sourceId: 's',
      platform: 'X',
      externalId: 'x1',
      authorId: null,
      authorHandle: handle,
      postedAt: NOW,
      text: 'Shipping something big next week.',
      url: null,
      likes: 100,
      reposts: 20,
      replies: 5,
      views: 10_000,
      engagementScore: 0.4,
      hashtags: [],
      coinIds: ['cro'],
    },
  });

  it('matches a watched handle, ignoring @ and case', () => {
    const rule = alertRuleSchema.parse({ type: 'AUTHOR_POST', handles: ['@Kris'] });
    expect(evaluateRule(rule, postSignal('kris', false))).not.toBeNull();
    expect(evaluateRule(rule, postSignal('someoneelse', false))).toBeNull();
  });

  it('can require a verified account', () => {
    const rule = alertRuleSchema.parse({ type: 'AUTHOR_POST', verifiedOnly: true });
    expect(evaluateRule(rule, postSignal('kris', false))).toBeNull();
    expect(evaluateRule(rule, postSignal('kris', true))).not.toBeNull();
  });

  it('truncates a long post for the notification body', () => {
    const rule = alertRuleSchema.parse({ type: 'AUTHOR_POST' });
    const signal = postSignal('kris', true);
    if (signal.kind !== 'socialPost') throw new Error('unreachable');
    signal.post.text = 'x'.repeat(500);
    const match = evaluateRule(rule, signal);
    expect(match?.message.length).toBeLessThanOrEqual(180);
    expect(match?.message.endsWith('…')).toBe(true);
  });
});

describe('cooldown', () => {
  it('suppresses within the cooldown window', () => {
    const a = alert(alertRuleSchema.parse({ type: 'EVENT_MATCH' }), {
      cooldownSeconds: 300,
      lastTriggeredAt: new Date(NOW.getTime() - 60_000),
    });
    expect(isInCooldown(a, NOW)).toBe(true);
  });

  it('allows once the window has elapsed', () => {
    const a = alert(alertRuleSchema.parse({ type: 'EVENT_MATCH' }), {
      cooldownSeconds: 300,
      lastTriggeredAt: new Date(NOW.getTime() - 600_000),
    });
    expect(isInCooldown(a, NOW)).toBe(false);
  });

  it('never suppresses a never-fired or zero-cooldown alert', () => {
    expect(isInCooldown({ cooldownSeconds: 300, lastTriggeredAt: null }, NOW)).toBe(false);
    expect(
      isInCooldown({ cooldownSeconds: 0, lastTriggeredAt: new Date(NOW.getTime() - 1) }, NOW),
    ).toBe(false);
  });
});

describe('evaluateAlerts', () => {
  const signal: AlertSignal = {
    kind: 'event',
    event: event(),
    sourceKey: 'coindesk',
    coinId: 'cro',
  };

  it('returns a match per firing alert', () => {
    const alerts = [
      alert(alertRuleSchema.parse({ type: 'EVENT_MATCH', categories: ['NEWS'] }), { id: 'a1' }),
      alert(alertRuleSchema.parse({ type: 'BREAKING_NEWS', minImportance: 75 }), { id: 'a2' }),
    ];
    const outcomes = evaluateAlerts(alerts, signal, NOW);
    expect(outcomes.map((o) => o.alert.id)).toEqual(['a1', 'a2']);
  });

  it('skips disabled alerts and those in cooldown', () => {
    const alerts = [
      alert(alertRuleSchema.parse({ type: 'EVENT_MATCH' }), { id: 'off', isEnabled: false }),
      alert(alertRuleSchema.parse({ type: 'EVENT_MATCH' }), {
        id: 'cooling',
        lastTriggeredAt: new Date(NOW.getTime() - 1_000),
      }),
      alert(alertRuleSchema.parse({ type: 'EVENT_MATCH' }), { id: 'live' }),
    ];
    expect(evaluateAlerts(alerts, signal, NOW).map((o) => o.alert.id)).toEqual(['live']);
  });

  it('returns nothing when no alerts are configured', () => {
    expect(evaluateAlerts([], signal, NOW)).toEqual([]);
  });
});
