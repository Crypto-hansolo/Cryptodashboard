import { z } from 'zod';
import type {
  CollectionRequest,
  ConnectorContext,
  ConnectorDescriptor,
  EventDraft,
  OnchainEventType,
  WalletLabel,
} from '@cid/core';
import { formatUsd, truncate, truncateAddress } from '@cid/core';
import { BaseConnector, type CollectionBuilder, num, parseTimestamp } from '../sdk/base.js';

/**
 * Etherscan (V2 multichain) token-transfer connector.
 *
 * Etherscan's V2 API covers 50+ chains behind a single key, which is why one
 * connector handles every EVM chain rather than one per explorer. The key is
 * required: there is no usable keyless tier.
 *
 * The job is not "list transfers" — it is "find the transfers that matter".
 * A busy ERC-20 has thousands per hour, so only movements above the whale
 * threshold become events, and direction is inferred from known exchange
 * addresses because a $5M transfer *onto* an exchange means something very
 * different from one into cold storage.
 */

const transferSchema = z
  .object({
    blockNumber: z.string(),
    timeStamp: z.string(),
    hash: z.string(),
    from: z.string(),
    to: z.string(),
    value: z.string(),
    tokenDecimal: z.string().nullish(),
    tokenSymbol: z.string().nullish(),
  })
  .passthrough();

const responseSchema = z.object({
  status: z.string(),
  message: z.string().nullish(),
  // Etherscan returns the string "NOTOK"/message in `result` on error.
  result: z.union([z.array(transferSchema), z.string()]),
});

/** Chain slug -> Etherscan V2 numeric chain id. */
const CHAIN_IDS: Readonly<Record<string, number>> = {
  ethereum: 1,
  bsc: 56,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
  avalanche: 43114,
  linea: 59144,
  scroll: 534352,
  blast: 81457,
  mantle: 5000,
  cronos: 25,
  fantom: 250,
  gnosis: 100,
  celo: 42220,
  zksync: 324,
};

/**
 * Known exchange deposit/hot wallets, used to classify flow direction.
 *
 * A deliberately small, high-confidence seed list. The `Wallet` table is the
 * real store and grows via labelling providers (Arkham/Nansen) when configured;
 * this exists so that direction inference works with zero paid integrations.
 */
const KNOWN_EXCHANGE_ADDRESSES: Readonly<Record<string, string>> = {
  '0x28c6c06298d514db089934071355e5743bf21d60': 'Binance 14',
  '0x21a31ee1afc51d94c2efccaa2092ad1028285549': 'Binance 15',
  '0xdfd5293d8e347dfe59e90efd55b2956a1343963d': 'Binance 16',
  '0x56eddb7aa87536c09ccc2793473599fd21a8b17f': 'Binance 17',
  '0x9696f59e4d72e237be84ffd425dcad154bf96976': 'Binance 18',
  '0x4976a4a02f38326660d17bf34b431dc6e2eb2327': 'Binance 20',
  '0xf977814e90da44bfa03b6295a0616a897441acec': 'Binance 8',
  '0x5041ed759dd4afc3a72b8192c143f72f4724081a': 'OKX',
  '0x6cc5f688a315f3dc28a7781717a9a798a59fda7b': 'OKX 2',
  '0x2faf487a4414fe77e2327f0bf4ae2a264a776ad2': 'Coinbase 4',
  '0x71660c4005ba85c37ccec55d0c4493e66fe775d3': 'Coinbase 1',
  '0x503828976d22510aad0201ac7ec88293211d23da': 'Coinbase 2',
  '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43': 'Coinbase 10',
  '0xdc76cd25977e0a5ae17155770273ad58648900d3': 'Huobi 10',
  '0x0d0707963952f2fba59dd06f2b425ace40b492fe': 'Gate.io',
  '0x0000000000000000000000000000000000000000': 'Null / burn',
  '0x000000000000000000000000000000000000dead': 'Burn',
};

const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

/** Latest price provider, so USD values can be attached to raw token amounts. */
export interface QuoteLookup {
  latestQuotes(coinIds: readonly string[]): Promise<Map<string, { priceUsd: number }>>;
}

export class EtherscanConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    key: 'etherscan',
    name: 'Etherscan',
    domain: 'onchain',
    sourceKind: 'ONCHAIN',
    homepageUrl: 'https://etherscan.io',
    credibility: 0.95,
    requirements: [
      {
        envKey: 'ETHERSCAN_API_KEY',
        // Genuinely required: there is no workable keyless tier, and a disabled
        // connector is far better than one that 403s every 60 seconds.
        required: true,
        description:
          'Required. A single Etherscan V2 key covers 50+ EVM chains. Free tier allows 5 req/s.',
      },
    ],
    defaultIntervalMs: 60_000,
    rateLimit: { requestsPerMinute: 60, burst: 10 },
    batchesCoins: false,
  };

  readonly #quotes: QuoteLookup;

  constructor(quotes: QuoteLookup) {
    super();
    this.#quotes = quotes;
  }

  protected async run(
    request: CollectionRequest,
    context: ConnectorContext,
    builder: CollectionBuilder,
  ): Promise<void> {
    const apiKey = this.requireConfig(context, 'ETHERSCAN_API_KEY');
    const base = this.config(context, 'ETHERSCAN_API_BASE') ?? 'https://api.etherscan.io/v2/api';
    const threshold = this.configNumber(context, 'WHALE_THRESHOLD_USD', 1_000_000);

    // Only EVM contracts on chains Etherscan V2 covers.
    const targets = request.coins
      .flatMap((coin) =>
        coin.contracts
          .filter((contract) => CHAIN_IDS[contract.chain] !== undefined)
          .map((contract) => ({ coin, contract })),
      )
      .slice(0, 15);
    if (targets.length === 0) return;

    const quotes = await this.#quotes.latestQuotes(targets.map(({ coin }) => coin.id));
    const events: EventDraft[] = [];
    const onchainEvents: Array<Record<string, unknown>> = [];
    const wallets: Array<Record<string, unknown>> = [];

    for (const { coin, contract } of targets) {
      const chainId = CHAIN_IDS[contract.chain];
      if (chainId === undefined) continue;

      const response = await context.http.getJson<unknown>(base, {
        query: {
          chainid: chainId,
          module: 'account',
          action: 'tokentx',
          contractaddress: contract.address,
          page: 1,
          offset: 100,
          sort: 'desc',
          apikey: apiKey,
        },
        cacheTtlSeconds: 30,
      });
      if (!response.ok) continue;

      const parsed = responseSchema.safeParse(response.value);
      // status "0" with a string result means "no transactions found", which is
      // a normal outcome and not an error worth logging.
      if (!parsed.success || typeof parsed.data.result === 'string') continue;

      const transfers = parsed.data.result;
      builder.countFetched(transfers.length);

      const price = quotes.get(coin.id)?.priceUsd ?? null;
      const decimals = num(transfers[0]?.tokenDecimal) ?? contract.decimals ?? 18;

      for (const transfer of transfers) {
        const occurredAt = parseTimestamp(transfer.timeStamp);
        if (!occurredAt) continue;
        if (request.since && occurredAt <= request.since) continue;

        // Token amounts are integer strings in base units. BigInt avoids the
        // precision loss that Number() causes on 18-decimal values.
        let amount: number;
        try {
          const raw = BigInt(transfer.value);
          // Scale down in two steps to stay inside Number's safe range.
          const divisor = 10n ** BigInt(Math.min(decimals, 18));
          const whole = raw / divisor;
          const fraction = raw % divisor;
          amount = Number(whole) + Number(fraction) / Number(divisor);
        } catch {
          continue;
        }

        const amountUsd = price === null ? null : amount * price;
        // Below the threshold this is routine activity, not an event.
        if (amountUsd === null || amountUsd < threshold) continue;

        const from = transfer.from.toLowerCase();
        const to = transfer.to.toLowerCase();
        const fromEntity = KNOWN_EXCHANGE_ADDRESSES[from];
        const toEntity = KNOWN_EXCHANGE_ADDRESSES[to];

        const fromLabel: WalletLabel | null = fromEntity
          ? BURN_ADDRESSES.has(from)
            ? 'BURN'
            : 'EXCHANGE'
          : null;
        const toLabel: WalletLabel | null = toEntity
          ? BURN_ADDRESSES.has(to)
            ? 'BURN'
            : 'EXCHANGE'
          : null;

        // Direction drives the sentiment sign: exchange inflow is distribution
        // pressure, outflow is accumulation.
        let type: OnchainEventType = 'WHALE_TRANSFER';
        let sentimentHint: number | null = null;
        if (BURN_ADDRESSES.has(to)) {
          type = 'BURN';
          sentimentHint = 0.4;
        } else if (toLabel === 'EXCHANGE') {
          type = 'EXCHANGE_INFLOW';
          sentimentHint = -0.4;
        } else if (fromLabel === 'EXCHANGE') {
          type = 'EXCHANGE_OUTFLOW';
          sentimentHint = 0.4;
        }

        const direction =
          type === 'EXCHANGE_INFLOW'
            ? ` into ${toEntity}`
            : type === 'EXCHANGE_OUTFLOW'
              ? ` out of ${fromEntity}`
              : type === 'BURN'
                ? ' burned'
                : '';

        events.push({
          occurredAt,
          sourceKey: this.descriptor.key,
          coinId: coin.id,
          category: type === 'BURN' ? 'TOKENOMICS' : 'WHALE',
          subtype: type,
          headline: truncate(
            `${formatUsd(amountUsd)} of ${coin.symbol}${direction}` +
              (direction === ''
                ? ` moved from ${truncateAddress(from)} to ${truncateAddress(to)}`
                : ''),
            300,
          ),
          body: null,
          url: `https://etherscan.io/tx/${transfer.hash}`,
          author: null,
          sentimentHint,
          payload: {
            externalId: `${transfer.hash}:${from}:${to}`,
            chain: contract.chain,
            txHash: transfer.hash,
          },
        });

        onchainEvents.push({
          sourceKey: this.descriptor.key,
          coinId: coin.id,
          type,
          occurredAt,
          chain: contract.chain,
          txHash: transfer.hash,
          blockNumber: num(transfer.blockNumber),
          fromAddress: from,
          toAddress: to,
          fromLabel,
          toLabel,
          amount,
          amountUsd,
          metadata: { tokenSymbol: transfer.tokenSymbol ?? coin.symbol },
        });

        // Record labelled counterparties so the wallet table improves over time.
        if (fromEntity) {
          wallets.push({
            chain: contract.chain,
            address: from,
            label: fromLabel ?? 'UNKNOWN',
            entityName: fromEntity,
            coinIds: [coin.id],
          });
        }
        if (toEntity) {
          wallets.push({
            chain: contract.chain,
            address: to,
            label: toLabel ?? 'UNKNOWN',
            entityName: toEntity,
            coinIds: [coin.id],
          });
        }
      }
    }

    builder.addEvents(events);
    builder.add('onchainEvents', onchainEvents);
    builder.add('wallets', wallets);
  }
}
