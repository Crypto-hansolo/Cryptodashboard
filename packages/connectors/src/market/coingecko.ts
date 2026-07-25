import { z } from 'zod';
import type { CollectionRequest, ConnectorContext, ConnectorDescriptor } from '@cid/core';
import { BaseConnector, type CollectionBuilder, num, parseTimestamp } from '../sdk/base.js';

/**
 * CoinGecko markets connector.
 *
 * The primary reference price source. Works keyless on the public tier at
 * ~30 req/min, which is why `COINGECKO_API_KEY` is declared optional rather than
 * required — the platform must be usable with zero credentials.
 *
 * One call returns up to 250 coins, so this connector is `batchesCoins: true`
 * and the scheduler does not fan out per asset. That single fact is what makes
 * 500 tracked coins affordable at a 10-second cadence.
 */

/**
 * Only the fields we consume are validated. `passthrough` is deliberate: a
 * provider adding a field must not fail the parse, but a provider *changing* a
 * field we depend on should.
 */
const marketRowSchema = z
  .object({
    id: z.string(),
    symbol: z.string(),
    name: z.string(),
    image: z.string().nullish(),
    current_price: z.number().nullish(),
    market_cap: z.number().nullish(),
    market_cap_rank: z.number().nullish(),
    fully_diluted_valuation: z.number().nullish(),
    total_volume: z.number().nullish(),
    circulating_supply: z.number().nullish(),
    total_supply: z.number().nullish(),
    max_supply: z.number().nullish(),
    ath: z.number().nullish(),
    atl: z.number().nullish(),
    price_change_percentage_1h_in_currency: z.number().nullish(),
    price_change_percentage_24h_in_currency: z.number().nullish(),
    price_change_percentage_7d_in_currency: z.number().nullish(),
    price_change_percentage_30d_in_currency: z.number().nullish(),
    last_updated: z.string().nullish(),
  })
  .passthrough();

const marketsResponseSchema = z.array(marketRowSchema);

export class CoinGeckoMarketsConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    key: 'coingecko',
    name: 'CoinGecko',
    domain: 'market',
    sourceKind: 'MARKET_DATA',
    homepageUrl: 'https://www.coingecko.com',
    credibility: 0.9,
    requirements: [
      {
        envKey: 'COINGECKO_API_KEY',
        required: false,
        description:
          'Optional. Public tier works keyless at ~30 req/min; a demo or pro key is strongly recommended above ~50 tracked coins.',
      },
    ],
    defaultIntervalMs: 10_000,
    // Conservative: the public tier throttles aggressively and a ban costs the
    // platform its primary price source.
    rateLimit: { requestsPerMinute: 25, burst: 5 },
    batchesCoins: true,
    maxCoinsPerRun: 250,
  };

  #baseUrl(context: ConnectorContext): string {
    const tier = this.config(context, 'COINGECKO_API_TIER') ?? 'public';
    // Pro keys must use a different host; sending a pro key to the public host
    // silently gets public-tier limits.
    return tier === 'pro'
      ? 'https://pro-api.coingecko.com/api/v3'
      : 'https://api.coingecko.com/api/v3';
  }

  #headers(context: ConnectorContext): Record<string, string> {
    const apiKey = this.config(context, 'COINGECKO_API_KEY');
    if (!apiKey) return {};
    const tier = this.config(context, 'COINGECKO_API_TIER') ?? 'public';
    return tier === 'pro' ? { 'x-cg-pro-api-key': apiKey } : { 'x-cg-demo-api-key': apiKey };
  }

  protected async run(
    request: CollectionRequest,
    context: ConnectorContext,
    builder: CollectionBuilder,
  ): Promise<void> {
    // Coins we can address by CoinGecko id. Others are handled by connectors
    // that key off contract addresses or exchange symbols.
    const ids = request.coins
      .map((coin) => coin.coingeckoId)
      .filter((id): id is string => typeof id === 'string' && id !== '');

    if (ids.length === 0) return;

    const byGeckoId = new Map(
      request.coins.flatMap((coin) => (coin.coingeckoId ? [[coin.coingeckoId, coin]] : [])),
    );

    // Chunk to the provider's page size.
    const chunkSize = this.descriptor.maxCoinsPerRun ?? 250;
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      const chunk = ids.slice(offset, offset + chunkSize);

      const response = await context.http.getJson<unknown>(
        `${this.#baseUrl(context)}/coins/markets`,
        {
          query: {
            vs_currency: 'usd',
            ids: chunk.join(','),
            per_page: chunk.length,
            page: 1,
            sparkline: false,
            price_change_percentage: '1h,24h,7d,30d',
          },
          headers: this.#headers(context),
          // Cache for slightly under the poll interval: protects against two
          // schedulers overlapping without ever serving a stale price.
          cacheTtlSeconds: 5,
        },
      );

      if (!response.ok) {
        context.logger.warn(
          { connector: this.descriptor.key, err: response.error.message },
          'coingecko markets request failed',
        );
        // Throwing surfaces this as a failed run to the scheduler, which applies
        // the retry policy. Returning silently would look like "no data".
        throw response.error;
      }

      const parsed = marketsResponseSchema.safeParse(response.value);
      if (!parsed.success) {
        throw new Error(
          `coingecko: unexpected markets payload (${parsed.error.issues.length} issues)`,
        );
      }

      builder.countFetched(parsed.data.length);

      const observedAtFallback = context.clock.now();
      const snapshots = parsed.data.flatMap((row) => {
        const coin = byGeckoId.get(row.id);
        const price = num(row.current_price);
        // A row without a price is not a usable observation.
        if (!coin || price === null) return [];

        return [
          {
            sourceKey: this.descriptor.key,
            coinId: coin.id,
            // Prefer the provider's own timestamp so `occurredAt` reflects when
            // the price was true, not when we happened to poll.
            observedAt: parseTimestamp(row.last_updated) ?? observedAtFallback,
            priceUsd: price,
            marketCapUsd: num(row.market_cap),
            fdvUsd: num(row.fully_diluted_valuation),
            volume24hUsd: num(row.total_volume),
            circulatingSupply: num(row.circulating_supply),
            totalSupply: num(row.total_supply),
            maxSupply: num(row.max_supply),
            liquidityUsd: null,
            priceChange1hPct: num(row.price_change_percentage_1h_in_currency),
            priceChange24hPct: num(row.price_change_percentage_24h_in_currency),
            priceChange7dPct: num(row.price_change_percentage_7d_in_currency),
            priceChange30dPct: num(row.price_change_percentage_30d_in_currency),
            marketCapRank: num(row.market_cap_rank),
            athUsd: num(row.ath),
            atlUsd: num(row.atl),
          },
        ];
      });

      builder.add('marketSnapshots', snapshots);
    }
  }
}

// ─── Coin search / discovery ─────────────────────────────────────────────────

const searchCoinSchema = z
  .object({
    id: z.string(),
    symbol: z.string(),
    name: z.string(),
    market_cap_rank: z.number().nullish(),
    thumb: z.string().nullish(),
    large: z.string().nullish(),
  })
  .passthrough();

const searchResponseSchema = z.object({ coins: z.array(searchCoinSchema).default([]) });

export interface DiscoveredCoin {
  coingeckoId: string;
  symbol: string;
  name: string;
  marketCapRank: number | null;
  imageUrl: string | null;
}

/**
 * Coin discovery, used by the "add any cryptocurrency" search box.
 *
 * Not a `Connector`: it is request-scoped and user-driven rather than scheduled,
 * so it does not belong in the registry. It shares the same HTTP client, and
 * therefore the same rate limiter and circuit breaker, as the polling connector.
 */
export class CoinGeckoSearchClient {
  readonly #context: ConnectorContext;

  constructor(context: ConnectorContext) {
    this.#context = context;
  }

  #baseUrl(): string {
    const tier = this.#context.config.COINGECKO_API_TIER ?? 'public';
    return tier === 'pro'
      ? 'https://pro-api.coingecko.com/api/v3'
      : 'https://api.coingecko.com/api/v3';
  }

  #headers(): Record<string, string> {
    const apiKey = this.#context.config.COINGECKO_API_KEY;
    if (!apiKey) return {};
    const tier = this.#context.config.COINGECKO_API_TIER ?? 'public';
    return tier === 'pro'
      ? { 'x-cg-pro-api-key': String(apiKey) }
      : { 'x-cg-demo-api-key': String(apiKey) };
  }

  async search(query: string): Promise<DiscoveredCoin[]> {
    const term = query.trim();
    if (term === '') return [];

    const response = await this.#context.http.getJson<unknown>(`${this.#baseUrl()}/search`, {
      query: { query: term },
      headers: this.#headers(),
      // Search results are stable; cache generously to protect the rate limit
      // from a user typing.
      cacheTtlSeconds: 300,
    });
    if (!response.ok) return [];

    const parsed = searchResponseSchema.safeParse(response.value);
    if (!parsed.success) return [];

    return parsed.data.coins.slice(0, 25).map((coin) => ({
      coingeckoId: coin.id,
      symbol: coin.symbol.toUpperCase(),
      name: coin.name,
      marketCapRank: num(coin.market_cap_rank),
      imageUrl: coin.large ?? coin.thumb ?? null,
    }));
  }

  /** Full metadata for one coin, used when adding it to a watchlist. */
  async detail(coingeckoId: string): Promise<{
    coingeckoId: string;
    symbol: string;
    name: string;
    description: string | null;
    imageUrl: string | null;
    websiteUrl: string | null;
    githubRepos: string[];
    twitterHandle: string | null;
    subreddit: string | null;
    categories: string[];
    marketCapRank: number | null;
    contracts: Array<{ chain: string; address: string }>;
  } | null> {
    const response = await this.#context.http.getJson<unknown>(
      `${this.#baseUrl()}/coins/${encodeURIComponent(coingeckoId)}`,
      {
        query: {
          localization: false,
          tickers: false,
          market_data: false,
          community_data: true,
          developer_data: false,
          sparkline: false,
        },
        headers: this.#headers(),
        cacheTtlSeconds: 3_600,
      },
    );
    if (!response.ok) return null;

    const schema = z
      .object({
        id: z.string(),
        symbol: z.string(),
        name: z.string(),
        market_cap_rank: z.number().nullish(),
        categories: z.array(z.string().nullable()).nullish(),
        description: z.object({ en: z.string().nullish() }).nullish(),
        image: z.object({ large: z.string().nullish(), thumb: z.string().nullish() }).nullish(),
        links: z
          .object({
            homepage: z.array(z.string()).nullish(),
            repos_url: z.object({ github: z.array(z.string()).nullish() }).nullish(),
            twitter_screen_name: z.string().nullish(),
            subreddit_url: z.string().nullish(),
          })
          .nullish(),
        // Map of chain slug -> contract address.
        platforms: z.record(z.string().nullable()).nullish(),
      })
      .passthrough();

    const parsed = schema.safeParse(response.value);
    if (!parsed.success) return null;
    const data = parsed.data;

    // `repos_url.github` gives full URLs; the GitHub connector wants owner/repo.
    const githubRepos = (data.links?.repos_url?.github ?? [])
      .flatMap((url) => {
        const match = /github\.com\/([^/]+\/[^/#?]+)/.exec(url ?? '');
        return match?.[1] ? [match[1].replace(/\.git$/, '')] : [];
      })
      .slice(0, 5);

    const subreddit = data.links?.subreddit_url
      ? (/reddit\.com\/r\/([^/]+)/.exec(data.links.subreddit_url)?.[1] ?? null)
      : null;

    const homepage = (data.links?.homepage ?? []).find((url) => url && url.trim() !== '') ?? null;

    return {
      coingeckoId: data.id,
      symbol: data.symbol.toUpperCase(),
      name: data.name,
      description: data.description?.en?.slice(0, 4_000) ?? null,
      imageUrl: data.image?.large ?? data.image?.thumb ?? null,
      websiteUrl: homepage,
      githubRepos,
      twitterHandle: data.links?.twitter_screen_name ?? null,
      subreddit,
      categories: (data.categories ?? []).filter((c): c is string => typeof c === 'string'),
      marketCapRank: num(data.market_cap_rank),
      contracts: Object.entries(data.platforms ?? {}).flatMap(([chain, address]) =>
        chain && address && address.trim() !== '' ? [{ chain, address }] : [],
      ),
    };
  }
}
