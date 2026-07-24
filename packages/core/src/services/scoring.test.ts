import { describe, expect, it } from 'vitest';
import {
  computeConfidence,
  computeDevActivityScore,
  computeEngagement,
  computeImportance,
  computeTrendingScore,
  computeWhaleActivityScore,
  importanceToImpact,
} from './scoring.js';

describe('computeImportance', () => {
  const baseline = { category: 'NEWS' as const, sourceCredibility: 0.5 };

  it('always returns a value in [1, 100]', () => {
    const inputs = [
      baseline,
      { ...baseline, modelImportance: 100, connectorHint: 100, magnitudeUsd: 1e12 },
      { ...baseline, modelImportance: 1, connectorHint: 1, magnitudeUsd: 1 },
      { category: 'OTHER' as const, sourceCredibility: 0 },
    ];
    for (const input of inputs) {
      const score = computeImportance(input);
      expect(score).toBeGreaterThanOrEqual(1);
      expect(score).toBeLessThanOrEqual(100);
      expect(Number.isInteger(score)).toBe(true);
    }
  });

  it('ranks a security incident above a social post, all else equal', () => {
    const security = computeImportance({ category: 'SECURITY', sourceCredibility: 0.8 });
    const social = computeImportance({ category: 'SOCIAL', sourceCredibility: 0.8 });
    expect(security).toBeGreaterThan(social);
  });

  it('scales with transfer magnitude', () => {
    const small = computeImportance({ ...baseline, category: 'WHALE', magnitudeUsd: 100_000 });
    const large = computeImportance({ ...baseline, category: 'WHALE', magnitudeUsd: 100_000_000 });
    expect(large).toBeGreaterThan(small);
  });

  it('rewards corroboration but with diminishing returns', () => {
    const one = computeImportance({ ...baseline, corroborationCount: 1 });
    const three = computeImportance({ ...baseline, corroborationCount: 3 });
    const thirty = computeImportance({ ...baseline, corroborationCount: 30 });
    expect(three).toBeGreaterThan(one);
    expect(thirty).toBeGreaterThan(three);
    // The 3 -> 30 jump must be smaller than the 1 -> 3 jump.
    expect(thirty - three).toBeLessThan(three - one);
  });

  it('weights a founder above an anonymous account', () => {
    const founder = computeImportance({ ...baseline, category: 'SOCIAL', authorRole: 'FOUNDER' });
    const anon = computeImportance({ ...baseline, category: 'SOCIAL', authorRole: 'ANONYMOUS' });
    expect(founder).toBeGreaterThan(anon);
  });

  it('decays with age but never below 60% of the fresh score', () => {
    const fresh = computeImportance({ ...baseline, category: 'SECURITY', ageMs: 0 });
    const day = computeImportance({ ...baseline, category: 'SECURITY', ageMs: 86_400_000 });
    const year = computeImportance({ ...baseline, category: 'SECURITY', ageMs: 365 * 86_400_000 });
    expect(day).toBeLessThan(fresh);
    expect(year).toBeGreaterThanOrEqual(Math.floor(fresh * 0.6) - 1);
  });

  it('does not let a confident model push a trivial social post into critical territory', () => {
    const score = computeImportance({
      category: 'SOCIAL',
      sourceCredibility: 0.3,
      modelImportance: 100,
      authorRole: 'ANONYMOUS',
    });
    expect(importanceToImpact(score)).not.toBe('CRITICAL');
  });
});

describe('importanceToImpact', () => {
  it('maps the documented thresholds', () => {
    expect(importanceToImpact(0)).toBe('LOW');
    expect(importanceToImpact(39)).toBe('LOW');
    expect(importanceToImpact(40)).toBe('MEDIUM');
    expect(importanceToImpact(64)).toBe('MEDIUM');
    expect(importanceToImpact(65)).toBe('HIGH');
    expect(importanceToImpact(84)).toBe('HIGH');
    expect(importanceToImpact(85)).toBe('CRITICAL');
    expect(importanceToImpact(100)).toBe('CRITICAL');
  });
});

describe('computeConfidence', () => {
  it('is high for corroborated hard data from a credible source', () => {
    const score = computeConfidence({
      sourceCredibility: 0.95,
      modelConfidence: 85,
      corroborationCount: 5,
      hasHardData: true,
      signalsAgree: true,
    });
    expect(score).toBeGreaterThan(80);
  });

  it('is penalised when signals contradict each other', () => {
    const agreeing = computeConfidence({
      sourceCredibility: 0.9,
      modelConfidence: 90,
      signalsAgree: true,
    });
    const conflicting = computeConfidence({
      sourceCredibility: 0.9,
      modelConfidence: 90,
      signalsAgree: false,
    });
    expect(conflicting).toBeLessThan(agreeing);
  });

  it('is independent of importance — an unverified catastrophe stays low-confidence', () => {
    const score = computeConfidence({ sourceCredibility: 0.15, hasHardData: false });
    expect(score).toBeLessThan(45);
  });

  it('falls back to a modest default with no inputs', () => {
    expect(computeConfidence({ sourceCredibility: 0 })).toBeGreaterThanOrEqual(1);
  });
});

describe('computeEngagement', () => {
  it('returns 0 for a post with no interaction', () => {
    expect(computeEngagement({ likes: 0, reposts: 0, replies: 0 })).toBe(0);
  });

  it('stays within [0, 1]', () => {
    const extreme = computeEngagement({ likes: 1e9, reposts: 1e9, replies: 1e9, followers: 10 });
    expect(extreme).toBeLessThanOrEqual(1);
    expect(extreme).toBeGreaterThanOrEqual(0);
  });

  it('weights reposts above likes', () => {
    const likes = computeEngagement({ likes: 300, reposts: 0, replies: 0, followers: 10_000 });
    const reposts = computeEngagement({ likes: 0, reposts: 300, replies: 0, followers: 10_000 });
    expect(reposts).toBeGreaterThan(likes);
  });

  it('normalises against audience size, so small accounts can score highly', () => {
    // Same raw engagement; the smaller account has the higher engagement rate.
    const small = computeEngagement({ likes: 500, reposts: 0, replies: 0, followers: 1_000 });
    const large = computeEngagement({ likes: 500, reposts: 0, replies: 0, followers: 10_000_000 });
    expect(small).toBeGreaterThan(large);
  });
});

describe('computeTrendingScore', () => {
  it('is 0 with no activity', () => {
    expect(
      computeTrendingScore({ velocity: null, mentions: 0, uniqueAuthors: 0, meanEngagement: null }),
    ).toBe(0);
  });

  it('ranks an unusual spike on a small coin above routine chatter on a large one', () => {
    const spike = computeTrendingScore({
      velocity: 20,
      mentions: 40,
      uniqueAuthors: 35,
      meanEngagement: 0.4,
    });
    const routine = computeTrendingScore({
      velocity: 1,
      mentions: 4_000,
      uniqueAuthors: 3_000,
      meanEngagement: 0.4,
    });
    expect(spike).toBeGreaterThan(routine);
  });

  it('penalises a single account spamming many posts via the breadth term', () => {
    const spam = computeTrendingScore({
      velocity: 10,
      mentions: 200,
      uniqueAuthors: 1,
      meanEngagement: 0.1,
    });
    const organic = computeTrendingScore({
      velocity: 10,
      mentions: 200,
      uniqueAuthors: 180,
      meanEngagement: 0.1,
    });
    expect(organic).toBeGreaterThan(spam);
  });

  it('stays in [0, 100]', () => {
    const score = computeTrendingScore({
      velocity: Number.POSITIVE_INFINITY,
      mentions: 1e6,
      uniqueAuthors: 1e6,
      meanEngagement: 1,
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe('computeDevActivityScore', () => {
  it('returns 0 when nothing is known', () => {
    expect(
      computeDevActivityScore({
        commits30d: null,
        contributors30d: null,
        releases90d: null,
        openIssues: null,
        stars: null,
        daysSinceLastCommit: null,
      }),
    ).toBe(0);
  });

  it('ranks an active multi-contributor repo above a stale popular one', () => {
    const active = computeDevActivityScore({
      commits30d: 180,
      contributors30d: 22,
      releases90d: 8,
      openIssues: 40,
      stars: 1_200,
      daysSinceLastCommit: 1,
    });
    const stale = computeDevActivityScore({
      commits30d: 0,
      contributors30d: 0,
      releases90d: 0,
      openIssues: 300,
      stars: 60_000,
      daysSinceLastCommit: 400,
    });
    expect(active).toBeGreaterThan(stale);
    expect(active).toBeGreaterThan(60);
    expect(stale).toBeLessThan(30);
  });

  it('does not let stars dominate engineering signals', () => {
    const starsOnly = computeDevActivityScore({
      commits30d: 1,
      contributors30d: 1,
      releases90d: 0,
      openIssues: 0,
      stars: 200_000,
      daysSinceLastCommit: 90,
    });
    expect(starsOnly).toBeLessThan(50);
  });
});

describe('computeWhaleActivityScore', () => {
  it('reads net exchange outflow as accumulation', () => {
    const result = computeWhaleActivityScore({
      inflowUsd: 1_000_000,
      outflowUsd: 20_000_000,
      transferCount: 12,
      marketCapUsd: 1_000_000_000,
    });
    expect(result.netFlowUsd).toBe(19_000_000);
    expect(['BULLISH', 'VERY_BULLISH']).toContain(result.sentiment);
  });

  it('reads net exchange inflow as distribution', () => {
    const result = computeWhaleActivityScore({
      inflowUsd: 30_000_000,
      outflowUsd: 2_000_000,
      transferCount: 20,
      marketCapUsd: 1_000_000_000,
    });
    expect(result.netFlowUsd).toBeLessThan(0);
    expect(['BEARISH', 'VERY_BEARISH']).toContain(result.sentiment);
  });

  it('calls balanced flow neutral', () => {
    const result = computeWhaleActivityScore({
      inflowUsd: 10_000_000,
      outflowUsd: 10_000_000,
      transferCount: 10,
      marketCapUsd: 1_000_000_000,
    });
    expect(result.sentiment).toBe('NEUTRAL');
    expect(result.netFlowUsd).toBe(0);
  });

  it('handles a zero-activity window without dividing by zero', () => {
    const result = computeWhaleActivityScore({
      inflowUsd: 0,
      outflowUsd: 0,
      transferCount: 0,
      marketCapUsd: 1_000_000_000,
    });
    expect(result.score).toBe(0);
    expect(result.sentiment).toBe('NEUTRAL');
  });

  it('treats the same flow as more material for a small-cap asset', () => {
    const smallCap = computeWhaleActivityScore({
      inflowUsd: 5_000_000,
      outflowUsd: 0,
      transferCount: 3,
      marketCapUsd: 50_000_000,
    });
    const largeCap = computeWhaleActivityScore({
      inflowUsd: 5_000_000,
      outflowUsd: 0,
      transferCount: 3,
      marketCapUsd: 500_000_000_000,
    });
    expect(smallCap.score).toBeGreaterThan(largeCap.score);
  });
});
