import { z } from 'zod';
import {
  EVENT_CATEGORIES,
  IMPACT_LEVELS,
  SENTIMENT_LABELS,
  type TimelineFilter,
} from '@cid/core';
import { csv, isoDate, parseQuery, route } from '@/server/api';
import { getServices } from '@/server/container';

/**
 * GET /api/timeline — the continuously-updating event feed.
 *
 * Keyset-paginated via an opaque cursor; see the mapper docs for why not OFFSET.
 * Every filter the UI offers maps to an indexed column.
 */

const querySchema = z.object({
  coinIds: csv,
  categories: csv,
  sourceKeys: csv,
  sentiments: csv,
  impacts: csv,
  minImportance: z.coerce.number().int().min(1).max(100).optional(),
  from: isoDate,
  to: isoDate,
  q: z.string().trim().min(1).max(200).optional(),
  collapse: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value !== 'false'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return route(async () => {
    const query = parseQuery(request, querySchema);
    const { repositories } = getServices();

    // Validate enum members explicitly rather than casting: a bad value in a
    // hand-edited URL should be a 400, not a silently-empty result set.
    const categories = query.categories?.filter((value): value is (typeof EVENT_CATEGORIES)[number] =>
      (EVENT_CATEGORIES as readonly string[]).includes(value),
    );
    const sentiments = query.sentiments?.filter((value): value is (typeof SENTIMENT_LABELS)[number] =>
      (SENTIMENT_LABELS as readonly string[]).includes(value),
    );
    const impacts = query.impacts?.filter((value): value is (typeof IMPACT_LEVELS)[number] =>
      (IMPACT_LEVELS as readonly string[]).includes(value),
    );

    const filter: TimelineFilter = {
      ...(query.coinIds ? { coinIds: query.coinIds } : {}),
      ...(categories?.length ? { categories } : {}),
      ...(query.sourceKeys ? { sourceKeys: query.sourceKeys } : {}),
      ...(sentiments?.length ? { sentiments } : {}),
      ...(impacts?.length ? { impacts } : {}),
      ...(query.minImportance !== undefined ? { minImportance: query.minImportance } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      ...(query.q ? { query: query.q } : {}),
      collapseDuplicates: query.collapse ?? true,
      limit: query.limit,
      cursor: query.cursor ?? null,
    };

    const page = await repositories.events.timeline(filter);

    // Flatten for the client: the nested `intelligence` object is convenient in
    // the domain but noisy over the wire and in JSX.
    return {
      items: page.items.map((entry) => ({
        id: entry.event.id,
        occurredAt: entry.event.occurredAt.toISOString(),
        ingestedAt: entry.event.ingestedAt.toISOString(),
        category: entry.event.category,
        subtype: entry.event.subtype,
        headline: entry.event.headline,
        summary: entry.event.intelligence.summary,
        explanation: entry.event.intelligence.explanation,
        url: entry.event.url,
        author: entry.event.author,
        importance: entry.event.intelligence.importance,
        confidence: entry.event.intelligence.confidence,
        sentiment: entry.event.intelligence.sentiment,
        sentimentScore: entry.event.intelligence.sentimentScore,
        impact: entry.event.intelligence.impact,
        narratives: entry.event.intelligence.narratives,
        isFud: entry.event.intelligence.isFud,
        enriched: entry.event.intelligence.enrichedAt !== null,
        source: entry.source,
        coin: entry.coin,
        duplicateCount: entry.duplicateCount,
      })),
      nextCursor: page.nextCursor,
    };
  });
}
