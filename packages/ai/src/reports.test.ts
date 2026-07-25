import { describe, expect, it } from 'vitest';
import { UpstreamError, type Report, type ReportInputs } from '@cid/core';
import { ReportGenerator, renderDeterministicReport } from './reports.js';
import { fakeRepositories } from '@cid/platform/testing';
import { FakeLlmClient } from './testing.js';

/**
 * A report has two halves, and the split is the design: the tables are the
 * record, the prose is the interpretation. So the structured half must render
 * identically with or without a model, and a model failure must degrade a report
 * rather than lose it.
 */

const FROM = new Date('2026-07-24T12:00:00.000Z');
const TO = new Date('2026-07-25T12:00:00.000Z');

function inputs(overrides: Partial<ReportInputs> = {}): ReportInputs {
  return {
    periodStart: FROM,
    periodEnd: TO,
    coinRankings: {
      topMovers: [
        {
          coinId: 'coin-cro',
          symbol: 'CRO',
          score: 12.4,
          detail: { fromPrice: 0.113, toPrice: 0.127 },
        },
        {
          coinId: 'coin-eth',
          symbol: 'ETH',
          score: -3.1,
          detail: { fromPrice: 3020, toPrice: 2930 },
        },
      ],
      mostBullish: [{ coinId: 'coin-cro', symbol: 'CRO', score: 0.72, detail: { eventCount: 9 } }],
      mostBearish: [{ coinId: 'coin-eth', symbol: 'ETH', score: -0.41, detail: { eventCount: 6 } }],
      developerActivity: [
        {
          coinId: 'coin-eth',
          symbol: 'ETH',
          score: 84,
          detail: { commits30d: 412, contributors30d: 63 },
        },
      ],
    },
    narratives: [
      {
        narrative: 'exchange-listings',
        eventCount: 4,
        meanSentiment: 0.61,
        topHeadlines: ['Binance lists Cronos (CRO) for spot trading'],
      },
    ],
    keyEvents: [
      {
        id: 'event-1',
        occurredAt: new Date('2026-07-25T09:14:00.000Z'),
        coinSymbol: 'CRO',
        headline: 'Binance lists Cronos (CRO) for spot trading',
        summary: 'Binance will open CRO/USDT markets on 26 July.',
        importance: 88,
        sentiment: 'VERY_BULLISH',
        sourceName: 'CoinDesk',
        url: 'https://www.coindesk.com/markets/binance-cro',
      },
    ],
    eventCount: 42,
    ...overrides,
  } as ReportInputs;
}

/** Repositories that serve fixed inputs and capture the persisted report. */
function repositories(reportInputs: ReportInputs = inputs()) {
  const inserted: Array<Record<string, unknown>> = [];
  const repos = fakeRepositories({
    analytics: { reportInputs: async () => reportInputs },
    reports: {
      insert: async (draft: Record<string, unknown>) => {
        inserted.push(draft);
        return { id: 'report-1', ...draft } as unknown as Report;
      },
    },
  });
  return { repos, inserted };
}

describe('renderDeterministicReport', () => {
  it('renders every section as a table or list', () => {
    const body = renderDeterministicReport('MORNING', inputs());

    expect(body).toContain('## Price movement');
    expect(body).toContain('| CRO | +12.40% | $0.113 | $0.127 |');
    expect(body).toContain('## Sentiment');
    expect(body).toContain('## Developer activity');
    expect(body).toContain('| ETH | 84 | 412 | 63 |');
    expect(body).toContain('## Narratives');
    expect(body).toContain('exchange-listings');
    expect(body).toContain('## Key events');
  });

  it('links key events to their source', () => {
    const body = renderDeterministicReport('MORNING', inputs());

    expect(body).toContain('[CoinDesk](https://www.coindesk.com/markets/binance-cro)');
    expect(body).toContain('importance 88');
  });

  it('names the source without a link when the event has no URL', () => {
    const body = renderDeterministicReport(
      'MORNING',
      inputs({
        keyEvents: [{ ...inputs().keyEvents[0]!, url: null }],
      }),
    );

    expect(body).toContain('CoinDesk');
    expect(body).not.toContain('](');
  });

  it('says plainly that nothing happened rather than rendering empty tables', () => {
    // An hourly report at 4am is a normal, common case.
    const body = renderDeterministicReport(
      'HOURLY',
      inputs({
        eventCount: 0,
        coinRankings: { topMovers: [], mostBullish: [], mostBearish: [], developerActivity: [] },
        narratives: [],
        keyEvents: [],
      }),
    );

    expect(body).toContain('No events were recorded in this period.');
    expect(body).not.toContain('## Price movement');
  });

  it('omits sections with no data', () => {
    const body = renderDeterministicReport(
      'MORNING',
      inputs({
        coinRankings: {
          topMovers: [],
          mostBullish: [],
          mostBearish: [],
          developerActivity: [],
        },
        narratives: [],
      }),
    );

    expect(body).not.toContain('## Price movement');
    expect(body).not.toContain('## Developer activity');
    expect(body).not.toContain('## Narratives');
    // But the events it does have are still there.
    expect(body).toContain('## Key events');
  });

  it('renders a missing price as a dash rather than a zero', () => {
    const body = renderDeterministicReport(
      'MORNING',
      inputs({
        coinRankings: {
          ...inputs().coinRankings,
          topMovers: [{ coinId: 'c', symbol: 'NEW', name: 'New Coin', score: 0, detail: {} }],
        },
      }),
    );

    expect(body).toContain('| NEW | 0.00% | — | — |');
  });

  it('caps each table so a 500-coin watchlist cannot produce an unreadable report', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      coinId: `c${index}`,
      symbol: `T${index}`,
      name: `Token ${index}`,
      score: index,
      detail: {},
    }));
    const body = renderDeterministicReport(
      'MORNING',
      inputs({ coinRankings: { ...inputs().coinRankings, topMovers: many } }),
    );

    const rows = body.split('\n').filter((line) => /^\| T\d+ /.test(line));
    expect(rows).toHaveLength(10);
  });
});

describe('ReportGenerator', () => {
  it('persists the structured report when no model is configured', async () => {
    const { repos, inserted } = repositories();
    const generator = new ReportGenerator({ repositories: repos, llm: null });

    const result = await generator.generate({ kind: 'MORNING', from: FROM, to: TO });

    if (!result.ok) throw new Error(result.error.message);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      kind: 'MORNING',
      title: 'Morning brief — 2026-07-25',
      periodStart: FROM,
      periodEnd: TO,
      model: null,
      citedEventIds: ['event-1'],
    });
    expect(inserted[0]?.body).toContain('## Price movement');
  });

  it('puts the narrative first and appends the tables', async () => {
    /*
     * Order matters: the prose is the interpretation, the tables are the record.
     * A reader who distrusts the prose can scroll past it to the numbers.
     */
    const { repos, inserted } = repositories();
    const llm = new FakeLlmClient({ responses: ['CRO led the market on a Binance listing.'] });
    const generator = new ReportGenerator({ repositories: repos, llm });

    await generator.generate({ kind: 'MORNING', from: FROM, to: TO });

    const body = String(inserted[0]?.body);
    expect(body.indexOf('CRO led the market')).toBeLessThan(body.indexOf('## Price movement'));
    expect(body).toContain('\n\n---\n\n');
    expect(inserted[0]?.model).toBe('fake-model');
  });

  it('degrades to the structured report when the model fails', async () => {
    // A model outage must cost the prose, not the briefing.
    const { repos, inserted } = repositories();
    const llm = new FakeLlmClient({
      responses: [],
      failWith: new UpstreamError('ollama', 'model not loaded'),
    });
    const generator = new ReportGenerator({ repositories: repos, llm });

    const result = await generator.generate({ kind: 'HOURLY', from: FROM, to: TO });

    expect(result.ok).toBe(true);
    expect(inserted[0]?.body).toContain('## Price movement');
    expect(inserted[0]?.model).toBeNull();
  });

  it('does not call the model for an empty period', async () => {
    // Nothing to summarise, and a small model asked to summarise nothing invents.
    const { repos } = repositories(
      inputs({
        eventCount: 0,
        coinRankings: { topMovers: [], mostBullish: [], mostBearish: [], developerActivity: [] },
        narratives: [],
        keyEvents: [],
      }),
    );
    const llm = new FakeLlmClient({ responses: ['fabricated summary'] });
    const generator = new ReportGenerator({ repositories: repos, llm });

    await generator.generate({ kind: 'HOURLY', from: FROM, to: TO });

    expect(llm.prompts).toEqual([]);
  });

  it('gives the model the structured facts, not raw rows', async () => {
    const { repos } = repositories();
    const llm = new FakeLlmClient({ responses: ['ok'] });
    const generator = new ReportGenerator({ repositories: repos, llm });

    await generator.generate({ kind: 'WEEKLY', from: FROM, to: TO });

    const prompt = llm.prompts[0]?.[1]?.content ?? '';
    expect(prompt).toContain('Report type: WEEKLY');
    expect(prompt).toContain('Total events in period: 42');
    expect(prompt).toContain('Biggest movers');
    expect(prompt).toContain('Active narratives');
    // Numbered, so the narrative can reference specific evidence.
    expect(prompt).toContain('[1]');
  });

  it('derives a title per report kind', async () => {
    const titles: Record<string, string> = {};
    for (const kind of ['MORNING', 'HOURLY', 'WEEKLY', 'MONTHLY', 'PORTFOLIO'] as const) {
      const { repos, inserted } = repositories();
      await new ReportGenerator({ repositories: repos, llm: null }).generate({
        kind,
        from: FROM,
        to: TO,
      });
      titles[kind] = String(inserted[0]?.title);
    }

    expect(titles.MORNING).toBe('Morning brief — 2026-07-25');
    expect(titles.HOURLY).toBe('Hourly update — 2026-07-25 12:00Z');
    expect(titles.WEEKLY).toBe('Weekly report — week ending 2026-07-25');
    expect(titles.MONTHLY).toBe('Monthly report — 2026-07');
    expect(titles.PORTFOLIO).toBe('Portfolio report — 2026-07-25');
  });

  it('accepts an explicit title', async () => {
    const { repos, inserted } = repositories();
    const generator = new ReportGenerator({ repositories: repos, llm: null });

    await generator.generate({ kind: 'ON_DEMAND', from: FROM, to: TO, title: 'CRO deep dive' });

    expect(inserted[0]?.title).toBe('CRO deep dive');
  });

  it('attaches a coin only when the report is about exactly one', async () => {
    // A single-coin report belongs on that coin's page; a two-coin one does not.
    const single = repositories();
    await new ReportGenerator({ repositories: single.repos, llm: null }).generate({
      kind: 'ON_DEMAND',
      from: FROM,
      to: TO,
      coinIds: ['coin-cro'],
    });
    expect(single.inserted[0]?.coinId).toBe('coin-cro');

    const multiple = repositories();
    await new ReportGenerator({ repositories: multiple.repos, llm: null }).generate({
      kind: 'ON_DEMAND',
      from: FROM,
      to: TO,
      coinIds: ['coin-cro', 'coin-eth'],
    });
    expect(multiple.inserted[0]?.coinId).toBeNull();
  });

  it('records the event count, narratives and movers as metadata', async () => {
    // The list view reads these without loading multi-kilobyte bodies.
    const { repos, inserted } = repositories();
    const generator = new ReportGenerator({ repositories: repos, llm: null });

    await generator.generate({ kind: 'MORNING', from: FROM, to: TO });

    expect(inserted[0]?.metadata).toEqual({
      eventCount: 42,
      narratives: ['exchange-listings'],
      topMovers: [
        { symbol: 'CRO', changePct: 12.4 },
        { symbol: 'ETH', changePct: -3.1 },
      ],
    });
  });

  it('fails when the report cannot be persisted', async () => {
    const repos = fakeRepositories({
      analytics: { reportInputs: async () => inputs() },
      reports: { insert: async () => null },
    });
    const generator = new ReportGenerator({ repositories: repos, llm: null });

    expect((await generator.generate({ kind: 'MORNING', from: FROM, to: TO })).ok).toBe(false);
  });
});
