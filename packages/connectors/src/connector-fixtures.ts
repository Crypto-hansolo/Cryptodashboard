import { noopLogger, type Coin, type CollectionRequest, type ConnectorContext } from '@cid/core';
import { FakeClock, FakeHttpClient, type StubRoute } from '@cid/platform/testing';

/**
 * Shared fixtures for connector tests.
 *
 * Every connector test needs the same three things — a `Coin`, a
 * `ConnectorContext` wired to a scripted HTTP client, and a `CollectionRequest` —
 * and duplicating a 25-field coin literal per file guarantees they drift apart
 * until "the same" coin means something different in each.
 *
 * Not a `.test.ts` file, so the runner does not try to collect tests from it.
 */

export const FIXED_NOW = new Date('2026-07-25T12:00:00.000Z');

export function makeCoin(overrides: Partial<Coin> = {}): Coin {
  return {
    id: 'coin-btc',
    slug: 'bitcoin',
    symbol: 'BTC',
    name: 'Bitcoin',
    coingeckoId: 'bitcoin',
    coinmarketcapId: null,
    chain: 'bitcoin',
    imageUrl: null,
    description: null,
    websiteUrl: null,
    githubRepos: [],
    twitterHandle: null,
    subreddit: null,
    snapshotSpaces: [],
    marketCapRank: 1,
    contracts: [],
    identifiers: [],
    categories: [],
    isActive: true,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  };
}

export interface TestContext {
  context: ConnectorContext;
  http: FakeHttpClient;
  clock: FakeClock;
}

export function makeContext(
  routes: readonly StubRoute[] = [],
  config: Record<string, string | undefined> = {},
): TestContext {
  const http = new FakeHttpClient(routes);
  const clock = new FakeClock(FIXED_NOW);
  return {
    http,
    clock,
    context: {
      http,
      // Connectors never touch these directly — the HTTP client owns caching and
      // rate limiting — so leaving them unimplemented makes an accidental
      // dependency on them fail loudly rather than silently work.
      cache: {} as ConnectorContext['cache'],
      rateLimiter: {} as ConnectorContext['rateLimiter'],
      logger: noopLogger,
      clock,
      config,
    },
  };
}

export function makeRequest(
  coins: readonly Coin[] = [],
  since: Date | null = null,
): CollectionRequest {
  return { coins, since };
}
