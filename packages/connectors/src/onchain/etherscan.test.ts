import { describe, expect, it } from 'vitest';
import { UpstreamError } from '@cid/core';
import { makeCoin, makeContext, makeRequest, FIXED_NOW } from '../connector-fixtures.js';
import { EtherscanConnector, type QuoteLookup } from './etherscan.js';

/**
 * This connector's job is not "list transfers" — a busy ERC-20 has thousands an
 * hour — it is "find the transfers that matter and say what they mean". Two
 * things therefore have to be right: the whale threshold, and the direction
 * inference, because $5M moving *onto* an exchange means the opposite of $5M
 * moving off one.
 */

const CONTRACT = '0x514910771af9ca656af840dff83e8264ecf986ca';
const BINANCE_HOT = '0x28c6c06298d514db089934071355e5743bf21d60';
const BURN = '0x000000000000000000000000000000000000dead';
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET = '0x2222222222222222222222222222222222222222';

const coin = makeCoin({
  id: 'coin-link',
  symbol: 'LINK',
  name: 'Chainlink',
  chain: 'ethereum',
  contracts: [{ chain: 'ethereum', address: CONTRACT, decimals: 18, isNative: false }],
});

/** $20 per token, so 100,000 tokens is a $2M transfer — above the default threshold. */
function quotes(priceUsd: number | null = 20): QuoteLookup {
  return {
    latestQuotes: async (coinIds) =>
      priceUsd === null ? new Map() : new Map(coinIds.map((id) => [id, { priceUsd }] as const)),
  };
}

/** Etherscan reports amounts as integer strings in base units. */
function baseUnits(tokens: number, decimals = 18): string {
  return (BigInt(tokens) * 10n ** BigInt(decimals)).toString();
}

function transfer(overrides: Record<string, unknown> = {}) {
  return {
    blockNumber: '20481234',
    timeStamp: String(Math.floor((FIXED_NOW.getTime() - 300_000) / 1000)),
    hash: '0xtxhash',
    from: WALLET,
    to: OTHER_WALLET,
    value: baseUnits(100_000),
    tokenDecimal: '18',
    tokenSymbol: 'LINK',
    ...overrides,
  };
}

const route = (result: unknown, status = '1') => [
  { match: 'action=tokentx', body: { status, message: 'OK', result } },
];

describe('EtherscanConnector', () => {
  const connector = new EtherscanConnector(quotes());

  it('is disabled without a key, naming the variable', () => {
    /*
     * `required: true` here, unlike CoinGecko: there is no workable keyless tier,
     * and a connector that 403s every 60 seconds is worse than one that reports
     * itself off.
     */
    const { context } = makeContext();
    expect(connector.isEnabled(context)).toBe(false);
    expect(connector.missingRequirements(context)).toEqual(['ETHERSCAN_API_KEY']);

    const keyed = makeContext([], { ETHERSCAN_API_KEY: 'k' });
    expect(connector.isEnabled(keyed.context)).toBe(true);
  });

  it('refuses to collect while unconfigured, reporting what is missing', async () => {
    const { context, http } = makeContext(route([transfer()]));

    const result = await connector.collect(makeRequest([coin]), context);

    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('UNSUPPORTED');
    expect(result.error.context.missing).toEqual(['ETHERSCAN_API_KEY']);
    expect(http.requests).toHaveLength(0);
  });

  it('queries the V2 multichain endpoint with the chain id and the key', async () => {
    // One key, 50+ chains: the chain is a parameter, not a different host.
    const { context, http } = makeContext(route([]), { ETHERSCAN_API_KEY: 'k' });

    await connector.collect(makeRequest([coin]), context);

    expect(http.lastRequest?.query).toMatchObject({
      chainid: 1,
      module: 'account',
      action: 'tokentx',
      contractaddress: CONTRACT,
      sort: 'desc',
      apikey: 'k',
    });
  });

  it('uses the right chain id per contract chain', async () => {
    const { context, http } = makeContext(route([]), { ETHERSCAN_API_KEY: 'k' });
    const polygonCoin = makeCoin({
      id: 'coin-poly',
      contracts: [{ chain: 'polygon', address: CONTRACT, decimals: 18, isNative: false }],
    });

    await connector.collect(makeRequest([polygonCoin]), context);

    expect(http.lastRequest?.query?.chainid).toBe(137);
  });

  it('ignores contracts on chains Etherscan does not cover', async () => {
    const { context, http } = makeContext(route([]), { ETHERSCAN_API_KEY: 'k' });
    const solanaCoin = makeCoin({
      id: 'coin-sol',
      contracts: [{ chain: 'solana', address: 'So111', decimals: 9, isNative: false }],
    });

    const result = await connector.collect(makeRequest([solanaCoin]), context);

    expect(result.ok).toBe(true);
    expect(http.requests).toHaveLength(0);
  });

  it('converts base units to token amounts without precision loss', async () => {
    /*
     * 18-decimal values exceed Number's safe integer range, so a naive
     * Number(value) silently rounds. The two-step BigInt scaling is what keeps a
     * $2M transfer from being reported as $1.999999M — or worse.
     */
    const { context } = makeContext(route([transfer()]), { ETHERSCAN_API_KEY: 'k' });

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error(result.error.message);
    const event = result.value.records.onchainEvents?.[0];
    expect(event?.amount).toBe(100_000);
    expect(event?.amountUsd).toBe(2_000_000);
  });

  it('respects a token with non-18 decimals', async () => {
    const { context } = makeContext(
      route([transfer({ tokenDecimal: '6', value: baseUnits(100_000, 6) })]),
      { ETHERSCAN_API_KEY: 'k' },
    );

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.onchainEvents?.[0]?.amount).toBe(100_000);
  });

  it('ignores transfers below the whale threshold', async () => {
    // 1,000 tokens at $20 is $20k — routine activity, not an event.
    const { context } = makeContext(route([transfer({ value: baseUnits(1_000) })]), {
      ETHERSCAN_API_KEY: 'k',
    });

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.events).toEqual([]);
    expect(result.value.records.onchainEvents ?? []).toEqual([]);
    // The transfer was still seen.
    expect(result.value.itemsFetched).toBe(1);
  });

  it('honours a configured threshold', async () => {
    const { context } = makeContext(route([transfer({ value: baseUnits(1_000) })]), {
      ETHERSCAN_API_KEY: 'k',
      WHALE_THRESHOLD_USD: '10000',
    });

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.onchainEvents).toHaveLength(1);
  });

  it('skips everything when no price is known — USD is the only comparable scale', async () => {
    /*
     * Without a price there is no way to tell a $50 transfer from a $50M one, and
     * "100,000 tokens moved" is not a signal that can be thresholded across
     * assets.
     */
    const noPrice = new EtherscanConnector(quotes(null));
    const { context } = makeContext(route([transfer()]), { ETHERSCAN_API_KEY: 'k' });

    const result = await noPrice.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.onchainEvents ?? []).toEqual([]);
  });

  it('classifies a transfer to a known exchange as inflow, and reads bearish', async () => {
    // Coins arriving on an exchange are supply looking for a bid.
    const { context } = makeContext(route([transfer({ to: BINANCE_HOT })]), {
      ETHERSCAN_API_KEY: 'k',
    });

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.onchainEvents?.[0]).toMatchObject({
      type: 'EXCHANGE_INFLOW',
      toLabel: 'EXCHANGE',
      fromLabel: null,
    });
    expect(result.value.events[0]).toMatchObject({
      category: 'WHALE',
      subtype: 'EXCHANGE_INFLOW',
      sentimentHint: -0.4,
    });
    expect(result.value.events[0]?.headline).toContain('into Binance 14');
  });

  it('classifies a transfer from a known exchange as outflow, and reads bullish', async () => {
    const { context } = makeContext(route([transfer({ from: BINANCE_HOT })]), {
      ETHERSCAN_API_KEY: 'k',
    });

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.onchainEvents?.[0]?.type).toBe('EXCHANGE_OUTFLOW');
    expect(result.value.events[0]?.sentimentHint).toBe(0.4);
    expect(result.value.events[0]?.headline).toContain('out of Binance 14');
  });

  it('classifies a burn as tokenomics rather than a whale move', async () => {
    // A burn is a supply change, not a holder moving coins around.
    const { context } = makeContext(route([transfer({ to: BURN })]), { ETHERSCAN_API_KEY: 'k' });

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.onchainEvents?.[0]).toMatchObject({
      type: 'BURN',
      toLabel: 'BURN',
    });
    expect(result.value.events[0]).toMatchObject({
      category: 'TOKENOMICS',
      subtype: 'BURN',
      sentimentHint: 0.4,
    });
    expect(result.value.events[0]?.headline).toContain('burned');
  });

  it('describes an unlabelled wallet-to-wallet move with truncated addresses', async () => {
    const { context } = makeContext(route([transfer()]), { ETHERSCAN_API_KEY: 'k' });

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.onchainEvents?.[0]).toMatchObject({
      type: 'WHALE_TRANSFER',
      fromLabel: null,
      toLabel: null,
    });
    const headline = result.value.events[0]?.headline ?? '';
    expect(headline).toContain('moved from');
    // Full 42-character addresses would consume the whole row.
    expect(headline).not.toContain(WALLET);
    expect(result.value.events[0]?.sentimentHint).toBeNull();
  });

  it('records labelled counterparties so the wallet table improves over time', async () => {
    const { context } = makeContext(route([transfer({ to: BINANCE_HOT })]), {
      ETHERSCAN_API_KEY: 'k',
    });

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.wallets).toEqual([
      {
        chain: 'ethereum',
        address: BINANCE_HOT,
        label: 'EXCHANGE',
        entityName: 'Binance 14',
        coinIds: ['coin-link'],
      },
    ]);
  });

  it('links to the transaction and carries a stable external id', async () => {
    const { context } = makeContext(route([transfer()]), { ETHERSCAN_API_KEY: 'k' });

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.events[0]?.url).toBe('https://etherscan.io/tx/0xtxhash');
    // from/to are part of the id: one transaction can contain several transfers.
    expect(result.value.events[0]?.payload).toMatchObject({
      externalId: `0xtxhash:${WALLET}:${OTHER_WALLET}`,
      chain: 'ethereum',
      txHash: '0xtxhash',
    });
  });

  it('skips transfers at or before the high-water mark', async () => {
    const { context } = makeContext(route([transfer()]), { ETHERSCAN_API_KEY: 'k' });

    const result = await connector.collect(
      makeRequest([coin], new Date(FIXED_NOW.getTime() - 60_000)),
      context,
    );

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.onchainEvents ?? []).toEqual([]);
  });

  it('treats the "no transactions found" string result as an empty run', async () => {
    // Etherscan answers status "0" with a message string rather than an array.
    const { context } = makeContext(route('No transactions found', '0'), {
      ETHERSCAN_API_KEY: 'k',
    });

    const result = await connector.collect(makeRequest([coin]), context);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.records.onchainEvents ?? []).toEqual([]);
  });

  it('skips a failed chain without failing the run', async () => {
    const { context } = makeContext(
      [{ match: 'action=tokentx', error: new UpstreamError('etherscan', 'rate limited', 429) }],
      { ETHERSCAN_API_KEY: 'k' },
    );

    expect((await connector.collect(makeRequest([coin]), context)).ok).toBe(true);
  });

  it('skips a transfer whose value is not a valid integer', async () => {
    const { context } = makeContext(route([transfer({ value: 'not-a-number' })]), {
      ETHERSCAN_API_KEY: 'k',
    });

    const result = await connector.collect(makeRequest([coin]), context);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.records.onchainEvents ?? []).toEqual([]);
  });

  it('caps fan-out at 15 contracts per run', async () => {
    const coins = Array.from({ length: 25 }, (_, index) =>
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
    const { context, http } = makeContext(route([]), { ETHERSCAN_API_KEY: 'k' });

    await connector.collect(makeRequest(coins), context);

    expect(http.requests).toHaveLength(15);
  });
});
