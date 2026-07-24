import { describe, expect, it } from 'vitest';
import {
  clamp,
  logNormalize,
  mean,
  median,
  pctChange,
  stdDev,
  timeDecay,
  toScore100,
  velocityRatio,
  weightedScore,
  zScore,
} from './math.js';

describe('clamp / toScore100', () => {
  it('bounds values', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
  });

  it('maps non-finite input to the lower bound rather than propagating NaN', () => {
    expect(clamp(Number.NaN, 0, 10)).toBe(0);
    expect(clamp(Number.POSITIVE_INFINITY, 0, 10)).toBe(10);
  });

  it('rounds into [0,100]', () => {
    expect(toScore100(55.6)).toBe(56);
    expect(toScore100(-3)).toBe(0);
    expect(toScore100(1000)).toBe(100);
  });
});

describe('pctChange', () => {
  it('computes signed percentage change', () => {
    expect(pctChange(100, 110)).toBeCloseTo(10);
    expect(pctChange(100, 90)).toBeCloseTo(-10);
  });

  it('uses the magnitude of the base, so a negative base does not invert the sign', () => {
    expect(pctChange(-100, -90)).toBeCloseTo(10);
  });

  it('returns null for a zero or invalid base', () => {
    expect(pctChange(0, 10)).toBeNull();
    expect(pctChange(Number.NaN, 10)).toBeNull();
  });
});

describe('logNormalize', () => {
  it('maps the midpoint to exactly 0.5', () => {
    expect(logNormalize(1_000_000, 1_000_000)).toBeCloseTo(0.5);
  });

  it('is monotonically increasing', () => {
    const points = [1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9].map((v) => logNormalize(v, 1e6));
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!).toBeGreaterThan(points[i - 1]!);
    }
  });

  it('stays within (0,1) for extreme inputs', () => {
    expect(logNormalize(1e18, 1e6)).toBeLessThanOrEqual(1);
    expect(logNormalize(1e-6, 1e6)).toBeGreaterThanOrEqual(0);
  });

  it('returns 0 for non-positive or invalid input', () => {
    expect(logNormalize(0, 100)).toBe(0);
    expect(logNormalize(-5, 100)).toBe(0);
    expect(logNormalize(100, 0)).toBe(0);
  });

  it('distinguishes heavy-tail magnitudes that linear scaling would flatten', () => {
    const twoBillion = logNormalize(2e9, 1e9);
    const twoHundredBillion = logNormalize(2e11, 1e9);
    expect(twoHundredBillion - twoBillion).toBeGreaterThan(0.15);
  });
});

describe('mean / median / stdDev', () => {
  it('computes central tendency', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it('returns null for empty input', () => {
    expect(mean([])).toBeNull();
    expect(median([])).toBeNull();
    expect(stdDev([])).toBeNull();
    expect(stdDev([1])).toBeNull();
  });

  it('ignores non-finite values', () => {
    expect(mean([1, Number.NaN, 3])).toBe(2);
  });

  it('computes the sample standard deviation', () => {
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 2);
  });
});

describe('zScore', () => {
  it('measures deviation from the baseline', () => {
    expect(zScore(10, [1, 2, 3, 4, 5])).toBeGreaterThan(3);
    expect(zScore(3, [1, 2, 3, 4, 5])).toBeCloseTo(0);
  });

  it('returns null for a flat or tiny baseline', () => {
    expect(zScore(5, [3, 3, 3])).toBeNull();
    expect(zScore(5, [3])).toBeNull();
  });
});

describe('velocityRatio', () => {
  it('expresses the value as a multiple of the baseline', () => {
    expect(velocityRatio(30, [10, 10, 10])).toBeCloseTo(3);
  });

  it('reports Infinity when the baseline is zero but activity is not', () => {
    expect(velocityRatio(5, [0, 0])).toBe(Number.POSITIVE_INFINITY);
    expect(velocityRatio(0, [0, 0])).toBe(0);
  });

  it('returns null with no baseline', () => {
    expect(velocityRatio(5, [])).toBeNull();
  });
});

describe('weightedScore', () => {
  it('renormalises around missing components', () => {
    // A null component must not drag the result toward zero.
    const withNull = weightedScore([
      { value: 80, weight: 1 },
      { value: null, weight: 9 },
    ]);
    expect(withNull).toBe(80);
  });

  it('weights components as specified', () => {
    expect(
      weightedScore([
        { value: 100, weight: 3 },
        { value: 0, weight: 1 },
      ]),
    ).toBe(75);
  });

  it('returns null when nothing is usable', () => {
    expect(weightedScore([])).toBeNull();
    expect(weightedScore([{ value: null, weight: 1 }])).toBeNull();
    expect(weightedScore([{ value: 50, weight: 0 }])).toBeNull();
  });
});

describe('timeDecay', () => {
  it('is 1 at age zero and 0.5 at one half-life', () => {
    expect(timeDecay(0, 1000)).toBe(1);
    expect(timeDecay(1000, 1000)).toBeCloseTo(0.5);
    expect(timeDecay(2000, 1000)).toBeCloseTo(0.25);
  });

  it('handles degenerate input', () => {
    expect(timeDecay(-5, 1000)).toBe(1);
    expect(timeDecay(100, 0)).toBe(0);
  });
});
