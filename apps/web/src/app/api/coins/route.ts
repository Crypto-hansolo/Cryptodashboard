import { z } from 'zod';
import { parseIdentifier, slugify } from '@cid/core';
import { parseQuery, route } from '@/server/api';
import { getLocalUserId, getServices } from '@/server/container';

/**
 * GET  /api/coins           — the watchlist, with live quotes
 * POST /api/coins           — add a coin (by CoinGecko id, symbol or contract)
 * DELETE /api/coins?coinId= — remove from the watchlist
 * PATCH  /api/coins         — pin / unpin / reorder
 */

export const dynamic = 'force-dynamic';

const listQuerySchema = z.object({
  watchlistId: z.string().optional(),
});

export function GET(request: Request) {
  return route(request, async () => {
    const query = parseQuery(request, listQuerySchema);
    const { repositories } = getServices();
    const userId = await getLocalUserId();

    const watchlist = query.watchlistId
      ? { id: query.watchlistId }
      : await repositories.watchlists.getDefault(userId);

    const items = await repositories.watchlists.listItems(watchlist.id);
    const quotes = await repositories.market.latestQuotes(items.map((item) => item.coin.id));

    return {
      watchlistId: watchlist.id,
      items: items.map((item) => {
        const quote = quotes.get(item.coin.id);
        return {
          id: item.coin.id,
          slug: item.coin.slug,
          symbol: item.coin.symbol,
          name: item.coin.name,
          imageUrl: item.coin.imageUrl,
          chain: item.coin.chain,
          marketCapRank: item.coin.marketCapRank,
          isPinned: item.isPinned,
          position: item.position,
          tags: item.tags,
          quote: quote
            ? {
                priceUsd: quote.priceUsd,
                marketCapUsd: quote.marketCapUsd,
                volume24hUsd: quote.volume24hUsd,
                change1hPct: quote.priceChange1hPct,
                change24hPct: quote.priceChange24hPct,
                change7dPct: quote.priceChange7dPct,
                observedAt: quote.observedAt.toISOString(),
              }
            : null,
        };
      }),
    };
  });
}

const addSchema = z.object({
  /** Anything the identifier parser understands. */
  query: z.string().trim().min(1).max(200),
  watchlistId: z.string().optional(),
});

export function POST(request: Request) {
  return route(request, async () => {
    const body = addSchema.parse(await request.json());
    const { repositories, coinSearch, logger } = getServices();
    const userId = await getLocalUserId();

    const watchlist = body.watchlistId
      ? { id: body.watchlistId }
      : await repositories.watchlists.getDefault(userId);

    // 1. Already tracked? Resolve locally first — no network call needed.
    const candidates = parseIdentifier(body.query);
    let coin = await repositories.coins.findByIdentifiers(candidates);

    // 2. Otherwise discover it upstream and import its metadata.
    if (!coin) {
      const discovered = await coinSearch.search(body.query);
      const best = discovered[0];
      if (!best) {
        return { added: false, reason: 'not_found' as const };
      }

      const detail = await coinSearch.detail(best.coingeckoId);
      coin = await repositories.coins.upsert({
        slug: slugify(detail?.name ?? best.name),
        symbol: detail?.symbol ?? best.symbol,
        name: detail?.name ?? best.name,
        coingeckoId: best.coingeckoId,
        imageUrl: detail?.imageUrl ?? best.imageUrl,
        description: detail?.description ?? null,
        websiteUrl: detail?.websiteUrl ?? null,
        githubRepos: detail?.githubRepos ?? [],
        twitterHandle: detail?.twitterHandle ?? null,
        subreddit: detail?.subreddit ?? null,
        categories: detail?.categories ?? [],
        marketCapRank: detail?.marketCapRank ?? best.marketCapRank,
        identifiers: [
          { kind: 'COINGECKO', value: best.coingeckoId, chain: null },
          { kind: 'SYMBOL', value: (detail?.symbol ?? best.symbol).toUpperCase(), chain: null },
        ],
        // Contracts come back as a chain-slug map; only keep the chains the
        // platform knows, so an unknown chain does not produce junk rows.
        contracts: (detail?.contracts ?? []).flatMap((contract) => {
          const parsed = parseIdentifier(`${contract.chain}:${contract.address}`);
          const first = parsed[0];
          return first && first.kind === 'CONTRACT' && first.chain
            ? [{ chain: first.chain, address: first.value, decimals: null, isNative: false }]
            : [];
        }),
      });

      logger.info({ coinId: coin.id, symbol: coin.symbol }, 'imported new coin');
    }

    await repositories.watchlists.addCoin(watchlist.id, coin.id);

    return {
      added: true as const,
      coin: { id: coin.id, slug: coin.slug, symbol: coin.symbol, name: coin.name },
    };
  });
}

const removeSchema = z.object({ coinId: z.string().min(1), watchlistId: z.string().optional() });

export function DELETE(request: Request) {
  return route(request, async () => {
    const query = parseQuery(request, removeSchema);
    const { repositories } = getServices();
    const userId = await getLocalUserId();

    const watchlist = query.watchlistId
      ? { id: query.watchlistId }
      : await repositories.watchlists.getDefault(userId);

    // Removing from the watchlist does NOT delete the coin or its history:
    // re-adding it later should show the full record, and other watchlists or
    // portfolios may still reference it.
    await repositories.watchlists.removeCoin(watchlist.id, query.coinId);
    return { removed: true };
  });
}

const patchSchema = z.union([
  z.object({ action: z.literal('pin'), coinId: z.string(), pinned: z.boolean() }),
  z.object({ action: z.literal('reorder'), coinIds: z.array(z.string()).min(1) }),
]);

export function PATCH(request: Request) {
  return route(request, async () => {
    const body = patchSchema.parse(await request.json());
    const { repositories } = getServices();
    const userId = await getLocalUserId();
    const watchlist = await repositories.watchlists.getDefault(userId);

    if (body.action === 'pin') {
      await repositories.watchlists.setPinned(watchlist.id, body.coinId, body.pinned);
    } else {
      await repositories.watchlists.reorder(watchlist.id, body.coinIds);
    }
    return { ok: true };
  });
}
