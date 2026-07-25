import { SENTIMENT_SCORES, type SentimentLabel } from '../domain/enums.js';
import { clamp } from '../utils/math.js';

/**
 * Sentiment lives on a continuous [-1, 1] scale internally; the five labels are
 * a presentation layer over it. Everything aggregates numerically and converts
 * once, at the edge — averaging labels directly is how you end up claiming that
 * "very bullish + very bearish = neutral-ish" with false confidence.
 */

/** Label -> canonical numeric anchor. */
export function sentimentToScore(label: SentimentLabel): number {
  return SENTIMENT_SCORES[label];
}

/**
 * Numeric score -> label, using midpoints between the anchors as boundaries
 * (±0.75 and ±0.25). Ties round toward the more extreme label.
 */
export function scoreToSentiment(score: number): SentimentLabel {
  const s = clamp(score, -1, 1);
  if (s >= 0.75) return 'VERY_BULLISH';
  if (s >= 0.25) return 'BULLISH';
  if (s > -0.25) return 'NEUTRAL';
  if (s > -0.75) return 'BEARISH';
  return 'VERY_BEARISH';
}

export interface WeightedSentiment {
  score: number;
  /** Non-negative weight: source credibility, author authority, engagement, ... */
  weight: number;
}

/**
 * Weighted mean sentiment. Returns `null` for an empty or zero-weight input
 * rather than a misleading 0 — "no signal" and "neutral" are different claims,
 * and the UI renders them differently.
 */
export function aggregateSentiment(samples: readonly WeightedSentiment[]): number | null {
  let weighted = 0;
  let total = 0;
  for (const { score, weight } of samples) {
    if (!Number.isFinite(score) || !Number.isFinite(weight) || weight <= 0) continue;
    weighted += clamp(score, -1, 1) * weight;
    total += weight;
  }
  if (total === 0) return null;
  return clamp(weighted / total, -1, 1);
}

/**
 * Change in mean sentiment between two windows, used by SENTIMENT_SHIFT alerts.
 * `null` when either side has no signal — a shift from "unknown" is not a shift.
 */
export function sentimentDelta(previous: number | null, current: number | null): number | null {
  if (previous === null || current === null) return null;
  return clamp(current, -1, 1) - clamp(previous, -1, 1);
}

// ─── Lexicon fallback ────────────────────────────────────────────────────────

/**
 * Deterministic lexicon classifier.
 *
 * This is *not* trying to beat the LLM. It exists because (a) the LLM may be
 * unavailable or disabled (`LLM_PROVIDER=null`), (b) enrichment is async and the
 * timeline should not show blank sentiment for the ~seconds before the model
 * catches up, and (c) it gives the enrichment pipeline a cheap sanity check
 * against a model that returns "VERY_BULLISH" for a hack disclosure.
 *
 * Weights are crypto-specific and intentionally asymmetric: the market punishes
 * bad news harder than it rewards good news.
 */
const BULLISH_TERMS: Readonly<Record<string, number>> = Object.freeze({
  listing: 0.7,
  lists: 0.6,
  listed: 0.6,
  partnership: 0.5,
  integration: 0.4,
  mainnet: 0.5,
  launch: 0.35,
  upgrade: 0.4,
  approved: 0.7,
  approval: 0.65,
  etf: 0.5,
  adoption: 0.5,
  surge: 0.6,
  surges: 0.6,
  rally: 0.6,
  rallies: 0.6,
  soars: 0.7,
  breakout: 0.6,
  'all-time high': 0.8,
  ath: 0.6,
  buyback: 0.6,
  burn: 0.45,
  burned: 0.45,
  staking: 0.3,
  acquisition: 0.4,
  funding: 0.4,
  raise: 0.35,
  bullish: 0.7,
  accumulating: 0.45,
  accumulation: 0.45,
  inflow: 0.4,
  inflows: 0.4,
  outperform: 0.5,
  milestone: 0.35,
  record: 0.4,
});

const BEARISH_TERMS: Readonly<Record<string, number>> = Object.freeze({
  hack: -0.95,
  hacked: -0.95,
  exploit: -0.9,
  exploited: -0.9,
  exploits: -0.9,
  breach: -0.8,
  breached: -0.8,
  drained: -0.9,
  drains: -0.9,
  draining: -0.9,
  rugpull: -1,
  rug: -0.8,
  scam: -0.85,
  fraud: -0.85,
  lawsuit: -0.7,
  sued: -0.7,
  sec: -0.35,
  subpoena: -0.6,
  investigation: -0.6,
  probe: -0.5,
  delisting: -0.85,
  delist: -0.85,
  delisted: -0.85,
  halt: -0.6,
  halted: -0.6,
  suspended: -0.65,
  bankruptcy: -0.95,
  insolvent: -0.95,
  liquidated: -0.6,
  liquidation: -0.55,
  liquidations: -0.55,
  crash: -0.8,
  crashes: -0.8,
  plunge: -0.75,
  plunges: -0.75,
  plummet: -0.75,
  tumbles: -0.6,
  dump: -0.6,
  dumping: -0.65,
  selloff: -0.65,
  'sell-off': -0.65,
  bearish: -0.7,
  outflow: -0.4,
  outflows: -0.4,
  unlock: -0.4,
  unlocks: -0.4,
  dilution: -0.55,
  inflation: -0.3,
  downtime: -0.5,
  outage: -0.6,
  vulnerability: -0.6,
  fud: -0.3,
  warning: -0.45,
  ban: -0.7,
  banned: -0.7,
  restricted: -0.5,
  fine: -0.5,
  penalty: -0.55,
});

/** Terms that invert the polarity of a nearby match. */
const NEGATIONS: readonly string[] = ['no', 'not', 'never', 'without', 'denies', 'denied', 'false'];

export interface LexiconResult {
  score: number;
  /** Confidence on [0,1] — grows with the number of matched terms. */
  confidence: number;
  matchedTerms: string[];
}

/**
 * Score text with the lexicon.
 *
 * Multi-word terms are matched before single words so "all-time high" is not
 * double counted as "high". Negation flips a term's sign when a negator appears
 * within the preceding three tokens.
 */
export function classifyWithLexicon(text: string): LexiconResult {
  const normalized = text.toLowerCase();
  const tokens = normalized.split(/[^a-z0-9'-]+/).filter(Boolean);
  const matched: string[] = [];
  let sum = 0;
  let maxMagnitude = 0;

  // Multi-word phrases, checked against the raw normalized string.
  for (const [term, weight] of [
    ...Object.entries(BULLISH_TERMS),
    ...Object.entries(BEARISH_TERMS),
  ]) {
    if (!term.includes(' ')) continue;
    if (normalized.includes(term)) {
      sum += weight;
      maxMagnitude = Math.max(maxMagnitude, Math.abs(weight));
      matched.push(term);
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const weight = BULLISH_TERMS[token] ?? BEARISH_TERMS[token];
    if (weight === undefined) continue;

    const window = tokens.slice(Math.max(0, i - 3), i);
    const negated = window.some((t) => NEGATIONS.includes(t));
    sum += negated ? -weight : weight;
    maxMagnitude = Math.max(maxMagnitude, Math.abs(weight));
    matched.push(negated ? `not:${token}` : token);
  }

  if (matched.length === 0) {
    return { score: 0, confidence: 0, matchedTerms: [] };
  }

  // Mean of matched weights, so a long article is not scored more extremely
  // than a headline making the same claim.
  const score = clamp(sum / matched.length, -1, 1);

  /*
   * Confidence is the greater of breadth and depth:
   *  - breadth: matched-term count, saturating at 4
   *  - depth:   the largest single |weight| seen
   *
   * Depth matters because a lone extreme term is genuinely strong evidence.
   * "exploited" (-0.9) appearing once is not a 0.25-confidence signal, and
   * treating it as one let a cheerfully-worded exploit disclosure ("funds are
   * safe") keep a model's bullish verdict — the exact failure the reconciliation
   * pass exists to catch.
   */
  const confidence = clamp(Math.max(matched.length / 4, maxMagnitude), 0, 1);
  return { score, confidence, matchedTerms: matched };
}

/**
 * Reconcile a model verdict with the lexicon.
 *
 * When they disagree sharply and the lexicon is confident, we pull the result
 * toward the lexicon and report reduced confidence. In practice this catches the
 * most damaging local-LLM failure mode: cheerfully labelling an exploit
 * disclosure as bullish because the post ends with "funds are safe".
 */
export function reconcileSentiment(
  modelScore: number | null,
  modelConfidence: number,
  lexicon: LexiconResult,
): { score: number | null; confidence: number; disagreed: boolean } {
  if (modelScore === null) {
    return lexicon.confidence > 0
      ? { score: lexicon.score, confidence: Math.round(lexicon.confidence * 50), disagreed: false }
      : { score: null, confidence: 0, disagreed: false };
  }
  if (lexicon.confidence === 0) {
    return { score: clamp(modelScore, -1, 1), confidence: modelConfidence, disagreed: false };
  }

  const model = clamp(modelScore, -1, 1);
  const gap = Math.abs(model - lexicon.score);
  // Opposite signs and a wide gap: treat as a genuine conflict.
  const conflicting = gap > 0.8 && Math.sign(model) !== Math.sign(lexicon.score);

  if (!conflicting) {
    return { score: model, confidence: modelConfidence, disagreed: false };
  }

  const blended = model * (1 - lexicon.confidence) + lexicon.score * lexicon.confidence;
  return {
    score: clamp(blended, -1, 1),
    confidence: Math.max(1, Math.round(modelConfidence * (1 - lexicon.confidence * 0.5))),
    disagreed: true,
  };
}
