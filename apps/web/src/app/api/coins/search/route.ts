import { z } from 'zod';
import { parseQuery, route } from '@/server/api';
import { getServices } from '@/server/container';

/**
 * GET /api/coins/search — powers the command palette.
 *
 * Searches locally first and only falls through to CoinGecko when the local
 * index has nothing, so typing in the palette does not spend the provider's
 * rate limit on every keystroke.
 */

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  q: z.string().trim().min(1).max(100),
  remote: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value !== 'false'),
});

export function GET(request: Request) {
  return route(async () => {
    const query = parseQuery(request, querySchema);
    const { repositories, coinSearch } = getServices();

    const local = await repositories.coins.search(query.q, 15);
    const results = local.map((hit) => ({
      id: hit.coin.id,
      slug: hit.coin.slug,
      symbol: hit.coin.symbol,
      name: hit.coin.name,
      imageUrl: hit.coin.imageUrl,
      marketCapRank: hit.coin.marketCapRank,
      score: hit.score,
      matchedOn: hit.matchedOn,
      tracked: true as const,
    }));

    // Only reach upstream when the local index is thin, and never for very
    // short queries — "b" would return noise and burn a request.
    if (results.length < 5 && query.remote !== false && query.q.length >= 2) {
      const discovered = await coinSearch.search(query.q);
      const known = new Set(results.map((result) => result.symbol.toUpperCase()));

      for (const candidate of discovered) {
        if (known.has(candidate.symbol.toUpperCase())) continue;
        results.push({
          id: `coingecko:${candidate.coingeckoId}`,
          slug: candidate.coingeckoId,
          symbol: candidate.symbol,
          name: candidate.name,
          imageUrl: candidate.imageUrl,
          marketCapRank: candidate.marketCapRank,
          score: 0.4,
          matchedOn: 'external-id' as const,
          // Not yet in the database: the UI offers "add" rather than "open".
          tracked: false as never,
        });
        if (results.length >= 20) break;
      }
    }

    return { results };
  });
}
