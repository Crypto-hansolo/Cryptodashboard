import { z } from 'zod';
import { parseQuery, route } from '@/server/api';
import { getServices } from '@/server/container';

/**
 * GET /api/chart/[coinId] — every series the coin view can plot.
 *
 * One endpoint returning several series rather than one endpoint per chart: the
 * detail view renders them together, and a single round trip keeps them
 * time-aligned. Series are downsampled server-side.
 */

export const dynamic = 'force-dynamic';

const RANGES: Record<string, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
};

const querySchema = z.object({
  range: z.enum(['1h', '24h', '7d', '30d', '90d']).default('24h'),
  series: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',').map((s) => s.trim()) : undefined)),
});

export function GET(request: Request, context: { params: Promise<{ coinId: string }> }) {
  return route(request, async () => {
    const query = parseQuery(request, querySchema);
    const { coinId } = await context.params;
    const { repositories, env } = getServices();

    const spanMs = RANGES[query.range] ?? RANGES['24h']!;
    const to = new Date();
    const from = new Date(to.getTime() - spanMs);

    // Bucket width scales with the range so every chart returns ~200 points.
    const bucketMinutes = Math.max(1, Math.round(spanMs / 60_000 / 200));
    const wanted = new Set(query.series ?? ['price', 'events', 'whales', 'dev', 'derivatives']);

    const [price, events, whales, dev, derivatives] = await Promise.all([
      wanted.has('price')
        ? repositories.market.history({ coinId, from, to, maxPoints: 300 })
        : Promise.resolve([]),
      wanted.has('events')
        ? repositories.events.histogram({ coinId, from, to, bucketMinutes })
        : Promise.resolve([]),
      wanted.has('whales')
        ? repositories.content.whaleFlows({
            coinId,
            from,
            to,
            bucketMinutes,
            minUsd: env.WHALE_THRESHOLD_USD,
          })
        : Promise.resolve([]),
      wanted.has('dev')
        ? repositories.content.githubActivityHistory({ coinId, from, to, bucketMinutes: 1_440 })
        : Promise.resolve([]),
      wanted.has('derivatives')
        ? repositories.market.derivativesHistory({ coinId, from, to })
        : Promise.resolve([]),
    ]);

    return {
      range: query.range,
      from: from.toISOString(),
      to: to.toISOString(),
      price: price.map((point) => ({
        t: point.observedAt.toISOString(),
        price: point.priceUsd,
        marketCap: point.marketCapUsd,
        volume: point.volume24hUsd,
        liquidity: point.liquidityUsd,
      })),
      // News frequency and sentiment share a bucket grid so they overlay cleanly.
      events: events.map((bucket) => ({
        t: bucket.bucket.toISOString(),
        count: bucket.count,
        sentiment: bucket.meanSentiment,
      })),
      whales: whales.map((bucket) => ({
        t: bucket.bucket.toISOString(),
        inflow: bucket.inflowUsd,
        outflow: bucket.outflowUsd,
        net: bucket.outflowUsd - bucket.inflowUsd,
        count: bucket.count,
      })),
      dev: dev.map((bucket) => ({
        t: bucket.bucket.toISOString(),
        commits: bucket.commits,
        releases: bucket.releases,
        pullRequests: bucket.pullRequests,
      })),
      derivatives: derivatives.map((snapshot) => ({
        t: snapshot.observedAt.toISOString(),
        instrument: snapshot.instrument,
        fundingRate: snapshot.fundingRate,
        openInterestUsd: snapshot.openInterestUsd,
      })),
    };
  });
}
