import { z } from 'zod';
import { csv, parseQuery, route } from '@/server/api';
import { getServices } from '@/server/container';

/**
 * GET /api/quotes — latest prices for a set of coins.
 *
 * Exists alongside the SSE stream because a freshly-loaded page needs current
 * state immediately; the stream only carries deltas from the moment it connects.
 */

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return route(async () => {
    const { coinIds } = parseQuery(request, z.object({ coinIds: csv }));
    const { repositories } = getServices();

    const ids =
      coinIds ??
      (await repositories.coins.listTracked(500)).map((coin) => coin.id);

    const quotes = await repositories.market.latestQuotes(ids);

    return {
      quotes: [...quotes.entries()].map(([coinId, quote]) => ({
        coinId,
        priceUsd: quote.priceUsd,
        marketCapUsd: quote.marketCapUsd,
        volume24hUsd: quote.volume24hUsd,
        change1hPct: quote.priceChange1hPct,
        change24hPct: quote.priceChange24hPct,
        change7dPct: quote.priceChange7dPct,
        observedAt: quote.observedAt.toISOString(),
      })),
    };
  });
}
