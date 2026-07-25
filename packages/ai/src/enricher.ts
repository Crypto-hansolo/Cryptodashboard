import { z } from 'zod';
import {
  EVENT_CATEGORIES,
  IMPACT_LEVELS,
  SENTIMENT_LABELS,
  classifyWithLexicon,
  clamp,
  computeConfidence,
  computeImportance,
  err,
  importanceToImpact,
  ok,
  reconcileSentiment,
  scoreToSentiment,
  sentimentToScore,
  truncate,
  type DomainError,
  type Enricher,
  type EnrichmentVerdict,
  type EventCategory,
  type LlmClient,
  type Logger,
  type Result,
  type SentimentLabel,
} from '@cid/core';
import { noopLogger, UpstreamError } from '@cid/core';
import { parseLlmJson } from './json.js';

/**
 * Event enrichment.
 *
 * The division of labour matters: the model supplies *judgement* (a summary, an
 * explanation, a narrative label, a sentiment direction), and the deterministic
 * scoring functions in `@cid/core` supply the *numbers*. That way scores stay
 * reproducible and comparable across coins and across model swaps, while still
 * benefiting from the model's reading of the text.
 *
 * The model's importance/confidence estimates are inputs to `computeImportance`
 * and `computeConfidence`, weighted alongside category priors, source
 * credibility, magnitude and corroboration — never used raw.
 */

/** JSON Schema handed to the provider for constrained decoding. */
const VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['summary', 'explanation', 'sentiment', 'importance', 'confidence', 'category'],
  properties: {
    summary: { type: 'string', description: 'One or two sentences, factual, no hedging.' },
    explanation: {
      type: 'string',
      description: 'Why this matters for the asset, and the likely mechanism of any price effect.',
    },
    sentiment: { type: 'string', enum: [...SENTIMENT_LABELS] },
    importance: { type: 'integer', minimum: 1, maximum: 100 },
    confidence: { type: 'integer', minimum: 1, maximum: 100 },
    impact: { type: 'string', enum: [...IMPACT_LEVELS] },
    category: { type: 'string', enum: [...EVENT_CATEGORIES] },
    narratives: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    isFud: { type: 'boolean' },
  },
};

/**
 * Response schema. Every field is coerced or defaulted, because "the model
 * returned importance as the string '80'" is a Tuesday, not an exception.
 */
const verdictResponseSchema = z.object({
  summary: z.string().default(''),
  explanation: z.string().default(''),
  sentiment: z
    .string()
    .transform((value) =>
      value
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, '_'),
    )
    .pipe(z.enum(SENTIMENT_LABELS))
    .catch('NEUTRAL'),
  importance: z.coerce.number().catch(50),
  confidence: z.coerce.number().catch(50),
  impact: z
    .string()
    .transform((value) => value.trim().toUpperCase())
    .pipe(z.enum(IMPACT_LEVELS))
    .nullish()
    .catch(null),
  category: z
    .string()
    .transform((value) =>
      value
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, '_'),
    )
    .pipe(z.enum(EVENT_CATEGORIES))
    .nullish()
    .catch(null),
  narratives: z.array(z.string()).default([]).catch([]),
  isFud: z.coerce.boolean().default(false).catch(false),
});

const SYSTEM_PROMPT = `You are a crypto market analyst. You classify news, social and on-chain events for a professional intelligence terminal.

Rules:
- Be factual and specific. Never hedge with "may" or "could" when the event is definite.
- Judge market impact on the asset named, not on crypto generally.
- A security incident, exploit or regulatory action is bearish even when the announcement is worded reassuringly.
- An exchange listing, mainnet launch or major integration is bullish.
- A token unlock increasing float is bearish; a burn reducing it is bullish.
- Rate importance by how much a trader holding this asset would care, 1-100.
- Rate confidence by how verifiable the claim is, 1-100. A single anonymous source is low confidence regardless of how dramatic the claim.
- Set isFud true only for coordinated misinformation, not for genuine bad news.
- narratives: 0-3 short lowercase kebab-case themes, e.g. "etf-flows", "restaking", "l2-wars".

Respond with JSON only. No prose before or after.`;

export interface LlmEnricherOptions {
  llm: LlmClient;
  logger?: Logger;
  /** Trim inputs so a long article cannot blow a small context window. */
  maxBodyChars?: number;
}

export class LlmEnricher implements Enricher {
  readonly #llm: LlmClient;
  readonly #logger: Logger;
  readonly #maxBodyChars: number;

  constructor(options: LlmEnricherOptions) {
    this.#llm = options.llm;
    this.#logger = (options.logger ?? noopLogger).child({ component: 'enricher' });
    // ~1500 chars is plenty for a verdict and keeps an 8B model's context free.
    this.#maxBodyChars = options.maxBodyChars ?? 1_500;
  }

  async enrich(input: {
    headline: string;
    body: string | null;
    sourceName: string;
    sourceCredibility: number;
    coinSymbol: string | null;
    category: EventCategory;
    occurredAt: Date;
  }): Promise<Result<EnrichmentVerdict, DomainError>> {
    const lexicon = classifyWithLexicon(`${input.headline} ${input.body ?? ''}`);

    const userPrompt = [
      `Asset: ${input.coinSymbol ?? 'unknown'}`,
      `Source: ${input.sourceName}`,
      `Category hint: ${input.category}`,
      `Occurred: ${input.occurredAt.toISOString()}`,
      '',
      `Headline: ${input.headline}`,
      input.body ? `\nBody: ${truncate(input.body, this.#maxBodyChars)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const completion = await this.#llm.complete(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      { jsonSchema: VERDICT_SCHEMA, temperature: 0.2, maxTokens: 700 },
    );

    if (!completion.ok) return err(completion.error);

    const raw = parseLlmJson(completion.value.text);
    if (raw === null) {
      this.#logger.warn(
        { preview: completion.value.text.slice(0, 200) },
        'model output was not parseable as JSON',
      );
      return err(new UpstreamError(this.#llm.provider, 'unparseable model output'));
    }

    const parsed = verdictResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return err(new UpstreamError(this.#llm.provider, 'model output failed validation'));
    }

    return ok(
      this.#reconcile({
        model: parsed.data,
        lexicon,
        input,
      }),
    );
  }

  /**
   * Combine the model's judgement with deterministic scoring.
   *
   * This is where the platform refuses to simply believe the model.
   */
  #reconcile(args: {
    model: z.infer<typeof verdictResponseSchema>;
    lexicon: ReturnType<typeof classifyWithLexicon>;
    input: {
      headline: string;
      sourceCredibility: number;
      category: EventCategory;
      occurredAt: Date;
    };
  }): EnrichmentVerdict {
    const { model, lexicon, input } = args;

    // Sentiment: the reconciliation in @cid/core overrides the model when it
    // contradicts a confident lexicon reading — the classic failure being an
    // exploit disclosure scored bullish because it ends "funds are safe".
    const modelScore = sentimentToScore(model.sentiment);
    const modelConfidence = Math.round(clamp(model.confidence, 1, 100));
    const reconciled = reconcileSentiment(modelScore, modelConfidence, lexicon);
    const sentimentScore = reconciled.score ?? 0;
    const sentiment: SentimentLabel = scoreToSentiment(sentimentScore);

    // The model may reclassify the category; trust it over the keyword hint,
    // since it has read the whole text.
    const category = model.category ?? input.category;

    // Importance is computed, not taken. The model's number is one weighted
    // input among the category prior, source credibility and recency.
    const importance = computeImportance({
      category,
      sourceCredibility: input.sourceCredibility,
      modelImportance: Math.round(clamp(model.importance, 1, 100)),
      ageMs: Date.now() - input.occurredAt.getTime(),
    });

    const confidence = computeConfidence({
      sourceCredibility: input.sourceCredibility,
      modelConfidence,
      signalsAgree: !reconciled.disagreed,
      hasHardData: false,
    });

    if (reconciled.disagreed) {
      this.#logger.debug(
        {
          headline: truncate(input.headline, 80),
          modelSentiment: model.sentiment,
          lexiconScore: lexicon.score,
        },
        'model and lexicon disagreed on sentiment direction; lexicon weighted in',
      );
    }

    return {
      summary: model.summary.trim() || truncate(input.headline, 200),
      explanation: model.explanation.trim(),
      sentiment,
      sentimentScore,
      importance,
      confidence,
      // Derive impact from the computed importance so the two can never
      // contradict each other in the UI, even if the model said otherwise.
      impact: importanceToImpact(importance),
      category,
      narratives: model.narratives
        .map((narrative) => narrative.trim().toLowerCase().replace(/\s+/g, '-'))
        .filter((narrative) => narrative.length > 1 && narrative.length <= 40)
        .slice(0, 3),
      isFud: model.isFud,
    };
  }
}

/**
 * Deterministic fallback enricher, used when `LLM_PROVIDER=null` or the model
 * backend is unreachable.
 *
 * Not a stub: it produces genuinely useful scores from the lexicon plus the same
 * structural priors the LLM path uses, so the timeline, alerts and reports all
 * work without any model at all. Confidence is capped to reflect that no model
 * read the text.
 */
export class LexiconEnricher implements Enricher {
  async enrich(input: {
    headline: string;
    body: string | null;
    sourceName: string;
    sourceCredibility: number;
    coinSymbol: string | null;
    category: EventCategory;
    occurredAt: Date;
  }): Promise<Result<EnrichmentVerdict, DomainError>> {
    const lexicon = classifyWithLexicon(`${input.headline} ${input.body ?? ''}`);

    const importance = computeImportance({
      category: input.category,
      sourceCredibility: input.sourceCredibility,
      ageMs: Date.now() - input.occurredAt.getTime(),
    });

    const confidence = computeConfidence({
      sourceCredibility: input.sourceCredibility,
      // No model read this, so confidence is bounded by the lexicon's own.
      modelConfidence: Math.round(lexicon.confidence * 45),
      signalsAgree: true,
      hasHardData: false,
    });

    return ok({
      summary: truncate(input.headline, 200),
      explanation: '',
      sentiment: scoreToSentiment(lexicon.score),
      sentimentScore: lexicon.score,
      importance,
      confidence,
      impact: importanceToImpact(importance),
      category: input.category,
      narratives: [],
      isFud: false,
    });
  }
}
