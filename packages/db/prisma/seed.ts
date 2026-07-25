/**
 * Seed script.
 *
 * Creates the local user, a default watchlist, a representative set of coins
 * spanning every namespace the platform claims to support (EVM token, Solana
 * SPL, Bitcoin-ecosystem, Cosmos), the source registry, and a small amount of
 * synthetic history so the UI and the E2E suite have something to render
 * without waiting on live ingestion.
 *
 * Idempotent: safe to re-run. `npm run db:seed`.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  computeDedupeHash,
  computeImportance,
  importanceToImpact,
  scoreToSentiment,
} from '@cid/core';

// npm runs workspace scripts with the package as cwd, so the repo-root .env is
// not picked up implicitly. Resolve it relative to this file instead of relying
// on where the command happened to be invoked from.
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env') });

const db = new PrismaClient();

const SOURCES = [
  {
    key: 'coingecko',
    name: 'CoinGecko',
    kind: 'MARKET_DATA' as const,
    credibility: 0.9,
    homepageUrl: 'https://www.coingecko.com',
  },
  {
    key: 'binance',
    name: 'Binance',
    kind: 'DERIVATIVES' as const,
    credibility: 0.95,
    homepageUrl: 'https://www.binance.com',
  },
  {
    key: 'dexscreener',
    name: 'DexScreener',
    kind: 'DEX' as const,
    credibility: 0.75,
    homepageUrl: 'https://dexscreener.com',
  },
  {
    key: 'defillama',
    name: 'DefiLlama',
    kind: 'ANALYTICS' as const,
    credibility: 0.85,
    homepageUrl: 'https://defillama.com',
  },
  {
    key: 'coindesk',
    name: 'CoinDesk',
    kind: 'NEWS' as const,
    credibility: 0.85,
    homepageUrl: 'https://www.coindesk.com',
  },
  {
    key: 'cointelegraph',
    name: 'Cointelegraph',
    kind: 'NEWS' as const,
    credibility: 0.7,
    homepageUrl: 'https://cointelegraph.com',
  },
  {
    key: 'theblock',
    name: 'The Block',
    kind: 'NEWS' as const,
    credibility: 0.88,
    homepageUrl: 'https://www.theblock.co',
  },
  {
    key: 'decrypt',
    name: 'Decrypt',
    kind: 'NEWS' as const,
    credibility: 0.75,
    homepageUrl: 'https://decrypt.co',
  },
  {
    key: 'blockworks',
    name: 'Blockworks',
    kind: 'NEWS' as const,
    credibility: 0.8,
    homepageUrl: 'https://blockworks.co',
  },
  {
    key: 'github',
    name: 'GitHub',
    kind: 'CODE' as const,
    credibility: 0.95,
    homepageUrl: 'https://github.com',
  },
  {
    key: 'reddit',
    name: 'Reddit',
    kind: 'FORUM' as const,
    credibility: 0.4,
    homepageUrl: 'https://reddit.com',
  },
  { key: 'x', name: 'X', kind: 'SOCIAL' as const, credibility: 0.45, homepageUrl: 'https://x.com' },
  {
    key: 'snapshot',
    name: 'Snapshot',
    kind: 'GOVERNANCE' as const,
    credibility: 0.9,
    homepageUrl: 'https://snapshot.org',
  },
  {
    key: 'etherscan',
    name: 'Etherscan',
    kind: 'ONCHAIN' as const,
    credibility: 0.95,
    homepageUrl: 'https://etherscan.io',
  },
  {
    key: 'internal',
    name: 'Internal',
    kind: 'INTERNAL' as const,
    credibility: 1,
    homepageUrl: null,
  },
];

const COINS = [
  {
    slug: 'bitcoin',
    symbol: 'BTC',
    name: 'Bitcoin',
    coingeckoId: 'bitcoin',
    chain: 'bitcoin',
    marketCapRank: 1,
    price: 94_250,
    githubRepos: ['bitcoin/bitcoin'],
    categories: ['store-of-value', 'pow'],
    subreddit: 'Bitcoin',
    aliases: ['btc'],
  },
  {
    slug: 'ethereum',
    symbol: 'ETH',
    name: 'Ethereum',
    coingeckoId: 'ethereum',
    chain: 'ethereum',
    marketCapRank: 2,
    price: 3_180,
    githubRepos: ['ethereum/go-ethereum'],
    categories: ['smart-contract-platform', 'l1'],
    subreddit: 'ethereum',
    snapshotSpaces: [],
    aliases: ['ether'],
  },
  {
    slug: 'solana',
    symbol: 'SOL',
    name: 'Solana',
    coingeckoId: 'solana',
    chain: 'solana',
    marketCapRank: 5,
    price: 182.4,
    githubRepos: ['solana-labs/solana'],
    categories: ['smart-contract-platform', 'l1'],
    subreddit: 'solana',
    aliases: [],
  },
  {
    slug: 'crypto-com-chain',
    symbol: 'CRO',
    name: 'Cronos',
    coingeckoId: 'crypto-com-chain',
    chain: 'cronos',
    marketCapRank: 42,
    price: 0.1284,
    githubRepos: ['crypto-org-chain/cronos'],
    categories: ['exchange-token', 'l1'],
    contracts: [
      { chain: 'ethereum', address: '0xa0b73e1ff0b80914ab6fe0444e65848c4c34450b', decimals: 8 },
    ],
    aliases: ['crypto.com coin', 'cronos chain'],
  },
  {
    slug: 'chainlink',
    symbol: 'LINK',
    name: 'Chainlink',
    coingeckoId: 'chainlink',
    chain: 'ethereum',
    marketCapRank: 14,
    price: 22.65,
    githubRepos: ['smartcontractkit/chainlink'],
    categories: ['oracle', 'defi'],
    contracts: [
      { chain: 'ethereum', address: '0x514910771af9ca656af840dff83e8264ecf986ca', decimals: 18 },
    ],
    aliases: [],
  },
  {
    slug: 'celestia',
    symbol: 'TIA',
    name: 'Celestia',
    coingeckoId: 'celestia',
    chain: 'celestia',
    marketCapRank: 88,
    price: 4.12,
    githubRepos: ['celestiaorg/celestia-node'],
    categories: ['modular', 'data-availability'],
    aliases: [],
  },
];

const NEWS = [
  {
    coinSlug: 'crypto-com-chain',
    sourceKey: 'coindesk',
    headline: 'Binance lists Cronos (CRO) for spot trading with USDT and USDC pairs',
    body: 'Binance announced support for CRO spot trading, opening two new pairs. Deposits open immediately with trading enabled 24 hours later.',
    summary: 'Binance opened CRO spot trading with USDT and USDC pairs.',
    category: 'EXCHANGE_LISTING' as const,
    sentimentScore: 0.8,
    hoursAgo: 2,
    narratives: ['exchange-listings'],
  },
  {
    coinSlug: 'crypto-com-chain',
    sourceKey: 'cointelegraph',
    headline: 'Cronos to list on Binance in spot markets, CRO rallies',
    body: 'Following the Binance announcement, CRO gained sharply on the news.',
    summary: 'CRO rallied on the Binance listing news.',
    category: 'EXCHANGE_LISTING' as const,
    sentimentScore: 0.75,
    hoursAgo: 2,
    narratives: ['exchange-listings'],
  },
  {
    coinSlug: 'ethereum',
    sourceKey: 'theblock',
    headline: 'Ethereum core developers delay the Pectra upgrade to next quarter',
    body: 'Client teams cited additional testing requirements on the devnets, pushing the timeline back roughly six weeks.',
    summary: 'The Pectra upgrade slipped by about six weeks after devnet testing issues.',
    category: 'DEVELOPMENT' as const,
    sentimentScore: -0.35,
    hoursAgo: 6,
    narratives: ['ethereum-roadmap'],
  },
  {
    coinSlug: 'solana',
    sourceKey: 'blockworks',
    headline: 'Solana DEX volumes hit a record as network fees stay low',
    body: 'Aggregate DEX volume across Solana set a new all-time high this week.',
    summary: 'Solana DEX volume reached an all-time high.',
    category: 'MARKET_STRUCTURE' as const,
    sentimentScore: 0.65,
    hoursAgo: 9,
    narratives: ['solana-defi'],
  },
  {
    coinSlug: 'chainlink',
    sourceKey: 'decrypt',
    headline: 'Chainlink CCIP integrated by a major custodian for cross-chain settlement',
    body: 'The integration brings institutional settlement flows onto CCIP.',
    summary: 'A major custodian adopted Chainlink CCIP for cross-chain settlement.',
    category: 'PARTNERSHIP' as const,
    sentimentScore: 0.7,
    hoursAgo: 14,
    narratives: ['institutional-adoption', 'interoperability'],
  },
  {
    coinSlug: 'bitcoin',
    sourceKey: 'coindesk',
    headline: 'Spot Bitcoin ETFs record their largest weekly inflow of the year',
    body: 'Net inflows across US spot Bitcoin ETFs reached their highest level since launch.',
    summary: 'US spot Bitcoin ETFs saw record weekly net inflows.',
    category: 'NEWS' as const,
    sentimentScore: 0.85,
    hoursAgo: 20,
    narratives: ['etf-flows'],
  },
  {
    coinSlug: 'celestia',
    sourceKey: 'theblock',
    headline: 'Celestia unlock schedule puts 8% of circulating supply into the market',
    body: 'An investor tranche vests next month, materially increasing float.',
    summary: 'A Celestia investor unlock will add ~8% to circulating supply.',
    category: 'TOKENOMICS' as const,
    sentimentScore: -0.6,
    hoursAgo: 30,
    narratives: ['token-unlocks'],
  },
  {
    coinSlug: 'ethereum',
    sourceKey: 'coindesk',
    headline: 'A DeFi protocol on Ethereum was exploited for $14M via a price oracle manipulation',
    body: 'The attacker manipulated a thinly traded oracle pair to drain the lending pool.',
    summary: 'An Ethereum DeFi protocol lost $14M to oracle manipulation.',
    category: 'SECURITY' as const,
    sentimentScore: -0.9,
    hoursAgo: 40,
    narratives: ['defi-security'],
  },
];

async function main(): Promise<void> {
  console.log('seeding…');

  // ── Sources ──
  for (const source of SOURCES) {
    await db.source.upsert({
      where: { key: source.key },
      create: source,
      update: { name: source.name, kind: source.kind, credibility: source.credibility },
    });
  }
  const sourceIds = new Map(
    (await db.source.findMany()).map((source) => [source.key, source.id] as const),
  );
  console.log(`  ${SOURCES.length} sources`);

  // ── User + default watchlist ──
  const user = await db.user.upsert({
    where: { email: 'local@localhost' },
    create: { email: 'local@localhost', name: 'Local' },
    update: {},
  });

  const watchlist = await db.watchlist.upsert({
    where: { userId_name: { userId: user.id, name: 'Watchlist' } },
    create: { userId: user.id, name: 'Watchlist', isDefault: true },
    update: { isDefault: true },
  });

  // ── Coins ──
  const coinIds = new Map<string, string>();
  for (const [index, spec] of COINS.entries()) {
    const coin = await db.coin.upsert({
      where: { slug: spec.slug },
      create: {
        slug: spec.slug,
        symbol: spec.symbol,
        name: spec.name,
        coingeckoId: spec.coingeckoId,
        chain: spec.chain,
        marketCapRank: spec.marketCapRank,
        githubRepos: spec.githubRepos ?? [],
        categories: spec.categories ?? [],
        subreddit: spec.subreddit ?? null,
        snapshotSpaces: spec.snapshotSpaces ?? [],
        aliases: spec.aliases ?? [],
      },
      update: { marketCapRank: spec.marketCapRank, aliases: spec.aliases ?? [] },
    });
    coinIds.set(spec.slug, coin.id);

    await db.coinIdentifier.createMany({
      data: [
        { coinId: coin.id, kind: 'COINGECKO', value: spec.coingeckoId, chain: null },
        { coinId: coin.id, kind: 'SYMBOL', value: spec.symbol, chain: null },
        { coinId: coin.id, kind: 'SLUG', value: spec.slug, chain: null },
      ],
      skipDuplicates: true,
    });

    if (spec.contracts) {
      await db.coinContract.createMany({
        data: spec.contracts.map((contract) => ({
          coinId: coin.id,
          chain: contract.chain,
          address: contract.address,
          decimals: contract.decimals,
          isNative: false,
        })),
        skipDuplicates: true,
      });
    }

    await db.watchlistItem.upsert({
      where: { watchlistId_coinId: { watchlistId: watchlist.id, coinId: coin.id } },
      create: {
        watchlistId: watchlist.id,
        coinId: coin.id,
        position: index,
        // Pin the top two so the priority-ordering path is exercised.
        isPinned: index < 2,
      },
      update: {},
    });
  }
  console.log(`  ${COINS.length} coins on the default watchlist`);

  // ── Synthetic price history ──
  //
  // 7 days at 30-minute resolution. A deterministic pseudo-random walk (fixed
  // seed) so the charts look plausible and, more importantly, so E2E assertions
  // are reproducible across runs.
  const now = new Date();
  const coingeckoId = sourceIds.get('coingecko');
  if (coingeckoId) {
    let seed = 1337;
    const random = (): number => {
      // Mulberry32 — small, fast, deterministic.
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const points = 7 * 48;
    for (const spec of COINS) {
      const coinId = coinIds.get(spec.slug);
      if (!coinId) continue;

      const existing = await db.marketSnapshot.count({ where: { coinId } });
      if (existing > 0) continue;

      let price = spec.price * 0.92;
      const rows = [];
      for (let i = points; i >= 0; i--) {
        // Mean-reverting walk toward the target price.
        const drift = (spec.price - price) * 0.02;
        price = Math.max(price * 0.5, price + drift + price * (random() - 0.5) * 0.02);
        const observedAt = new Date(now.getTime() - i * 30 * 60_000);
        const supply = spec.price > 1000 ? 19_800_000 : 3_400_000_000;
        rows.push({
          coinId,
          sourceId: coingeckoId,
          observedAt,
          priceUsd: Number(price.toPrecision(8)),
          marketCapUsd: price * supply,
          fdvUsd: price * supply * 1.1,
          volume24hUsd: price * supply * (0.02 + random() * 0.04),
          circulatingSupply: supply,
          totalSupply: supply * 1.1,
          maxSupply: null,
          liquidityUsd: price * supply * 0.01,
          priceChange24hPct: (random() - 0.5) * 8,
          marketCapRank: spec.marketCapRank,
        });
      }
      await db.marketSnapshot.createMany({ data: rows });
    }
    console.log(`  price history for ${COINS.length} coins (7d @ 30m)`);
  }

  // ── Events ──
  //
  // Scored with the same functions the live pipeline uses, so seeded rows are
  // indistinguishable in shape from ingested ones.
  let eventsCreated = 0;
  for (const item of NEWS) {
    const coinId = coinIds.get(item.coinSlug);
    const sourceId = sourceIds.get(item.sourceKey);
    if (!coinId || !sourceId) continue;

    const source = SOURCES.find((s) => s.key === item.sourceKey);
    const occurredAt = new Date(now.getTime() - item.hoursAgo * 3_600_000);
    const dedupeHash = computeDedupeHash({
      sourceKey: item.sourceKey,
      url: `https://example.test/${item.coinSlug}/${item.hoursAgo}`,
      headline: item.headline,
      occurredAt,
    });

    const importance = computeImportance({
      category: item.category,
      sourceCredibility: source?.credibility ?? 0.5,
      ageMs: now.getTime() - occurredAt.getTime(),
    });

    const created = await db.event.upsert({
      where: { sourceId_dedupeHash: { sourceId, dedupeHash } },
      create: {
        occurredAt,
        coinId,
        sourceId,
        category: item.category,
        headline: item.headline,
        body: item.body,
        url: `https://example.test/${item.coinSlug}/${item.hoursAgo}`,
        dedupeHash,
        summary: item.summary,
        explanation: `Seeded example event for local development.`,
        sentiment: scoreToSentiment(item.sentimentScore),
        sentimentScore: item.sentimentScore,
        importance,
        confidence: 70,
        impact: importanceToImpact(importance),
        narratives: item.narratives,
        model: 'seed',
        enrichedAt: new Date(),
      },
      update: {},
    });
    eventsCreated++;

    await db.newsArticle.upsert({
      where: { eventId: created.id },
      create: {
        eventId: created.id,
        sourceId,
        title: item.headline,
        publishedAt: occurredAt,
        url: `https://example.test/${item.coinSlug}/${item.hoursAgo}`,
        excerpt: item.body.slice(0, 200),
        coinIds: [coinId],
      },
      update: {},
    });
  }
  console.log(`  ${eventsCreated} events`);

  // ── A sample alert ──
  await db.alert.upsert({
    where: { id: 'seed-alert-breaking-news' },
    create: {
      id: 'seed-alert-breaking-news',
      userId: user.id,
      name: 'Breaking news on my watchlist',
      rule: { type: 'BREAKING_NEWS', coinIds: [], minImportance: 70 },
      channels: ['DESKTOP'],
      cooldownSeconds: 300,
    },
    update: {},
  });
  console.log('  1 alert');

  console.log('seed complete');
}

main()
  .catch((error: unknown) => {
    console.error('seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void db.$disconnect();
  });
