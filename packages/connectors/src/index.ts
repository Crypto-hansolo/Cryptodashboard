import type { Connector } from '@cid/core';
import { DefaultConnectorRegistry } from './sdk/registry.js';
import { CoinGeckoMarketsConnector } from './market/coingecko.js';
import { BinanceCandlesConnector, BinanceConnector } from './market/binance.js';
import { DefiLlamaConnector, DexScreenerConnector } from './market/dex.js';
import { createNewsConnectors, type CoinLookup } from './news/rss.js';
import { GithubConnector } from './dev/github.js';
import { RedditConnector, type MentionBaselineLookup } from './social/reddit.js';
import { EtherscanConnector, type QuoteLookup } from './onchain/etherscan.js';
import { SnapshotConnector } from './governance/snapshot.js';

/**
 * `@cid/connectors` — the ingestion layer.
 *
 * Every source is a self-describing `Connector` (see sdk/base.ts). The registry
 * is the plugin surface: nothing in the worker knows which sources exist, only
 * how to ask for "enabled connectors in domain X".
 *
 * Connectors declare their own credential requirements, so the platform starts
 * and runs with zero API keys — key-gated sources are reported as disabled with
 * the exact missing variable named, rather than failing on every tick.
 *
 * See docs/EXTENDING.md to add one.
 */

export * from './sdk/base.js';
export * from './sdk/registry.js';
export { CoinGeckoMarketsConnector, CoinGeckoSearchClient } from './market/coingecko.js';
export type { DiscoveredCoin } from './market/coingecko.js';
export { BinanceConnector, BinanceCandlesConnector } from './market/binance.js';
export { DexScreenerConnector, DefiLlamaConnector } from './market/dex.js';
export {
  RssNewsConnector,
  createNewsConnectors,
  NEWS_FEEDS,
  classifyCategory,
} from './news/rss.js';
export type { FeedDefinition, CoinLookup } from './news/rss.js';
export { parseFeed, stripHtml } from './news/feed-parser.js';
export type { FeedItem, ParsedFeed } from './news/feed-parser.js';
export { GithubConnector } from './dev/github.js';
export { RedditConnector } from './social/reddit.js';
export type { MentionBaselineLookup } from './social/reddit.js';
export { EtherscanConnector } from './onchain/etherscan.js';
export type { QuoteLookup } from './onchain/etherscan.js';
export { SnapshotConnector } from './governance/snapshot.js';

/**
 * The narrow repository slices connectors need.
 *
 * Deliberately not the full `Repositories` aggregate: a connector that can reach
 * the whole persistence layer will eventually write to it directly, which breaks
 * the invariant that all persistence goes through the ingestion service.
 */
export interface ConnectorDependencies {
  coins: CoinLookup;
  quotes: QuoteLookup;
  baselines: MentionBaselineLookup;
}

/**
 * Build the registry with every bundled connector.
 *
 * Registration order is irrelevant — the scheduler groups by domain and sorts by
 * cadence — but grouping here keeps the inventory readable.
 */
export function buildConnectorRegistry(
  dependencies: ConnectorDependencies,
): DefaultConnectorRegistry {
  const registry = new DefaultConnectorRegistry();

  const connectors: Connector[] = [
    // Market & derivatives
    new CoinGeckoMarketsConnector(),
    new BinanceConnector(),
    new BinanceCandlesConnector(),
    new DexScreenerConnector(),
    new DefiLlamaConnector(),

    // Editorial — one connector per outlet, so each has its own credibility,
    // circuit breaker and telemetry.
    ...createNewsConnectors(dependencies.coins),

    // Development, social, on-chain, governance
    new GithubConnector(),
    new RedditConnector(dependencies.baselines),
    new EtherscanConnector(dependencies.quotes),
    new SnapshotConnector(),
  ];

  registry.registerAll(connectors);
  return registry;
}
