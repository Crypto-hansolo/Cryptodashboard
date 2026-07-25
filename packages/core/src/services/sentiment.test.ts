import { describe, expect, it } from 'vitest';
import {
  aggregateSentiment,
  classifyWithLexicon,
  reconcileSentiment,
  scoreToSentiment,
  sentimentDelta,
  sentimentToScore,
} from './sentiment.js';
import { SENTIMENT_LABELS } from '../domain/enums.js';

describe('label <-> score mapping', () => {
  it('round-trips every label through its anchor score', () => {
    for (const label of SENTIMENT_LABELS) {
      expect(scoreToSentiment(sentimentToScore(label))).toBe(label);
    }
  });

  it('places boundaries at the midpoints between anchors', () => {
    expect(scoreToSentiment(0.75)).toBe('VERY_BULLISH');
    expect(scoreToSentiment(0.7499)).toBe('BULLISH');
    expect(scoreToSentiment(0.25)).toBe('BULLISH');
    expect(scoreToSentiment(0.2499)).toBe('NEUTRAL');
    expect(scoreToSentiment(0)).toBe('NEUTRAL');
    expect(scoreToSentiment(-0.25)).toBe('BEARISH');
    expect(scoreToSentiment(-0.75)).toBe('VERY_BEARISH');
  });

  it('clamps out-of-range input rather than throwing', () => {
    expect(scoreToSentiment(42)).toBe('VERY_BULLISH');
    expect(scoreToSentiment(-42)).toBe('VERY_BEARISH');
    expect(scoreToSentiment(Number.NaN)).toBe('VERY_BEARISH');
  });
});

describe('aggregateSentiment', () => {
  it('returns null for no signal rather than a misleading neutral', () => {
    expect(aggregateSentiment([])).toBeNull();
    expect(aggregateSentiment([{ score: 0.9, weight: 0 }])).toBeNull();
  });

  it('weights samples by their credibility', () => {
    // One highly-credible bearish source outweighs two weak bullish ones.
    const result = aggregateSentiment([
      { score: -1, weight: 10 },
      { score: 1, weight: 1 },
      { score: 1, weight: 1 },
    ]);
    expect(result).toBeLessThan(0);
  });

  it('averages symmetric input to zero', () => {
    expect(
      aggregateSentiment([
        { score: 1, weight: 1 },
        { score: -1, weight: 1 },
      ]),
    ).toBeCloseTo(0);
  });

  it('ignores non-finite samples', () => {
    expect(
      aggregateSentiment([
        { score: Number.NaN, weight: 5 },
        { score: 0.5, weight: 1 },
      ]),
    ).toBeCloseTo(0.5);
  });

  it('never returns a value outside [-1, 1]', () => {
    expect(aggregateSentiment([{ score: 5, weight: 1 }])).toBe(1);
    expect(aggregateSentiment([{ score: -5, weight: 1 }])).toBe(-1);
  });
});

describe('sentimentDelta', () => {
  it('is null when either side has no signal', () => {
    expect(sentimentDelta(null, 0.5)).toBeNull();
    expect(sentimentDelta(0.5, null)).toBeNull();
  });

  it('reports signed change', () => {
    expect(sentimentDelta(-0.5, 0.3)).toBeCloseTo(0.8);
    expect(sentimentDelta(0.5, -0.3)).toBeCloseTo(-0.8);
  });
});

describe('classifyWithLexicon', () => {
  it('reports no signal for neutral text', () => {
    const result = classifyWithLexicon('The quarterly meeting has been scheduled.');
    expect(result.score).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.matchedTerms).toEqual([]);
  });

  it('scores an exploit disclosure strongly bearish', () => {
    const result = classifyWithLexicon('Protocol exploited for $50M, funds drained from vault');
    expect(result.score).toBeLessThan(-0.5);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('scores a listing announcement bullish', () => {
    const result = classifyWithLexicon('Binance lists CRO with a new spot trading pair');
    expect(result.score).toBeGreaterThan(0.3);
  });

  it('handles negation by flipping polarity', () => {
    const plain = classifyWithLexicon('exploit confirmed');
    const negated = classifyWithLexicon('no exploit confirmed');
    expect(plain.score).toBeLessThan(0);
    expect(negated.score).toBeGreaterThan(0);
  });

  it('does not double-count a multi-word phrase as its parts', () => {
    const result = classifyWithLexicon('Bitcoin hits a new all-time high');
    expect(result.matchedTerms).toContain('all-time high');
    // "high" alone is not in the lexicon, so exactly one term should match here.
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('averages rather than sums, so length does not inflate the score', () => {
    const short = classifyWithLexicon('hack');
    const long = classifyWithLexicon(`hack ${'filler words here '.repeat(50)}`);
    expect(long.score).toBeCloseTo(short.score, 5);
  });

  it('takes confidence as the greater of term breadth and term magnitude', () => {
    // A lone extreme term is strong evidence on its own: treating "hack" as a
    // 0.25-confidence signal let a bullish model verdict survive an exploit
    // disclosure, which is exactly what reconciliation must prevent.
    expect(classifyWithLexicon('hack').confidence).toBeCloseTo(0.95);
    // A lone mild term stays appropriately tentative.
    expect(classifyWithLexicon('unlock').confidence).toBeCloseTo(0.4);
    // Breadth still saturates at 1.
    expect(classifyWithLexicon('hack exploit breach drained scam fraud').confidence).toBe(1);
    // Four mild terms reach full confidence through breadth alone.
    expect(classifyWithLexicon('unlock staking burn milestone').confidence).toBe(1);
  });
});

describe('reconcileSentiment', () => {
  const strongBearishLexicon = { score: -0.9, confidence: 1, matchedTerms: ['hack', 'drained'] };

  it('falls back to the lexicon when the model has no opinion', () => {
    const result = reconcileSentiment(null, 0, strongBearishLexicon);
    expect(result.score).toBeCloseTo(-0.9);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.disagreed).toBe(false);
  });

  it('trusts the model when the lexicon has no opinion', () => {
    const result = reconcileSentiment(0.7, 80, { score: 0, confidence: 0, matchedTerms: [] });
    expect(result.score).toBeCloseTo(0.7);
    expect(result.confidence).toBe(80);
    expect(result.disagreed).toBe(false);
  });

  it('overrides a model that calls an exploit bullish, and flags the conflict', () => {
    // This is the failure mode the reconciliation exists for.
    const result = reconcileSentiment(0.9, 85, strongBearishLexicon);
    expect(result.disagreed).toBe(true);
    expect(result.score).toBeLessThan(0);
    expect(result.confidence).toBeLessThan(85);
  });

  it('leaves mild disagreement alone', () => {
    const result = reconcileSentiment(0.3, 70, {
      score: -0.1,
      confidence: 0.5,
      matchedTerms: ['unlock'],
    });
    expect(result.disagreed).toBe(false);
    expect(result.score).toBeCloseTo(0.3);
  });

  it('never emits a confidence below 1', () => {
    const result = reconcileSentiment(1, 1, strongBearishLexicon);
    expect(result.confidence).toBeGreaterThanOrEqual(1);
  });
});
