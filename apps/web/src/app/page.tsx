import { Suspense } from 'react';
import { Terminal } from '@/components/terminal';
import { getLocalUserId, getServices } from '@/server/container';

/**
 * The dashboard.
 *
 * Rendered as a server component that fetches the first paint synchronously, so
 * the terminal shows real data immediately rather than a skeleton that fills in.
 * The client component then takes over for live updates.
 */

export const dynamic = 'force-dynamic';

async function loadInitialState() {
  const { repositories } = getServices();
  const userId = await getLocalUserId();
  const watchlist = await repositories.watchlists.getDefault(userId);

  const [items, timeline, connectorHealth, lag] = await Promise.all([
    repositories.watchlists.listItems(watchlist.id),
    repositories.events.timeline({ limit: 60, collapseDuplicates: true }),
    repositories.telemetry.connectorHealth(new Date(Date.now() - 3_600_000)),
    repositories.telemetry.ingestionLag(new Date(Date.now() - 3_600_000)),
  ]);

  const quotes = await repositories.market.latestQuotes(items.map((item) => item.coin.id));

  return {
    watchlist: items.map((item) => {
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
        tags: item.tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color })),
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
    timeline: timeline.items.map((entry) => ({
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
    nextCursor: timeline.nextCursor,
    status: {
      connectors: connectorHealth.length,
      failing: connectorHealth.filter((entry) => entry.lastStatus === 'FAILED').length,
      ingestedLastHour: connectorHealth.reduce((sum, entry) => sum + entry.itemsIngested, 0),
      lagP50Ms: lag?.p50Ms ?? null,
    },
  };
}

export default async function DashboardPage() {
  const initial = await loadInitialState();
  return (
    <Suspense>
      <Terminal initial={initial} />
    </Suspense>
  );
}
