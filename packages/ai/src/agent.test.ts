import { describe, expect, it } from 'vitest';
import { UpstreamError, type Event, type Repositories, type Source } from '@cid/core';
import { ResearchAgent } from './agent.js';
import { fakeRepositories } from '@cid/platform/testing';
import { FakeEmbeddingClient, FakeLlmClient } from './testing.js';

/**
 * The agent's contract is "answer from the database, or say you cannot".
 *
 * The failure mode that destroys trust in a tool like this is a confident answer
 * assembled from a model's training data, so the tests below are mostly about
 * refusing to answer, attaching evidence to every answer, and degrading to
 * something honest when a component is missing.
 */

const NOW = new Date('2026-07-25T12:00:00.000Z');

function event(overrides: Partial<Event> = {}): Event {
  return {
    id: 'event-1',
    sourceId: 'source-1',
    coinId: 'coin-cro',
    occurredAt: new Date(NOW.getTime() - 2 * 3_600_000),
    ingestedAt: NOW,
    category: 'EXCHANGE_LISTING',
    subtype: 'spot_listing',
    headline: 'Binance lists Cronos (CRO) for spot trading',
    body: 'The exchange will open CRO/USDT markets.',
    url: 'https://www.coindesk.com/markets/binance-cro',
    author: 'CoinDesk Staff',
    relatedCoinIds: [],
    clusterId: null,
    dedupeHash: 'hash-1',
    payload: {},
    intelligence: {
      summary: 'Binance will list CRO for spot trading on 26 July.',
      explanation: null,
      sentiment: 'VERY_BULLISH',
      sentimentScore: 0.8,
      importance: 88,
      confidence: 82,
      impact: 'HIGH',
      narratives: ['exchange-listings'],
      isFud: false,
      model: null,
      enrichedAt: NOW,
    },
    ...overrides,
  } as Event;
}

const source: Source = {
  id: 'source-1',
  key: 'coindesk',
  name: 'CoinDesk',
  kind: 'NEWS',
  homepageUrl: 'https://www.coindesk.com',
  credibility: 0.9,
  isEnabled: true,
  createdAt: NOW,
  updatedAt: NOW,
} as Source;

/** Repositories wired for a single retrievable event. */
function repositories(options: { hits?: Array<{ eventId: string; similarity: number }> } = {}) {
  const hybridCalls: unknown[] = [];
  const keywordCalls: unknown[] = [];
  const hits = options.hits ?? [{ eventId: 'event-1', similarity: 0.9 }];

  const repos = fakeRepositories({
    search: {
      hybridSearch: async (args: unknown) => {
        hybridCalls.push(args);
        return hits;
      },
      keywordSearch: async (args: unknown) => {
        keywordCalls.push(args);
        return hits;
      },
    },
    events: { findById: async (id: string) => (id === 'event-1' ? event() : null) },
    sources: { listEnabled: async () => [source] },
    coins: {
      findManyByIds: async () => [{ id: 'coin-cro', symbol: 'CRO', name: 'Cronos' }],
    },
    market: {
      latestQuotes: async () =>
        new Map([
          ['coin-cro', { priceUsd: 0.1279, priceChange24hPct: 2.96, volume24hUsd: 41_000_000 }],
        ]),
    },
  });

  return { repos, hybridCalls, keywordCalls };
}

describe('ResearchAgent.retrieve', () => {
  it('embeds the question and searches hybrid when a model is available', async () => {
    const { repos, hybridCalls } = repositories();
    const agent = new ResearchAgent({
      repositories: repos,
      llm: null,
      embeddings: new FakeEmbeddingClient(),
    });

    const citations = await agent.retrieve({ question: 'Why is CRO pumping today?' });

    expect(citations).toEqual([
      {
        eventId: 'event-1',
        headline: 'Binance lists Cronos (CRO) for spot trading',
        sourceName: 'CoinDesk',
        occurredAt: new Date(NOW.getTime() - 2 * 3_600_000),
        url: 'https://www.coindesk.com/markets/binance-cro',
        importance: 88,
      },
    ]);
    expect((hybridCalls[0] as { vector: unknown }).vector).toBeInstanceOf(Array);
  });

  it('searches without a vector when no embedding model is configured', async () => {
    // Keyword-only is why search still works with LLM_PROVIDER=null.
    const { repos, hybridCalls } = repositories();
    const agent = new ResearchAgent({ repositories: repos, llm: null, embeddings: null });

    await agent.retrieve({ question: 'binance listing' });

    expect((hybridCalls[0] as { vector: unknown }).vector).toBeNull();
  });

  it('falls back to keyword-only when embedding fails', async () => {
    // A model that is configured but down must not take search down with it.
    const { repos, hybridCalls } = repositories();
    const agent = new ResearchAgent({
      repositories: repos,
      llm: null,
      embeddings: new FakeEmbeddingClient({ available: false }),
    });

    const citations = await agent.retrieve({ question: 'binance listing' });

    expect(citations).toHaveLength(1);
    expect((hybridCalls[0] as { vector: unknown }).vector).toBeNull();
  });

  it('uses keyword search when the repository offers no hybrid implementation', async () => {
    /*
     * `hybridSearch` is not on the `SearchRepository` port — it is an extra the
     * Prisma adapter provides. A conforming implementation without it must still
     * work, so this uses a plain object rather than `fakeRepositories`, whose
     * proxy answers every property and would make the fallback unreachable.
     */
    const keywordCalls: unknown[] = [];
    const repos = {
      search: {
        keywordSearch: async (args: unknown) => {
          keywordCalls.push(args);
          return [{ eventId: 'event-1', similarity: 0.5 }];
        },
      },
      events: { findById: async () => event() },
      sources: { listEnabled: async () => [source] },
    } as unknown as Repositories;
    const agent = new ResearchAgent({ repositories: repos, llm: null, embeddings: null });

    expect(await agent.retrieve({ question: 'x' })).toHaveLength(1);
    expect(keywordCalls).toHaveLength(1);
  });

  it('passes coin and date filters through to search', async () => {
    const { repos, hybridCalls } = repositories();
    const agent = new ResearchAgent({ repositories: repos, llm: null, embeddings: null });
    const from = new Date('2026-07-24T00:00:00.000Z');

    await agent.retrieve({ question: 'x', coinIds: ['coin-cro'], from, limit: 5 });

    expect(hybridCalls[0]).toMatchObject({ coinIds: ['coin-cro'], from, limit: 5 });
  });

  it('returns nothing when search finds nothing, without hydrating', async () => {
    const { repos } = repositories({ hits: [] });
    const agent = new ResearchAgent({ repositories: repos, llm: null, embeddings: null });

    expect(await agent.retrieve({ question: 'nothing matches this' })).toEqual([]);
  });

  it('drops hits whose event has since disappeared', async () => {
    // Search and hydration are separate queries; a row can vanish between them.
    const { repos } = repositories({
      hits: [
        { eventId: 'event-1', similarity: 0.9 },
        { eventId: 'deleted', similarity: 0.8 },
      ],
    });
    const agent = new ResearchAgent({ repositories: repos, llm: null, embeddings: null });

    const citations = await agent.retrieve({ question: 'x' });

    expect(citations).toHaveLength(1);
    expect(citations[0]?.eventId).toBe('event-1');
  });

  it('labels an event from an unknown source rather than dropping it', async () => {
    const repos = fakeRepositories({
      search: { hybridSearch: async () => [{ eventId: 'event-1', similarity: 0.9 }] },
      events: { findById: async () => event({ sourceId: 'source-gone' }) },
      sources: { listEnabled: async () => [source] },
    });
    const agent = new ResearchAgent({ repositories: repos, llm: null, embeddings: null });

    expect((await agent.retrieve({ question: 'x' }))[0]?.sourceName).toBe('unknown');
  });
});

describe('ResearchAgent.ask', () => {
  it('answers from the retrieved evidence and reports the model used', async () => {
    const { repos } = repositories();
    const llm = new FakeLlmClient({
      responses: ['CRO is up on a Binance spot listing announced this morning [1].'],
    });
    const agent = new ResearchAgent({ repositories: repos, llm, embeddings: null });

    const result = await agent.ask({ question: 'Why is CRO pumping today?' });

    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.answer).toContain('[1]');
    expect(result.value.citations).toHaveLength(1);
    expect(result.value.noEvidence).toBe(false);
    expect(result.value.model).toBe('fake-model');
  });

  it('refuses to answer with no evidence, and never consults the model', async () => {
    /*
     * This is the single most important behaviour in the agent. A local model
     * asked "why is CRO pumping" will happily answer from training data about a
     * different year.
     */
    const { repos } = repositories({ hits: [] });
    const llm = new FakeLlmClient({ responses: ['I am sure it is the halving.'] });
    const agent = new ResearchAgent({ repositories: repos, llm, embeddings: null });

    const result = await agent.ask({ question: 'Why is CRO pumping today?' });

    if (!result.ok) throw new Error('expected success');
    expect(result.value.noEvidence).toBe(true);
    expect(result.value.citations).toEqual([]);
    expect(result.value.model).toBeNull();
    expect(result.value.answer).toContain('no events matching');
    // The model was never asked.
    expect(llm.prompts).toEqual([]);
  });

  it('returns the evidence with an explanation when no model is configured', async () => {
    const { repos } = repositories();
    const agent = new ResearchAgent({ repositories: repos, llm: null, embeddings: null });

    const result = await agent.ask({ question: 'What happened with Binance?' });

    if (!result.ok) throw new Error('expected success');
    expect(result.value.noEvidence).toBe(false);
    expect(result.value.citations).toHaveLength(1);
    expect(result.value.answer).toContain('LLM_PROVIDER=null');
  });

  it('instructs the model to answer only from the retrieved events', async () => {
    const { repos } = repositories();
    const llm = new FakeLlmClient({ responses: ['ok'] });
    const agent = new ResearchAgent({ repositories: repos, llm, embeddings: null });

    await agent.ask({ question: 'Why is CRO pumping today?' });

    const [system, user] = llm.prompts[0] ?? [];
    expect(system?.role).toBe('system');
    expect(system?.content).toContain('ONLY those events');
    expect(user?.content).toContain('Why is CRO pumping today?');
    // Numbered evidence, so inline [n] citations map back to event ids.
    expect(user?.content).toContain('[1]');
    expect(user?.content).toContain('Binance lists Cronos');
  });

  it('includes current market state when the question is scoped to coins', async () => {
    /*
     * "Why is X pumping" is unanswerable without the model knowing that X is in
     * fact up — the events alone do not say so.
     */
    const { repos } = repositories();
    const llm = new FakeLlmClient({ responses: ['ok'] });
    const agent = new ResearchAgent({ repositories: repos, llm, embeddings: null });

    await agent.ask({ question: 'Why is CRO pumping?', coinIds: ['coin-cro'] });

    const prompt = llm.prompts[0]?.[1]?.content ?? '';
    expect(prompt).toContain('Current market state');
    expect(prompt).toContain('CRO');
    expect(prompt).toContain('+2.96%');
  });

  it('omits market state when no coins are specified', async () => {
    const { repos } = repositories();
    const llm = new FakeLlmClient({ responses: ['ok'] });
    const agent = new ResearchAgent({ repositories: repos, llm, embeddings: null });

    await agent.ask({ question: 'What happened today?' });

    expect(llm.prompts[0]?.[1]?.content).not.toContain('Current market state');
  });

  it('surfaces a model failure rather than inventing an answer', async () => {
    const { repos } = repositories();
    const llm = new FakeLlmClient({
      responses: [],
      failWith: new UpstreamError('ollama', 'model not loaded'),
    });
    const agent = new ResearchAgent({ repositories: repos, llm, embeddings: null });

    const result = await agent.ask({ question: 'Why is CRO pumping?' });

    if (result.ok) throw new Error('expected failure');
    expect(result.error.message).toContain('model not loaded');
  });
});

describe('ResearchAgent.askStream', () => {
  async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const chunks: T[] = [];
    for await (const chunk of iterable) chunks.push(chunk);
    return chunks;
  }

  it('sends citations before any token, so evidence renders first', async () => {
    const { repos } = repositories();
    const llm = new FakeLlmClient({ responses: ['CRO is up on a listing.'] });
    const agent = new ResearchAgent({ repositories: repos, llm, embeddings: null });

    const chunks = await drain(agent.askStream({ question: 'Why is CRO pumping?' }));

    expect(chunks[0]?.type).toBe('citations');
    expect(chunks.at(-1)?.type).toBe('done');
    const tokens = chunks.filter((chunk) => chunk.type === 'token');
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.map((chunk) => (chunk as { token: string }).token).join('')).toBe(
      'CRO is up on a listing.',
    );
  });

  it('says so and finishes cleanly when there is no evidence', async () => {
    const { repos } = repositories({ hits: [] });
    const llm = new FakeLlmClient({ responses: ['should not be used'] });
    const agent = new ResearchAgent({ repositories: repos, llm, embeddings: null });

    const chunks = await drain(agent.askStream({ question: 'nothing' }));

    expect(chunks[0]).toEqual({ type: 'citations', citations: [] });
    expect((chunks[1] as { token: string }).token).toContain('No matching events');
    expect(chunks.at(-1)?.type).toBe('done');
    expect(llm.prompts).toEqual([]);
  });

  it('says so when no model is configured', async () => {
    const { repos } = repositories();
    const agent = new ResearchAgent({ repositories: repos, llm: null, embeddings: null });

    const chunks = await drain(agent.askStream({ question: 'x' }));

    expect((chunks[1] as { token: string }).token).toContain('LLM_PROVIDER=null');
    expect(chunks.at(-1)?.type).toBe('done');
  });

  it('emits an error chunk and stops when the stream fails mid-answer', async () => {
    const { repos } = repositories();
    const llm = new FakeLlmClient({
      responses: [],
      failWith: new UpstreamError('ollama', 'connection reset'),
    });
    const agent = new ResearchAgent({ repositories: repos, llm, embeddings: null });

    const chunks = await drain(agent.askStream({ question: 'x' }));

    const last = chunks.at(-1);
    expect(last?.type).toBe('error');
    expect((last as { message: string }).message).toContain('connection reset');
    // No `done` after an error: the consumer must be able to tell them apart.
    expect(chunks.filter((chunk) => chunk.type === 'done')).toEqual([]);
  });
});
