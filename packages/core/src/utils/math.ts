/** Small numeric helpers shared by the scoring services. */

export function clamp(value: number, min: number, max: number): number {
  // NaN has no meaningful position on the range, so it collapses to `min`.
  // ±Infinity does — it must clamp to the corresponding bound, not to `min`.
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Clamp to [0,100] and round — the shape every public score takes. */
export function toScore100(value: number): number {
  return Math.round(clamp(value, 0, 100));
}

/** Percentage change from `from` to `to`. `null` when `from` is 0 or invalid. */
export function pctChange(from: number, to: number): number | null {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

/**
 * Logarithmic normalisation onto [0,1].
 *
 * Nearly every crypto quantity is heavy-tailed (market caps, follower counts,
 * transfer sizes). Linear scaling makes a $2B cap and a $200B cap both "big";
 * log scaling preserves the distinction where it matters.
 */
export function logNormalize(value: number, midpoint: number, steepness = 1): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(midpoint) || midpoint <= 0) return 0;
  const ratio = Math.log10(value / midpoint) * steepness;
  // Logistic squash so the midpoint maps to exactly 0.5.
  return 1 / (1 + Math.exp(-ratio));
}

export function mean(values: readonly number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

export function median(values: readonly number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 === 0 ? (finite[mid - 1]! + finite[mid]!) / 2 : finite[mid]!;
}

export function stdDev(values: readonly number[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return null;
  const m = finite.reduce((a, b) => a + b, 0) / finite.length;
  const variance = finite.reduce((acc, v) => acc + (v - m) ** 2, 0) / (finite.length - 1);
  return Math.sqrt(variance);
}

/**
 * How many standard deviations `value` sits from the baseline mean.
 * `null` when the baseline is too small or flat to say anything.
 */
export function zScore(value: number, baseline: readonly number[]): number | null {
  const m = mean(baseline);
  const sd = stdDev(baseline);
  if (m === null || sd === null || sd === 0) return null;
  return (value - m) / sd;
}

/**
 * Ratio of `value` to a baseline mean — "5x normal".
 * Guards the zero-baseline case, which is common for low-activity coins.
 */
export function velocityRatio(value: number, baseline: readonly number[]): number | null {
  const m = mean(baseline);
  if (m === null) return null;
  if (m === 0) return value > 0 ? Number.POSITIVE_INFINITY : 0;
  return value / m;
}

/**
 * Weighted sum of named components, where weights need not total 1.
 * Components with a `null` value are dropped and the remaining weights are
 * renormalised, so a missing input never silently drags a score to zero.
 */
export function weightedScore(
  components: readonly { value: number | null; weight: number }[],
): number | null {
  let sum = 0;
  let totalWeight = 0;
  for (const { value, weight } of components) {
    if (value === null || !Number.isFinite(value) || weight <= 0) continue;
    sum += value * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) return null;
  return sum / totalWeight;
}

/** Exponential decay factor on [0,1]: 1 at age 0, 0.5 at `halfLifeMs`. */
export function timeDecay(ageMs: number, halfLifeMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return 0;
  return Math.pow(0.5, ageMs / halfLifeMs);
}
