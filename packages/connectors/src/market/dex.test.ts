import { describe, expect, it } from 'vitest';
import { UpstreamError } from '@cid/core';
import { makeCoin, makeContext, makeRequest, FIXED_NOW } from '../connector-fixtures.js';
import { DefiLlamaConnector, DexScreenerConnector } from './dex.js';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

function tokenCoin(address = USDC) {
  return makeCoin({
    id: 'coin-token',
    symbol: 'TKN',
    name: 'Token',
    chain: 'ethereum',
    contracts: [{ chain: 'ethereum', address, decimals: 18, isNative: false }],
  });
}

function pair(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 'ethereum',
    dexId: 'uniswap',
    pairAddress: '0xpool1',
    baseToken: { address: USDC, symbol: 'TKN', name: 'Token' },
    quoteToken: { address: WETH, symbol: 'WETH', name: 'Wrapped Ether' },
    priceUsd: '1.24',
    liquidity: { usd: 4_200_000 },
    volume: { h24: 1_100_000 },
    priceChange: { h24: 3.4 },
    txns: { h24: { buys: 412, sells: 388 } },
    ...overrides,
  };
}

describe('DexScreenerConnector', () => {
  const connector = new DexScreenerConnector();

  it('maps a pool onto a liquidity record', async () => {
    const { context } = makeContext([{ match: '/latest/dex/tokens/', body: { pairs: [pair()] } }]);

    const result = await connector.collect(makeRequest([tokenCoin()]), context);

    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.records.liquidityPools).toEqual([
      {
        sourceKey: 'dexscreener',
        coinId: 'coin-token',
        observedAt: FIXED_NOW,
        chain: 'ethereum',
        dex: 'uniswap',
        poolAddress: '0xpool1',
        pairLabel: 'TKN/WETH',
        liquidityUsd: 4_200_000,
        volume24hUsd: 1_100_000,
        priceUsd: 1.24,
        buys24h: 412,
        sells24h: 388,
      },
    ]);
  });

  it('prices a token from its deepest pool, not the first or the highest price', async () => {
    /*
     * A thin pool's price is trivially manipulable — spend a few thousand dollars
     * and it prints any number you like. Taking the deepest pool is the whole
     * defence, and this is the DEX equivalent of a price oracle decision.
     */
    const { context } = makeContext([
      {
        match: '/latest/dex/tokens/',
        body: {
          pairs: [
            pair({ pairAddress: '0xthin', priceUsd: '99.00', liquidity: { usd: 900 } }),
            pair({ pairAddress: '0xdeep', priceUsd: '1.24', liquidity: { usd: 4_200_000 } }),
            pair({ pairAddress: '0xmid', priceUsd: '1.31', liquidity: { usd: 500_000 } }),
          ],
        },
      },
    ]);

    const result = await connector.collect(makeRequest([tokenCoin()]), context);

    if (!result.ok) throw new Error('expected success');
    const snapshots = result.value.records.marketSnapshots ?? [];
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ priceUsd: 1.24, liquidityUsd: 4_200_000 });
  });

  it('attributes pools by address case-insensitively', async () => {
    // Checksummed vs lowercase addresses are the same token; a case-sensitive
    // lookup would silently drop every pool.
    const { context } = makeContext([
      {
        match: '/latest/dex/tokens/',
        body: {
          pairs: [
            pair({ baseToken: { address: USDC.toLowerCase(), symbol: 'TKN', name: 'Token' } }),
          ],
        },
      },
    ]);

    const result = await connector.collect(makeRequest([tokenCoin(USDC)]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.liquidityPools).toHaveLength(1);
  });

  it('ignores pools whose base token is a different asset', async () => {
    // The tokens endpoint returns pools where the address appears on either side.
    const { context } = makeContext([
      {
        match: '/latest/dex/tokens/',
        body: {
          pairs: [pair({ baseToken: { address: '0xother', symbol: 'OTHER', name: 'Other' } })],
        },
      },
    ]);

    const result = await connector.collect(makeRequest([tokenCoin()]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.liquidityPools ?? []).toEqual([]);
  });

  it('maps an unknown chain id to "other" rather than dropping the pool', async () => {
    const { context } = makeContext([
      { match: '/latest/dex/tokens/', body: { pairs: [pair({ chainId: 'somenewchain' })] } },
    ]);

    const result = await connector.collect(makeRequest([tokenCoin()]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.liquidityPools?.[0]?.chain).toBe('other');
  });

  it('skips a pool with no price for the snapshot but keeps the pool row', async () => {
    const { context } = makeContext([
      { match: '/latest/dex/tokens/', body: { pairs: [pair({ priceUsd: null })] } },
    ]);

    const result = await connector.collect(makeRequest([tokenCoin()]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.liquidityPools).toHaveLength(1);
    expect(result.value.records.marketSnapshots ?? []).toEqual([]);
  });

  it('does nothing for coins with no contract address', async () => {
    const { context, http } = makeContext([{ match: '/latest/dex/tokens/', body: { pairs: [] } }]);

    const result = await connector.collect(makeRequest([makeCoin()]), context);

    expect(result.ok).toBe(true);
    expect(http.requests).toHaveLength(0);
  });

  it('chunks addresses to the endpoint limit of 30', async () => {
    const coins = Array.from({ length: 35 }, (_, index) =>
      makeCoin({
        id: `coin-${index}`,
        contracts: [
          {
            chain: 'ethereum',
            address: `0x${index.toString(16).padStart(40, '0')}`,
            decimals: 18,
            isNative: false,
          },
        ],
      }),
    );
    const { context, http } = makeContext([{ match: '/latest/dex/tokens/', body: { pairs: [] } }]);

    await connector.collect(makeRequest(coins), context);

    expect(http.requests).toHaveLength(2);
    expect(http.requests[0]?.url.split(',')).toHaveLength(30);
    expect(http.requests[1]?.url.split(',')).toHaveLength(5);
  });

  it('degrades quietly on a failed chunk — DEX data is supplementary', async () => {
    /*
     * Unlike CoinGecko this does not throw: DEX pools augment a price the market
     * connectors already provide, so a failure here should not mark the run failed
     * and trigger backoff on the whole source.
     */
    const { context } = makeContext([
      { match: '/latest/dex/tokens/', error: new UpstreamError('dexscreener', 'down', 503) },
    ]);

    const result = await connector.collect(makeRequest([tokenCoin()]), context);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.records.liquidityPools ?? []).toEqual([]);
  });

  it('degrades quietly on a malformed payload', async () => {
    const { context } = makeContext([{ match: '/latest/dex/tokens/', body: { pairs: 'nope' } }]);

    expect((await connector.collect(makeRequest([tokenCoin()]), context)).ok).toBe(true);
  });

  it('needs no credentials', () => {
    expect(connector.descriptor.requirements).toEqual([]);
  });
});

describe('DefiLlamaConnector', () => {
  const connector = new DefiLlamaConnector();

  const protocol = {
    name: 'Aave V3',
    slug: 'aave-v3',
    symbol: 'AAVE',
    tvl: 12_400_000_000,
    change_1d: -1.2,
    gecko_id: 'aave',
  };

  it('matches protocols by gecko id, not by symbol', async () => {
    /*
     * Symbol matching would attribute an unrelated protocol's TVL to any coin
     * sharing its ticker — and DeFi tickers collide constantly.
     */
    const { context } = makeContext([
      {
        match: '/protocols',
        body: [protocol, { ...protocol, name: 'Impostor', symbol: 'AAVE', gecko_id: 'other-coin' }],
      },
    ]);
    const coin = makeCoin({ id: 'coin-aave', symbol: 'AAVE', coingeckoId: 'aave' });

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.records.tokenomics).toEqual([
      {
        sourceKey: 'defillama',
        coinId: 'coin-aave',
        observedAt: FIXED_NOW,
        inflationRate: null,
        emissions24h: null,
        burned24h: null,
        stakingApy: null,
        stakedSupply: null,
        stakedPct: null,
        validatorCount: null,
        treasuryUsd: null,
        tvlUsd: 12_400_000_000,
      },
    ]);
  });

  it('ignores a protocol with no gecko id', async () => {
    const { context } = makeContext([
      { match: '/protocols', body: [{ ...protocol, gecko_id: null }] },
    ]);
    const coin = makeCoin({ coingeckoId: 'aave' });

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.tokenomics ?? []).toEqual([]);
  });

  it('skips a protocol reporting no TVL', async () => {
    const { context } = makeContext([{ match: '/protocols', body: [{ ...protocol, tvl: null }] }]);
    const coin = makeCoin({ coingeckoId: 'aave' });

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.tokenomics ?? []).toEqual([]);
  });

  it('fails the run on an upstream error, since this is the only TVL source', async () => {
    const { context } = makeContext([
      { match: '/protocols', error: new UpstreamError('defillama', 'down', 503) },
    ]);

    expect((await connector.collect(makeRequest([makeCoin()]), context)).ok).toBe(false);
  });

  it('fails the run on a malformed payload', async () => {
    const { context } = makeContext([{ match: '/protocols', body: { not: 'an array' } }]);

    expect((await connector.collect(makeRequest([makeCoin()]), context)).ok).toBe(false);
  });

  it('makes no request when nothing is tracked', async () => {
    const { context, http } = makeContext([{ match: '/protocols', body: [] }]);

    await connector.collect(makeRequest([]), context);

    expect(http.requests).toHaveLength(0);
  });
});
