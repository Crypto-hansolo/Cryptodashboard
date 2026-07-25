import { describe, expect, it } from 'vitest';
import { UpstreamError } from '@cid/core';
import { LexiconEnricher, LlmEnricher } from './enricher.js';
import { extractJsonBlock, parseLlmJson } from './json.js';
import { FakeLlmClient, fakeVerdictJson } from './testing.js';

const baseInput = {
  headline: 'Binance lists Cronos (CRO) for spot trading',
  body: 'Binance announced support for CRO spot trading with USDT and USDC pairs.',
  sourceName: 'CoinDesk',
  sourceCredibility: 0.85,
  coinSymbol: 'CRO',
  category: 'EXCHANGE_LISTING' as const,
  occurredAt: new Date(),
};

describe('extractJsonBlock', () => {
  it('finds a bare object', () => {
    expect(extractJsonBlock('{"a":1}')).toBe('{"a":1}');
  });

  it('finds JSON wrapped in prose, which small models do constantly', () => {
    expect(extractJsonBlock('Sure! Here is the JSON:\n{"a":1}\nHope that helps.')).toBe('{"a":1}');
  });

  it('prefers a fenced block', () => {
    expect(extractJsonBlock('text ```json\n{"a":1}\n``` more')).toBe('{"a":1}');
  });

  it('handles nested objects', () => {
    expect(extractJsonBlock('x {"a":{"b":[1,2]},"c":3} y')).toBe('{"a":{"b":[1,2]},"c":3}');
  });

  it('ignores braces inside string values', () => {
    const input = '{"summary":"a } brace and a \\" quote","b":2}';
    expect(extractJsonBlock(`noise ${input} noise`)).toBe(input);
  });

  it('finds an array', () => {
    expect(extractJsonBlock('here: [1,2,3]')).toBe('[1,2,3]');
  });

  it('returns null when there is no JSON', () => {
    expect(extractJsonBlock('no json here')).toBeNull();
    expect(extractJsonBlock('')).toBeNull();
  });

  it('returns null for an unterminated object', () => {
    expect(extractJsonBlock('{"a":1')).toBeNull();
  });
});

describe('parseLlmJson', () => {
  it('parses clean JSON', () => {
    expect(parseLlmJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('repairs a trailing comma', () => {
    expect(parseLlmJson('{"a":1,}')).toEqual({ a: 1 });
    expect(parseLlmJson('{"a":[1,2,],}')).toEqual({ a: [1, 2] });
  });

  it('repairs Python-style literals', () => {
    expect(parseLlmJson('{"a":None,"b":True,"c":False}')).toEqual({ a: null, b: true, c: false });
  });

  it('repairs smart quotes', () => {
    expect(parseLlmJson('{“a”:1}')).toEqual({ a: 1 });
  });

  it('extracts from prose before repairing', () => {
    expect(parseLlmJson('Here you go:\n```json\n{"a":1,}\n```')).toEqual({ a: 1 });
  });

  it('returns null for unrecoverable output', () => {
    expect(parseLlmJson('I refuse to answer.')).toBeNull();
    expect(parseLlmJson('')).toBeNull();
  });
});

describe('LlmEnricher', () => {
  it('produces a complete verdict from a well-formed response', async () => {
    const enricher = new LlmEnricher({
      llm: new FakeLlmClient({ responses: [fakeVerdictJson()] }),
    });
    const result = await enricher.enrich(baseInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.summary).toBe('A concise factual summary.');
    expect(result.value.sentiment).toBe('BULLISH');
    expect(result.value.importance).toBeGreaterThan(0);
    expect(result.value.importance).toBeLessThanOrEqual(100);
    expect(result.value.narratives).toEqual(['etf-flows']);
  });

  it('tolerates prose-wrapped JSON', async () => {
    const llm = new FakeLlmClient({
      responses: [
        `Certainly! Here is my analysis:\n\`\`\`json\n${fakeVerdictJson()}\n\`\`\`\nLet me know!`,
      ],
    });
    const result = await new LlmEnricher({ llm }).enrich(baseInput);
    expect(result.ok).toBe(true);
  });

  it('normalises loose enum casing', async () => {
    const llm = new FakeLlmClient({
      responses: [fakeVerdictJson({ sentiment: 'very bullish', category: 'exchange listing' })],
    });
    const result = await new LlmEnricher({ llm }).enrich(baseInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sentiment).toBe('VERY_BULLISH');
      expect(result.value.category).toBe('EXCHANGE_LISTING');
    }
  });

  it('coerces numbers returned as strings', async () => {
    const llm = new FakeLlmClient({
      responses: [
        JSON.stringify({ ...JSON.parse(fakeVerdictJson()), importance: '85', confidence: '90' }),
      ],
    });
    const result = await new LlmEnricher({ llm }).enrich(baseInput);
    expect(result.ok).toBe(true);
  });

  it('falls back to the headline when the model gives no summary', async () => {
    const llm = new FakeLlmClient({ responses: [fakeVerdictJson({ summary: '' })] });
    const result = await new LlmEnricher({ llm }).enrich(baseInput);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.summary).toContain('Binance lists Cronos');
  });

  // The central behaviour: the platform does not simply believe the model.
  it('overrides a bullish verdict on an exploit disclosure', async () => {
    const llm = new FakeLlmClient({
      responses: [fakeVerdictJson({ sentiment: 'VERY_BULLISH', importance: 90, confidence: 95 })],
    });
    const result = await new LlmEnricher({ llm }).enrich({
      ...baseInput,
      headline: 'Protocol exploited for $50M as attacker drains the lending vault',
      body: 'The team says user funds are safe and a fix is deployed.',
      category: 'SECURITY',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The lexicon is confident and bearish; it must win.
    expect(result.value.sentimentScore).toBeLessThan(0);
    expect(['BEARISH', 'VERY_BEARISH']).toContain(result.value.sentiment);
    // And the contradiction must reduce reported confidence.
    expect(result.value.confidence).toBeLessThan(95);
  });

  it('derives impact from computed importance, ignoring a contradictory model claim', async () => {
    const llm = new FakeLlmClient({
      responses: [fakeVerdictJson({ importance: 5, impact: 'CRITICAL', category: 'SOCIAL' })],
    });
    const result = await new LlmEnricher({ llm }).enrich({ ...baseInput, category: 'SOCIAL' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // impact must be consistent with importance, or the UI contradicts itself.
    expect(result.value.impact).not.toBe('CRITICAL');
  });

  it('does not let the model dictate importance outright', async () => {
    const high = new FakeLlmClient({ responses: [fakeVerdictJson({ importance: 100 })] });
    const low = new FakeLlmClient({ responses: [fakeVerdictJson({ importance: 1 })] });

    const highResult = await new LlmEnricher({ llm: high }).enrich({
      ...baseInput,
      category: 'SOCIAL',
    });
    const lowResult = await new LlmEnricher({ llm: low }).enrich({
      ...baseInput,
      category: 'SOCIAL',
    });

    expect(highResult.ok && lowResult.ok).toBe(true);
    if (!highResult.ok || !lowResult.ok) return;
    // The model moves the score but does not own it.
    expect(highResult.value.importance).toBeGreaterThan(lowResult.value.importance);
    expect(highResult.value.importance).toBeLessThan(100);
  });

  it('normalises and bounds narrative labels', async () => {
    const llm = new FakeLlmClient({
      responses: [
        fakeVerdictJson({
          narratives: ['ETF Flows', '  RESTAKING  ', 'x', 'a'.repeat(60), 'l2-wars', 'extra-one'],
        }),
      ],
    });
    const result = await new LlmEnricher({ llm }).enrich(baseInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Lowercased, kebab-cased, junk dropped, capped at 3.
    expect(result.value.narratives).toEqual(['etf-flows', 'restaking', 'l2-wars']);
  });

  it('returns an error for unparseable output rather than inventing a verdict', async () => {
    const llm = new FakeLlmClient({ responses: ['I am a language model and cannot help.'] });
    const result = await new LlmEnricher({ llm }).enrich(baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('unparseable');
  });

  it('propagates a provider failure', async () => {
    const llm = new FakeLlmClient({
      responses: [],
      failWith: new UpstreamError('fake', 'model offline'),
    });
    const result = await new LlmEnricher({ llm }).enrich(baseInput);
    expect(result.ok).toBe(false);
  });

  it('sends the asset, source and category in the prompt', async () => {
    const llm = new FakeLlmClient({ responses: [fakeVerdictJson()] });
    await new LlmEnricher({ llm }).enrich(baseInput);

    const userMessage = llm.prompts[0]?.[1]?.content ?? '';
    expect(userMessage).toContain('CRO');
    expect(userMessage).toContain('CoinDesk');
    expect(userMessage).toContain('EXCHANGE_LISTING');
  });

  it('truncates a very long body to protect the context window', async () => {
    const llm = new FakeLlmClient({ responses: [fakeVerdictJson()] });
    await new LlmEnricher({ llm, maxBodyChars: 100 }).enrich({
      ...baseInput,
      body: 'word '.repeat(5_000),
    });

    const userMessage = llm.prompts[0]?.[1]?.content ?? '';
    expect(userMessage.length).toBeLessThan(1_000);
  });
});

describe('LexiconEnricher', () => {
  it('produces a usable verdict with no model at all', async () => {
    const result = await new LexiconEnricher().enrich(baseInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.summary).toContain('Binance lists Cronos');
    expect(result.value.sentiment).toBe('BULLISH');
    expect(result.value.importance).toBeGreaterThan(0);
    expect(result.value.impact).toBeTruthy();
  });

  it('scores an exploit bearish', async () => {
    const result = await new LexiconEnricher().enrich({
      ...baseInput,
      headline: 'Protocol exploited, funds drained',
      body: null,
      category: 'SECURITY',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.sentimentScore).toBeLessThan(0);
  });

  it('reports lower confidence than the LLM path, since no model read the text', async () => {
    const lexiconResult = await new LexiconEnricher().enrich(baseInput);
    const llmResult = await new LlmEnricher({
      llm: new FakeLlmClient({ responses: [fakeVerdictJson({ confidence: 90 })] }),
    }).enrich(baseInput);

    expect(lexiconResult.ok && llmResult.ok).toBe(true);
    if (!lexiconResult.ok || !llmResult.ok) return;
    expect(lexiconResult.value.confidence).toBeLessThan(llmResult.value.confidence);
  });

  it('never emits narratives, which need a model', async () => {
    const result = await new LexiconEnricher().enrich(baseInput);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.narratives).toEqual([]);
  });
});
