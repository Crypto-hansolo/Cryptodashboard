import { z } from 'zod';
import { csv, isoDate, parseQuery, route } from '@/server/api';
import { getServices } from '@/server/container';

/**
 * GET /api/search — semantic + keyword search over events.
 *
 * Hybrid by default: embeddings miss exact tokens (a ticker, a contract address,
 * a version number) and full-text misses paraphrase, so both run and their
 * scores are merged. Falls back to keyword-only when no embedding model is
 * configured, which is why search works with LLM_PROVIDER=null.
 */

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  q: z.string().trim().min(2).max(300),
  coinIds: csv,
  from: isoDate,
  to: isoDate,
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export function GET(request: Request) {
  return route(request, async () => {
    const query = parseQuery(request, querySchema);
    const { agent } = getServices();

    const citations = await agent.retrieve({
      question: query.q,
      ...(query.coinIds ? { coinIds: query.coinIds } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      limit: query.limit,
    });

    return {
      results: citations.map((citation) => ({
        eventId: citation.eventId,
        headline: citation.headline,
        sourceName: citation.sourceName,
        occurredAt: citation.occurredAt.toISOString(),
        url: citation.url,
        importance: citation.importance,
      })),
    };
  });
}
