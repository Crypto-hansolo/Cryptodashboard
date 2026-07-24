import { z } from 'zod';
import { reportKindSchema } from './enums.js';
import type { SentimentLabel } from './enums.js';

/** AI-generated reports and the aggregate rankings they are built from. */

export const reportSchema = z.object({
  id: z.string(),
  kind: reportKindSchema,
  title: z.string().min(1),
  /** Markdown body. Rendered client-side; never treated as HTML. */
  body: z.string(),
  /** Window the report covers. */
  periodStart: z.date(),
  periodEnd: z.date(),
  /** Scope: null = whole watchlist, otherwise a specific coin or portfolio. */
  coinId: z.string().nullable().default(null),
  portfolioId: z.string().nullable().default(null),
  /** Events cited by the report, so the UI can link back to the evidence. */
  citedEventIds: z.array(z.string()).default([]),
  model: z.string().nullable().default(null),
  /** Structured extras: rankings, narrative lists, top movers. */
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.date(),
});
export type Report = z.infer<typeof reportSchema>;

export interface CoinRanking {
  coinId: string;
  symbol: string;
  name: string;
  score: number;
  /** Supporting numbers so the UI can show *why* a coin ranked where it did. */
  detail: Record<string, number | null>;
}

export interface NarrativeSummary {
  narrative: string;
  eventCount: number;
  meanSentiment: number;
  meanImportance: number;
  coinIds: string[];
  topHeadlines: string[];
}

export interface SentimentBucket {
  label: SentimentLabel;
  count: number;
}

/** Everything a period report needs, assembled by the repository layer. */
export interface ReportInputs {
  periodStart: Date;
  periodEnd: Date;
  coinRankings: {
    mostBullish: CoinRanking[];
    mostBearish: CoinRanking[];
    developerActivity: CoinRanking[];
    topMovers: CoinRanking[];
  };
  narratives: NarrativeSummary[];
  /** Highest-importance events in the window, already deduped. */
  keyEvents: Array<{
    id: string;
    occurredAt: Date;
    coinSymbol: string | null;
    headline: string;
    summary: string | null;
    importance: number | null;
    sentiment: string | null;
    sourceName: string;
    url: string | null;
  }>;
  eventCount: number;
}
