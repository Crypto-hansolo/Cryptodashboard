import { z } from 'zod';
import type { CollectionRequest, ConnectorContext, ConnectorDescriptor } from '@cid/core';
import { BaseConnector, type CollectionBuilder, num } from '../sdk/base.js';

/**
 * DEX and DeFi connectors — the on-chain half of market data.
 *
 * DexScreener covers pool liquidity and price for tokens that never reach a CEX
 * (which is most of them), and DefiLlama covers protocol TVL. Both are keyless.
 */

// ─── DexScreener ─────────────────────────────────────────────────────────────

const dexPairSchema = z
  .object({
    chainId: z.string(),
    dexId: z.string(),
    pairAddress: z.string(),
    baseToken: z.object({ address: z.string(), symbol: z.string(), name: z.string() }),
    quoteToken: z.object({ address: z.string(), symbol: z.string() }),
    priceUsd: z.string().nullish(),
    liquidity: z.object({ usd: z.number().nullish() }).nullish(),
    volume: z.object({ h24: z.number().nullish() }).nullish(),
    txns: z
      .object({
        h24: z.object({ buys: z.number().nullish(), sells: z.number().nullish() }).nullish(),
      })
      .nullish(),
    priceChange: z.object({ h24: z.number().nullish() }).nullish(),
    pairCreatedAt: z.number().nullish(),
  })
  .passthrough();

const dexResponseSchema = z.object({ pairs: z.array(dexPairSchema).nullable().default([]) });

/** DexScreener chain ids differ from ours; map the ones we support. */
const DEXSCREENER_CHAIN: Readonly<Record<string, string>> = {
  ethereum: 'ethereum',
  bsc: 'bsc',
  polygon: 'polygon',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  base: 'base',
  avalanche: 'avalanche',
  solana: 'solana',
  cronos: 'cronos',
  fantom: 'fantom',
  linea: 'linea',
  blast: 'blast',
  mantle: 'mantle',
  scroll: 'scroll',
  zksync: 'zksync',
  sui: 'sui',
  aptos: 'aptos',
  ton: 'ton',
  tron: 'tron',
};

export class DexScreenerConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    key: 'dexscreener',
    name: 'DexScreener',
    domain: 'dex',
    sourceKind: 'DEX',
    homepageUrl: 'https://dexscreener.com',
    credibility: 0.75,
    requirements: [],
    defaultIntervalMs: 60_000,
    // Documented at 300 req/min; stay well under to leave headroom.
    rateLimit: { requestsPerMinute: 120, burst: 20 },
    batchesCoins: true,
    // The tokens endpoint accepts up to 30 comma-separated addresses.
    maxCoinsPerRun: 30,
  };

  protected async run(
    request: CollectionRequest,
    context: ConnectorContext,
    builder: CollectionBuilder,
  ): Promise<void> {
    const base = this.config(context, 'DEXSCREENER_API_BASE') ?? 'https://api.dexscreener.com';
    const observedAt = context.clock.now();

    // Only coins with a known contract address can be looked up here.
    const targets = request.coins.flatMap((coin) =>
      coin.contracts.map((contract) => ({ coin, contract })),
    );
    if (targets.length === 0) return;

    // Index by lowercase address so responses can be attributed back to a coin.
    const byAddress = new Map(
      targets.map(({ coin, contract }) => [contract.address.toLowerCase(), coin] as const),
    );

    const chunkSize = this.descriptor.maxCoinsPerRun ?? 30;
    for (let offset = 0; offset < targets.length; offset += chunkSize) {
      const chunk = targets.slice(offset, offset + chunkSize);
      const addresses = chunk.map(({ contract }) => contract.address).join(',');

      const response = await context.http.getJson<unknown>(
        `${base}/latest/dex/tokens/${addresses}`,
        { cacheTtlSeconds: 30 },
      );
      if (!response.ok) continue;

      const parsed = dexResponseSchema.safeParse(response.value);
      if (!parsed.success) continue;

      const pairs = parsed.data.pairs ?? [];
      builder.countFetched(pairs.length);

      const pools: Array<Record<string, unknown>> = [];
      const snapshots: Array<Record<string, unknown>> = [];
      // Best pool per coin, used as the price source for tokens with no CEX listing.
      const bestByCoin = new Map<
        string,
        { liquidity: number; price: number; change: number | null }
      >();

      for (const pair of pairs) {
        const coin = byAddress.get(pair.baseToken.address.toLowerCase());
        if (!coin) continue;

        const chain = DEXSCREENER_CHAIN[pair.chainId] ?? 'other';
        const liquidityUsd = num(pair.liquidity?.usd) ?? 0;
        const priceUsd = num(pair.priceUsd);

        pools.push({
          sourceKey: this.descriptor.key,
          coinId: coin.id,
          observedAt,
          chain,
          dex: pair.dexId,
          poolAddress: pair.pairAddress,
          pairLabel: `${pair.baseToken.symbol}/${pair.quoteToken.symbol}`,
          liquidityUsd,
          volume24hUsd: num(pair.volume?.h24),
          priceUsd,
          buys24h: num(pair.txns?.h24?.buys),
          sells24h: num(pair.txns?.h24?.sells),
        });

        // Deepest pool wins: a thin pool's price is trivially manipulable.
        if (priceUsd !== null) {
          const current = bestByCoin.get(coin.id);
          if (!current || liquidityUsd > current.liquidity) {
            bestByCoin.set(coin.id, {
              liquidity: liquidityUsd,
              price: priceUsd,
              change: num(pair.priceChange?.h24),
            });
          }
        }
      }

      for (const [coinId, best] of bestByCoin) {
        snapshots.push({
          sourceKey: this.descriptor.key,
          coinId,
          observedAt,
          priceUsd: best.price,
          marketCapUsd: null,
          fdvUsd: null,
          volume24hUsd: null,
          circulatingSupply: null,
          totalSupply: null,
          maxSupply: null,
          liquidityUsd: best.liquidity,
          priceChange1hPct: null,
          priceChange24hPct: best.change,
          priceChange7dPct: null,
          priceChange30dPct: null,
          marketCapRank: null,
          athUsd: null,
          atlUsd: null,
        });
      }

      builder.add('liquidityPools', pools);
      builder.add('marketSnapshots', snapshots);
    }
  }
}

// ─── DefiLlama ───────────────────────────────────────────────────────────────

const llamaProtocolSchema = z
  .object({
    name: z.string(),
    slug: z.string().nullish(),
    symbol: z.string().nullish(),
    tvl: z.number().nullish(),
    change_1d: z.number().nullish(),
    gecko_id: z.string().nullish(),
  })
  .passthrough();

/**
 * DefiLlama TVL.
 *
 * TVL is the closest thing to a fundamental for a DeFi protocol token, and it
 * moves on news the price has not reacted to yet. One call returns every
 * protocol, so this is cheap regardless of watchlist size.
 */
export class DefiLlamaConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    key: 'defillama',
    name: 'DefiLlama',
    domain: 'tokenomics',
    sourceKind: 'ANALYTICS',
    homepageUrl: 'https://defillama.com',
    credibility: 0.85,
    requirements: [],
    defaultIntervalMs: 900_000,
    rateLimit: { requestsPerMinute: 20, burst: 5 },
    batchesCoins: true,
  };

  protected async run(
    request: CollectionRequest,
    context: ConnectorContext,
    builder: CollectionBuilder,
  ): Promise<void> {
    if (request.coins.length === 0) return;
    const base = this.config(context, 'DEFILLAMA_API_BASE') ?? 'https://api.llama.fi';

    const response = await context.http.getJson<unknown>(`${base}/protocols`, {
      cacheTtlSeconds: 600,
    });
    if (!response.ok) throw response.error;

    const parsed = z.array(llamaProtocolSchema).safeParse(response.value);
    if (!parsed.success) throw new Error('defillama: unexpected protocols payload');
    builder.countFetched(parsed.data.length);

    // Match on gecko_id where available — symbol matching alone would attribute
    // an unrelated protocol's TVL to a coin sharing its ticker.
    const byGeckoId = new Map(
      request.coins.flatMap((coin) => (coin.coingeckoId ? [[coin.coingeckoId, coin]] : [])),
    );

    const observedAt = context.clock.now();
    const tokenomics: Array<Record<string, unknown>> = [];

    for (const protocol of parsed.data) {
      const coin = protocol.gecko_id ? byGeckoId.get(protocol.gecko_id) : undefined;
      if (!coin) continue;
      const tvl = num(protocol.tvl);
      if (tvl === null) continue;

      tokenomics.push({
        sourceKey: this.descriptor.key,
        coinId: coin.id,
        observedAt,
        inflationRate: null,
        emissions24h: null,
        burned24h: null,
        stakingApy: null,
        stakedSupply: null,
        stakedPct: null,
        validatorCount: null,
        treasuryUsd: null,
        tvlUsd: tvl,
      });
    }

    builder.add('tokenomics', tokenomics);
  }
}
