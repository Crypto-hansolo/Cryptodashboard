import type { Coin, CoinDraft, CoinIdentifier, CoinRepository, CoinSearchResult } from '@cid/core';
import { slugify } from '@cid/core';
import type { Prisma } from '@prisma/client';
import type { Db } from '../client.js';
import { toCoin, type CoinRow } from '../mappers.js';

const WITH_RELATIONS = { identifiers: true, contracts: true } as const;

export class PrismaCoinRepository implements CoinRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async findById(id: string): Promise<Coin | null> {
    const row = await this.#db.coin.findUnique({ where: { id }, include: WITH_RELATIONS });
    return row ? toCoin(row) : null;
  }

  async findManyByIds(ids: readonly string[]): Promise<Coin[]> {
    if (ids.length === 0) return [];
    const rows = await this.#db.coin.findMany({
      where: { id: { in: [...ids] } },
      include: WITH_RELATIONS,
    });
    return rows.map(toCoin);
  }

  async findBySlug(slug: string): Promise<Coin | null> {
    const row = await this.#db.coin.findUnique({ where: { slug }, include: WITH_RELATIONS });
    return row ? toCoin(row) : null;
  }

  /**
   * Try each identifier candidate in the order given.
   *
   * Order matters: `parseIdentifier` returns candidates ranked by confidence, and
   * for a bare EVM address that means "ethereum first, then the L2s". Resolving
   * them in one big OR query would return an arbitrary match instead of the most
   * likely one.
   */
  async findByIdentifiers(candidates: readonly CoinIdentifier[]): Promise<Coin | null> {
    for (const candidate of candidates) {
      const row = await this.#findByIdentifier(candidate);
      if (row) return toCoin(row);
    }
    return null;
  }

  async #findByIdentifier(candidate: CoinIdentifier): Promise<CoinRow | null> {
    switch (candidate.kind) {
      case 'COINGECKO':
        return this.#db.coin.findFirst({
          where: { coingeckoId: candidate.value },
          include: WITH_RELATIONS,
        });

      case 'COINMARKETCAP':
        return this.#db.coin.findFirst({
          where: { coinmarketcapId: candidate.value },
          include: WITH_RELATIONS,
        });

      case 'SLUG':
        return this.#db.coin.findFirst({
          where: { slug: candidate.value },
          include: WITH_RELATIONS,
        });

      case 'SYMBOL': {
        // Symbols collide. Prefer the highest-ranked asset, which is what a user
        // typing "APE" almost always means.
        return this.#db.coin.findFirst({
          where: { symbol: { equals: candidate.value, mode: 'insensitive' }, isActive: true },
          orderBy: [{ marketCapRank: { sort: 'asc', nulls: 'last' } }],
          include: WITH_RELATIONS,
        });
      }

      case 'CONTRACT': {
        const contract = await this.#db.coinContract.findFirst({
          where: {
            address: { equals: candidate.value, mode: 'insensitive' },
            ...(candidate.chain ? { chain: candidate.chain } : {}),
          },
          include: { coin: { include: WITH_RELATIONS } },
        });
        return contract?.coin ?? null;
      }

      case 'CHAIN_NATIVE':
        return this.#db.coin.findFirst({
          where: { chain: candidate.value, isActive: true },
          orderBy: [{ marketCapRank: { sort: 'asc', nulls: 'last' } }],
          include: WITH_RELATIONS,
        });

      default: {
        // Fall back to the generic identifier table for any kind added later.
        const identifier = await this.#db.coinIdentifier.findFirst({
          where: { kind: candidate.kind, value: candidate.value, chain: candidate.chain },
          include: { coin: { include: WITH_RELATIONS } },
        });
        return identifier?.coin ?? null;
      }
    }
  }

  /**
   * Ranked search for the command palette.
   *
   * Exact symbol beats prefix beats fuzzy name, and market-cap rank breaks ties.
   * Trigram similarity (backed by the GIN indexes from the search migration)
   * handles typos, which matters because this is wired to a live-as-you-type box.
   */
  async search(query: string, limit = 20): Promise<CoinSearchResult[]> {
    const term = query.trim();
    if (term === '') return [];

    const rows = await this.#db.$queryRaw<Array<{ id: string; score: number; matched_on: string }>>`
      SELECT id, score, matched_on FROM (
        SELECT
          c.id,
          CASE
            WHEN lower(c.symbol) = lower(${term}) THEN 1.0
            WHEN lower(c.slug) = lower(${term}) THEN 0.98
            WHEN lower(c.name) = lower(${term}) THEN 0.96
            WHEN lower(c.symbol) LIKE lower(${term}) || '%' THEN 0.85
            WHEN lower(c.name) LIKE lower(${term}) || '%' THEN 0.8
            WHEN lower(c.name) LIKE '%' || lower(${term}) || '%' THEN 0.6
            ELSE GREATEST(similarity(c.name, ${term}), similarity(c.symbol, ${term})) * 0.5
          END AS score,
          CASE
            WHEN lower(c.symbol) = lower(${term})
              OR lower(c.symbol) LIKE lower(${term}) || '%' THEN 'symbol'
            WHEN lower(c.slug) = lower(${term}) THEN 'slug'
            ELSE 'name'
          END AS matched_on,
          c."marketCapRank" AS rank
        FROM "Coin" c
        WHERE c."isActive" = true
          AND (
            lower(c.symbol) LIKE lower(${term}) || '%'
            OR lower(c.name) LIKE '%' || lower(${term}) || '%'
            OR lower(c.slug) LIKE '%' || lower(${term}) || '%'
            OR similarity(c.name, ${term}) > 0.3
            OR similarity(c.symbol, ${term}) > 0.4
          )
      ) matches
      WHERE score > 0.1
      ORDER BY score DESC, rank ASC NULLS LAST
      LIMIT ${limit}
    `;

    if (rows.length === 0) {
      // Nothing matched by name/symbol; try a contract address.
      const contract = await this.#db.coinContract.findFirst({
        where: { address: { equals: term, mode: 'insensitive' } },
        include: { coin: { include: WITH_RELATIONS } },
      });
      if (contract?.coin) {
        return [{ coin: toCoin(contract.coin), score: 1, matchedOn: 'contract' }];
      }
      return [];
    }

    // Second query for the full rows, then re-apply the ranking order.
    const coins = await this.#db.coin.findMany({
      where: { id: { in: rows.map((row) => row.id) } },
      include: WITH_RELATIONS,
    });
    const byId = new Map(coins.map((coin) => [coin.id, coin]));

    return rows.flatMap((row) => {
      const coin = byId.get(row.id);
      if (!coin) return [];
      return [
        {
          coin: toCoin(coin),
          score: Math.min(1, Number(row.score)),
          matchedOn: row.matched_on as CoinSearchResult['matchedOn'],
        },
      ];
    });
  }

  async upsert(draft: CoinDraft): Promise<Coin> {
    const slug = draft.slug || slugify(draft.name);

    const data = {
      symbol: draft.symbol,
      name: draft.name,
      coingeckoId: draft.coingeckoId ?? null,
      coinmarketcapId: draft.coinmarketcapId ?? null,
      chain: draft.chain ?? null,
      imageUrl: draft.imageUrl ?? null,
      description: draft.description ?? null,
      websiteUrl: draft.websiteUrl ?? null,
      githubRepos: draft.githubRepos ?? [],
      twitterHandle: draft.twitterHandle ?? null,
      subreddit: draft.subreddit ?? null,
      snapshotSpaces: draft.snapshotSpaces ?? [],
      marketCapRank: draft.marketCapRank ?? null,
      categories: draft.categories ?? [],
      isActive: draft.isActive ?? true,
    } satisfies Prisma.CoinUncheckedUpdateInput;

    const row = await this.#db.coin.upsert({
      where: { slug },
      create: { slug, ...data },
      update: data,
      include: WITH_RELATIONS,
    });

    // Contracts and identifiers are additive: a connector that only knows about
    // the Ethereum deployment must not delete the Solana one.
    if (draft.contracts && draft.contracts.length > 0) {
      await this.#db.coinContract.createMany({
        data: draft.contracts.map((contract) => ({
          coinId: row.id,
          chain: contract.chain,
          address: contract.address.toLowerCase(),
          decimals: contract.decimals ?? null,
          isNative: contract.isNative ?? false,
        })),
        skipDuplicates: true,
      });
    }

    if (draft.identifiers && draft.identifiers.length > 0) {
      await this.#db.coinIdentifier.createMany({
        data: draft.identifiers.map((identifier) => ({
          coinId: row.id,
          kind: identifier.kind,
          value: identifier.value,
          chain: identifier.chain ?? null,
        })),
        skipDuplicates: true,
      });
    }

    return this.findById(row.id).then((coin) => coin ?? toCoin(row));
  }

  async addIdentifier(coinId: string, identifier: CoinIdentifier): Promise<void> {
    await this.#db.coinIdentifier.createMany({
      data: [
        {
          coinId,
          kind: identifier.kind,
          value: identifier.value,
          chain: identifier.chain ?? null,
        },
      ],
      skipDuplicates: true,
    });
  }

  /**
   * Coins the scheduler should poll, in priority order.
   *
   * Priority is the point: with a 500-coin cap and a 10s market cadence, the
   * coins a user is actually watching must be polled before the tail of the
   * market-cap list. Pinned > watchlisted > by rank.
   */
  async listTracked(limit: number): Promise<Coin[]> {
    const rows = await this.#db.$queryRaw<Array<{ id: string }>>`
      SELECT c.id
      FROM "Coin" c
      LEFT JOIN (
        SELECT "coinId", bool_or("isPinned") AS pinned
        FROM "WatchlistItem"
        GROUP BY "coinId"
      ) w ON w."coinId" = c.id
      WHERE c."isActive" = true
      ORDER BY
        CASE WHEN w.pinned THEN 0 WHEN w."coinId" IS NOT NULL THEN 1 ELSE 2 END,
        c."marketCapRank" ASC NULLS LAST,
        c.id ASC
      LIMIT ${limit}
    `;
    if (rows.length === 0) return [];

    const coins = await this.#db.coin.findMany({
      where: { id: { in: rows.map((row) => row.id) } },
      include: WITH_RELATIONS,
    });
    const byId = new Map(coins.map((coin) => [coin.id, coin]));
    return rows.flatMap((row) => {
      const coin = byId.get(row.id);
      return coin ? [toCoin(coin)] : [];
    });
  }

  /** Minimal projection: the coin matcher runs this against every ingested item. */
  async listMatchable(): Promise<
    Array<{ id: string; symbol: string; name: string; aliases: string[] }>
  > {
    return this.#db.coin.findMany({
      where: { isActive: true },
      select: { id: true, symbol: true, name: true, aliases: true },
      orderBy: [{ marketCapRank: { sort: 'asc', nulls: 'last' } }],
    });
  }

  async count(): Promise<number> {
    return this.#db.coin.count();
  }
}
