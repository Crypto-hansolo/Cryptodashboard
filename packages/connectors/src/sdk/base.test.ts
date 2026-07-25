import { describe, expect, it } from 'vitest';
import type {
  CollectionRequest,
  Coin,
  ConnectorContext,
  ConnectorDescriptor,
  Logger,
} from '@cid/core';
import { noopLogger, systemClock } from '@cid/core';
import {
  BaseConnector,
  CollectionBuilder,
  indexBySymbol,
  num,
  numOr,
  parseTimestamp,
  splitSymbol,
} from './base.js';
import { DefaultConnectorRegistry } from './registry.js';
import { classifyCategory } from '../news/rss.js';

function coin(overrides: Partial<Coin> = {}): Coin {
  return {
    id: 'c1',
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function context(config: Record<string, string | undefined> = {}): ConnectorContext {
  return {
    http: {} as ConnectorContext['http'],
    cache: {} as ConnectorContext['cache'],
    logger: noopLogger as Logger,
    clock: systemClock,
    rateLimiter: {} as ConnectorContext['rateLimiter'],
    config,
  };
}

const request: CollectionRequest = { coins: [], since: null };

describe('num / numOr', () => {
  it('coerces the strings exchange APIs return', () => {
    expect(num('42.5')).toBeCloseTo(42.5);
    expect(num(7)).toBe(7);
  });

  it('returns null for unusable values', () => {
    expect(num('')).toBeNull();
    expect(num(null)).toBeNull();
    expect(num(undefined)).toBeNull();
    expect(num('abc')).toBeNull();
    expect(num(Number.NaN)).toBeNull();
    expect(num(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('falls back for required columns', () => {
    expect(numOr('abc', 0)).toBe(0);
    expect(numOr('5', 0)).toBe(5);
  });
});

describe('parseTimestamp', () => {
  it('accepts ISO text', () => {
    expect(parseTimestamp('2026-06-01T12:00:00Z')?.toISOString()).toBe('2026-06-01T12:00:00.000Z');
  });

  it('accepts seconds and milliseconds, distinguishing them', () => {
    // 1780000000 s = 2026; 1780000000000 ms = the same instant.
    expect(parseTimestamp(1780000000)?.getUTCFullYear()).toBe(2026);
    expect(parseTimestamp(1780000000000)?.getUTCFullYear()).toBe(2026);
  });

  it('accepts a numeric string, as Etherscan returns', () => {
    expect(parseTimestamp('1780000000')?.getUTCFullYear()).toBe(2026);
  });

  it('rejects implausible values rather than returning an epoch date', () => {
    // A 1970 date would silently sort to the bottom of the timeline forever.
    expect(parseTimestamp(0)).toBeNull();
    expect(parseTimestamp(-5)).toBeNull();
    expect(parseTimestamp('not a date')).toBeNull();
    expect(parseTimestamp('1995-01-01')).toBeNull();
    expect(parseTimestamp('2099-01-01')).toBeNull();
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp('')).toBeNull();
  });
});

describe('splitSymbol', () => {
  it('splits known quote suffixes, longest first', () => {
    expect(splitSymbol('BTCUSDT')).toEqual({ base: 'BTC', quote: 'USDT' });
    // Must not match "USD" and leave a stray "T".
    expect(splitSymbol('ETHUSD')).toEqual({ base: 'ETH', quote: 'USD' });
    expect(splitSymbol('CROUSDC')).toEqual({ base: 'CRO', quote: 'USDC' });
  });

  it('returns null for an unknown quote rather than guessing', () => {
    expect(splitSymbol('BTCEUR')).toBeNull();
    expect(splitSymbol('RANDOM')).toBeNull();
  });

  it('does not produce an empty base', () => {
    expect(splitSymbol('USDT')).toBeNull();
  });
});

describe('indexBySymbol', () => {
  it('resolves a colliding symbol to the highest-ranked coin', () => {
    // Must agree with CoinRepository.findByIdentifiers, or the same ticker maps
    // to different assets depending on the code path.
    const index = indexBySymbol([
      coin({ id: 'real', symbol: 'APE', marketCapRank: 80 }),
      coin({ id: 'fake', symbol: 'APE', marketCapRank: 4000 }),
    ]);
    expect(index.get('APE')?.id).toBe('real');
  });

  it('treats a missing rank as lowest priority', () => {
    const index = indexBySymbol([
      coin({ id: 'unranked', symbol: 'X', marketCapRank: null }),
      coin({ id: 'ranked', symbol: 'X', marketCapRank: 500 }),
    ]);
    expect(index.get('X')?.id).toBe('ranked');
  });

  it('is case-insensitive on the key', () => {
    expect(indexBySymbol([coin({ symbol: 'btc' })]).get('BTC')).toBeDefined();
  });
});

describe('CollectionBuilder', () => {
  it('accumulates events, records and fetch counts', () => {
    const builder = new CollectionBuilder();
    builder.countFetched(5).countFetched(3);
    builder.add('marketSnapshots', [{ a: 1 }]).add('marketSnapshots', [{ a: 2 }]);

    const result = builder.build();
    expect(result.itemsFetched).toBe(8);
    expect(result.records.marketSnapshots).toHaveLength(2);
    expect(result.events).toEqual([]);
  });

  it('ignores empty record batches', () => {
    const result = new CollectionBuilder().add('news', []).build();
    expect(result.records.news).toBeUndefined();
  });
});

// ─── BaseConnector credential handling ───────────────────────────────────────

class RequiredKeyConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    key: 'needs-key',
    name: 'Needs Key',
    domain: 'onchain',
    sourceKind: 'ONCHAIN',
    homepageUrl: null,
    credibility: 0.9,
    requirements: [{ envKey: 'SOME_KEY', required: true, description: 'required' }],
    defaultIntervalMs: 60_000,
    rateLimit: { requestsPerMinute: 10 },
    batchesCoins: false,
  };

  protected async run(): Promise<void> {
    // no-op
  }
}

class OptionalKeyConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    key: 'optional-key',
    name: 'Optional Key',
    domain: 'market',
    sourceKind: 'MARKET_DATA',
    homepageUrl: null,
    credibility: 0.9,
    requirements: [{ envKey: 'NICE_KEY', required: false, description: 'optional' }],
    defaultIntervalMs: 60_000,
    rateLimit: { requestsPerMinute: 10 },
    batchesCoins: true,
  };

  protected async run(): Promise<void> {
    // no-op
  }
}

class ThrowingConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    key: 'throws',
    name: 'Throws',
    domain: 'news',
    sourceKind: 'NEWS',
    homepageUrl: null,
    credibility: 0.5,
    requirements: [],
    defaultIntervalMs: 60_000,
    rateLimit: { requestsPerMinute: 10 },
    batchesCoins: true,
  };

  protected async run(): Promise<void> {
    throw new Error('upstream exploded');
  }
}

describe('BaseConnector', () => {
  it('disables itself when a required credential is missing', () => {
    const connector = new RequiredKeyConnector();
    expect(connector.isEnabled(context())).toBe(false);
    expect(connector.isEnabled(context({ SOME_KEY: 'abc' }))).toBe(true);
  });

  it('treats an empty or whitespace value as missing', () => {
    const connector = new RequiredKeyConnector();
    expect(connector.isEnabled(context({ SOME_KEY: '' }))).toBe(false);
    expect(connector.isEnabled(context({ SOME_KEY: '   ' }))).toBe(false);
  });

  it('names the missing variable, so the status UI can be specific', () => {
    expect(new RequiredKeyConnector().missingRequirements(context())).toEqual(['SOME_KEY']);
  });

  it('stays enabled but degraded without an optional credential', () => {
    const connector = new OptionalKeyConnector();
    expect(connector.isEnabled(context())).toBe(true);
    expect(connector.isDegraded(context())).toBe(true);
    expect(connector.isDegraded(context({ NICE_KEY: 'abc' }))).toBe(false);
  });

  it('returns an Err instead of running when not configured', async () => {
    const result = await new RequiredKeyConnector().collect(request, context());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNSUPPORTED');
  });

  it('converts a thrown exception into an Err rather than crashing the tick', async () => {
    const result = await new ThrowingConnector().collect(request, context());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('upstream exploded');
  });

  it('returns an empty result for a successful no-op run', async () => {
    const result = await new OptionalKeyConnector().collect(request, context());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.events).toEqual([]);
      expect(result.value.itemsFetched).toBe(0);
    }
  });
});

describe('DefaultConnectorRegistry', () => {
  it('registers and retrieves by key and domain', () => {
    const registry = new DefaultConnectorRegistry();
    registry.registerAll([new OptionalKeyConnector(), new RequiredKeyConnector()]);

    expect(registry.get('optional-key')).not.toBeNull();
    expect(registry.get('nope')).toBeNull();
    expect(registry.list()).toHaveLength(2);
    expect(registry.listByDomain('market').map((c) => c.descriptor.key)).toEqual(['optional-key']);
  });

  it('rejects a duplicate key, which would collide on Source.key', () => {
    const registry = new DefaultConnectorRegistry();
    registry.register(new OptionalKeyConnector());
    expect(() => registry.register(new OptionalKeyConnector())).toThrow(/Duplicate connector key/);
  });

  it('lists only connectors whose requirements are met', () => {
    const registry = new DefaultConnectorRegistry();
    registry.registerAll([new OptionalKeyConnector(), new RequiredKeyConnector()]);

    expect(registry.listEnabled(context()).map((c) => c.descriptor.key)).toEqual(['optional-key']);
    expect(
      registry
        .listEnabled(context({ SOME_KEY: 'x' }))
        .map((c) => c.descriptor.key)
        .sort(),
    ).toEqual(['needs-key', 'optional-key']);
  });

  it('describes enablement, degradation and the specific missing variable', () => {
    const registry = new DefaultConnectorRegistry();
    registry.registerAll([new OptionalKeyConnector(), new RequiredKeyConnector()]);

    const described = registry.describe(context());
    expect(described.map((d) => d.descriptor.key)).toEqual(['needs-key', 'optional-key']);

    const needsKey = described.find((d) => d.descriptor.key === 'needs-key');
    expect(needsKey?.enabled).toBe(false);
    expect(needsKey?.missingRequirements).toEqual(['SOME_KEY']);

    const optional = described.find((d) => d.descriptor.key === 'optional-key');
    expect(optional?.enabled).toBe(true);
    expect(optional?.degraded).toBe(true);
  });

  it('applies declared rate limits to a limiter that supports configure()', () => {
    const configured: Array<{ key: string; rpm: number }> = [];
    const registry = new DefaultConnectorRegistry();
    registry.register(new OptionalKeyConnector());

    registry.configureRateLimits({
      ...context(),
      rateLimiter: {
        configure: (key: string, config: { requestsPerMinute: number }) =>
          configured.push({ key, rpm: config.requestsPerMinute }),
      } as unknown as ConnectorContext['rateLimiter'],
    });

    expect(configured).toEqual([{ key: 'optional-key', rpm: 10 }]);
  });

  it('does not throw when the limiter has no configure()', () => {
    const registry = new DefaultConnectorRegistry();
    registry.register(new OptionalKeyConnector());
    expect(() => registry.configureRateLimits(context())).not.toThrow();
  });
});

describe('classifyCategory', () => {
  it('picks the most specific matching category', () => {
    expect(classifyCategory('Protocol exploited for $14M')).toBe('SECURITY');
    expect(classifyCategory('SEC files a lawsuit against the exchange')).toBe('REGULATORY');
    expect(classifyCategory('Binance lists CRO for spot trading')).toBe('EXCHANGE_LISTING');
    expect(classifyCategory('Token unlock adds 8% to supply')).toBe('TOKENOMICS');
    expect(classifyCategory('New governance proposal opens for voting')).toBe('GOVERNANCE');
    expect(classifyCategory('Mainnet upgrade ships next week')).toBe('DEVELOPMENT');
    expect(classifyCategory('Chainlink announces a partnership')).toBe('PARTNERSHIP');
  });

  it('ranks a security incident above a regulatory mention', () => {
    // Both keywords present; the incident is the story.
    expect(classifyCategory('SEC probes exchange after hack drained funds')).toBe('SECURITY');
  });

  it('falls back to the supplied default', () => {
    expect(classifyCategory('A quiet day in markets')).toBe('NEWS');
    expect(classifyCategory('A quiet day in markets', 'SOCIAL')).toBe('SOCIAL');
  });
});
