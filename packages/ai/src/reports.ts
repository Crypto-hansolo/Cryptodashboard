import {
  err,
  formatPercent,
  formatUsd,
  ok,
  truncate,
  type DomainError,
  type LlmClient,
  type Logger,
  type Report,
  type ReportInputs,
  type ReportKind,
  type Repositories,
  type Result,
} from '@cid/core';
import { noopLogger } from '@cid/core';

/**
 * Report generation.
 *
 * The structure of a report is deterministic — rankings, narratives and key
 * events all come from SQL aggregates — and the model only writes the narrative
 * prose on top. So a report is still generated, and still useful, with
 * `LLM_PROVIDER=null`; it just loses the editorial summary.
 *
 * Reports cite the event ids they were built from, which is what lets the UI
 * link every claim back to the underlying evidence.
 */

const SYSTEM_PROMPT = `You are the lead analyst writing a briefing for professional crypto traders.

You will receive structured data: rankings, narratives and the period's most important events. Write a briefing in Markdown.

Rules:
- Open with a 2-3 sentence "what mattered" paragraph. No preamble, no greeting.
- Then short sections with ## headings, only for sections the data supports.
- Cite events as [n] using the numbers given. Never invent a number or an event.
- Be concrete: name assets, magnitudes and directions.
- If the period was quiet, say so in one line rather than padding.
- No investment advice, no price predictions, no "DYOR" boilerplate.`;

export interface ReportGeneratorOptions {
  repositories: Repositories;
  llm: LlmClient | null;
  logger?: Logger;
}

export interface GenerateReportInput {
  kind: ReportKind;
  from: Date;
  to: Date;
  coinIds?: readonly string[];
  portfolioId?: string | null;
  /** Overrides the derived title. */
  title?: string;
}

export class ReportGenerator {
  readonly #repositories: Repositories;
  readonly #llm: LlmClient | null;
  readonly #logger: Logger;

  constructor(options: ReportGeneratorOptions) {
    this.#repositories = options.repositories;
    this.#llm = options.llm;
    this.#logger = (options.logger ?? noopLogger).child({ component: 'reports' });
  }

  async generate(input: GenerateReportInput): Promise<Result<Report, DomainError>> {
    const inputs = await this.#repositories.analytics.reportInputs({
      from: input.from,
      to: input.to,
      ...(input.coinIds ? { coinIds: input.coinIds } : {}),
      ...(input.portfolioId !== undefined ? { portfolioId: input.portfolioId } : {}),
    });

    const deterministic = renderDeterministicReport(input.kind, inputs);
    let body = deterministic;
    let model: string | null = null;

    if (this.#llm && inputs.eventCount > 0) {
      const completion = await this.#llm.complete(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildReportPrompt(input.kind, inputs) },
        ],
        { temperature: 0.4, maxTokens: 1_600 },
      );

      if (completion.ok) {
        // Narrative first, structured data appended — the tables are the record,
        // the prose is the interpretation.
        body = `${completion.value.text.trim()}\n\n---\n\n${deterministic}`;
        model = completion.value.model;
      } else {
        // A model failure degrades the report; it must not lose it.
        this.#logger.warn(
          { err: completion.error.message, kind: input.kind },
          'report narrative generation failed, emitting structured report only',
        );
      }
    }

    const report = await this.#repositories.reports.insert({
      kind: input.kind,
      title: input.title ?? defaultTitle(input.kind, input.from, input.to),
      body,
      periodStart: input.from,
      periodEnd: input.to,
      coinId: input.coinIds?.length === 1 ? input.coinIds[0]! : null,
      portfolioId: input.portfolioId ?? null,
      citedEventIds: inputs.keyEvents.map((event) => event.id),
      model,
      metadata: {
        eventCount: inputs.eventCount,
        narratives: inputs.narratives.map((narrative) => narrative.narrative),
        topMovers: inputs.coinRankings.topMovers.slice(0, 5).map((coin) => ({
          symbol: coin.symbol,
          changePct: coin.score,
        })),
      },
    });

    return report
      ? ok(report)
      : err(new Error('failed to persist report') as unknown as DomainError);
  }
}

function defaultTitle(kind: ReportKind, from: Date, to: Date): string {
  const date = to.toISOString().slice(0, 10);
  const time = to.toISOString().slice(11, 16);
  switch (kind) {
    case 'MORNING':
      return `Morning brief — ${date}`;
    case 'HOURLY':
      return `Hourly update — ${date} ${time}Z`;
    case 'DAILY':
      return `Daily report — ${date}`;
    case 'WEEKLY':
      return `Weekly report — week ending ${date}`;
    case 'MONTHLY':
      return `Monthly report — ${to.toISOString().slice(0, 7)}`;
    case 'PORTFOLIO':
      return `Portfolio report — ${date}`;
    case 'NARRATIVE':
      return `Narrative review — ${date}`;
    case 'ON_DEMAND':
      return `Research report — ${date}`;
    default:
      return `Report — ${from.toISOString().slice(0, 10)} to ${date}`;
  }
}

/** Compact the structured inputs into a prompt the model can work from. */
function buildReportPrompt(kind: ReportKind, inputs: ReportInputs): string {
  const sections: string[] = [
    `Report type: ${kind}`,
    `Period: ${inputs.periodStart.toISOString()} to ${inputs.periodEnd.toISOString()}`,
    `Total events in period: ${inputs.eventCount}`,
  ];

  if (inputs.coinRankings.topMovers.length > 0) {
    sections.push(
      `Biggest movers:\n${inputs.coinRankings.topMovers
        .slice(0, 8)
        .map((coin) => `- ${coin.symbol}: ${formatPercent(coin.score)}`)
        .join('\n')}`,
    );
  }

  if (inputs.coinRankings.mostBullish.length > 0) {
    sections.push(
      `Most bullish sentiment:\n${inputs.coinRankings.mostBullish
        .slice(0, 5)
        .map(
          (coin) =>
            `- ${coin.symbol}: ${coin.score.toFixed(2)} (${coin.detail.eventCount ?? 0} events)`,
        )
        .join('\n')}`,
    );
  }

  if (inputs.coinRankings.mostBearish.length > 0) {
    sections.push(
      `Most bearish sentiment:\n${inputs.coinRankings.mostBearish
        .slice(0, 5)
        .map(
          (coin) =>
            `- ${coin.symbol}: ${coin.score.toFixed(2)} (${coin.detail.eventCount ?? 0} events)`,
        )
        .join('\n')}`,
    );
  }

  if (inputs.narratives.length > 0) {
    sections.push(
      `Active narratives:\n${inputs.narratives
        .map(
          (narrative) =>
            `- ${narrative.narrative}: ${narrative.eventCount} events, mean sentiment ${narrative.meanSentiment.toFixed(2)}`,
        )
        .join('\n')}`,
    );
  }

  if (inputs.keyEvents.length > 0) {
    sections.push(
      `Key events:\n${inputs.keyEvents
        .map(
          (event, index) =>
            `[${index + 1}] ${event.occurredAt.toISOString().slice(0, 16)}Z ${event.coinSymbol ?? '—'} ` +
            `(${event.sourceName}, importance ${event.importance ?? '?'}): ${event.headline}` +
            `${event.summary ? `\n     ${truncate(event.summary, 200)}` : ''}`,
        )
        .join('\n')}`,
    );
  }

  return sections.join('\n\n');
}

/**
 * Render the structured half of a report.
 *
 * This is the part that exists with or without a model, and it is deliberately
 * table-heavy: a trader scanning a briefing wants the numbers, and prose is
 * where a small model is most likely to drift.
 */
export function renderDeterministicReport(kind: ReportKind, inputs: ReportInputs): string {
  const lines: string[] = [];

  lines.push(
    `**Period:** ${inputs.periodStart.toISOString().slice(0, 16)}Z → ${inputs.periodEnd
      .toISOString()
      .slice(0, 16)}Z · **Events:** ${inputs.eventCount}`,
  );

  if (inputs.eventCount === 0) {
    lines.push('', 'No events were recorded in this period.');
    return lines.join('\n');
  }

  const { topMovers, mostBullish, mostBearish, developerActivity } = inputs.coinRankings;

  if (topMovers.length > 0) {
    lines.push(
      '',
      '## Price movement',
      '',
      '| Asset | Change | From | To |',
      '| --- | --- | --- | --- |',
    );
    for (const coin of topMovers.slice(0, 10)) {
      lines.push(
        `| ${coin.symbol} | ${formatPercent(coin.score)} | ${formatUsd(coin.detail.fromPrice ?? null)} | ${formatUsd(coin.detail.toPrice ?? null)} |`,
      );
    }
  }

  if (mostBullish.length > 0 || mostBearish.length > 0) {
    lines.push(
      '',
      '## Sentiment',
      '',
      '| Asset | Mean sentiment | Events |',
      '| --- | --- | --- |',
    );
    for (const coin of [...mostBullish.slice(0, 5), ...mostBearish.slice(0, 5)]) {
      lines.push(`| ${coin.symbol} | ${coin.score.toFixed(2)} | ${coin.detail.eventCount ?? 0} |`);
    }
  }

  if (developerActivity.length > 0) {
    lines.push(
      '',
      '## Developer activity',
      '',
      '| Asset | Score | Commits (30d) | Contributors (30d) |',
      '| --- | --- | --- | --- |',
    );
    for (const coin of developerActivity.slice(0, 10)) {
      lines.push(
        `| ${coin.symbol} | ${coin.score.toFixed(0)} | ${coin.detail.commits30d ?? '—'} | ${coin.detail.contributors30d ?? '—'} |`,
      );
    }
  }

  if (inputs.narratives.length > 0) {
    lines.push('', '## Narratives', '');
    for (const narrative of inputs.narratives) {
      lines.push(
        `- **${narrative.narrative}** — ${narrative.eventCount} events, ` +
          `mean sentiment ${narrative.meanSentiment.toFixed(2)}` +
          (narrative.topHeadlines[0] ? `. e.g. _${truncate(narrative.topHeadlines[0], 120)}_` : ''),
      );
    }
  }

  if (inputs.keyEvents.length > 0) {
    lines.push('', '## Key events', '');
    inputs.keyEvents.forEach((event, index) => {
      const time = event.occurredAt.toISOString().slice(11, 16);
      const asset = event.coinSymbol ? `**${event.coinSymbol}** ` : '';
      const link = event.url ? `[${event.sourceName}](${event.url})` : event.sourceName;
      lines.push(
        `${index + 1}. \`${time}Z\` ${asset}${event.headline} — ${link}` +
          (event.importance !== null ? ` · importance ${event.importance}` : ''),
      );
    });
  }

  lines.push('', `_Generated ${new Date().toISOString().slice(0, 16)}Z · report type ${kind}._`);
  return lines.join('\n');
}
