import type {
  Portfolio,
  PortfolioHolding,
  PortfolioRepository,
  Tag,
  TagRepository,
  TrackedCoin,
  Watchlist,
  WatchlistItem,
  WatchlistRepository,
} from '@cid/core';
import type { Db } from '../client.js';
import { toCoin } from '../mappers.js';

/** Per-user organisation: watchlists, portfolios and tags. */
export class PrismaWatchlistRepository implements WatchlistRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async listForUser(userId: string): Promise<Watchlist[]> {
    return this.#db.watchlist.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * The user's default watchlist, created on first access.
   *
   * Lazy creation rather than a seed requirement: the UI can assume a watchlist
   * always exists, and a fresh install does not need a migration step.
   */
  async getDefault(userId: string): Promise<Watchlist> {
    const existing = await this.#db.watchlist.findFirst({ where: { userId, isDefault: true } });
    if (existing) return existing;
    return this.#db.watchlist.upsert({
      where: { userId_name: { userId, name: 'Watchlist' } },
      create: { userId, name: 'Watchlist', isDefault: true },
      update: { isDefault: true },
    });
  }

  async create(userId: string, name: string, description?: string | null): Promise<Watchlist> {
    return this.#db.watchlist.create({ data: { userId, name, description: description ?? null } });
  }

  async rename(id: string, name: string): Promise<Watchlist> {
    return this.#db.watchlist.update({ where: { id }, data: { name } });
  }

  async remove(id: string): Promise<void> {
    await this.#db.watchlist.delete({ where: { id } });
  }

  async listItems(watchlistId: string): Promise<TrackedCoin[]> {
    const items = await this.#db.watchlistItem.findMany({
      where: { watchlistId },
      orderBy: [{ isPinned: 'desc' }, { position: 'asc' }],
      include: {
        coin: {
          include: {
            identifiers: true,
            contracts: true,
            coinTags: { include: { tag: true } },
          },
        },
      },
    });

    return items.map((item) => ({
      coin: toCoin(item.coin),
      isPinned: item.isPinned,
      position: item.position,
      tags: item.coin.coinTags.map((coinTag) => coinTag.tag),
    }));
  }

  async addCoin(watchlistId: string, coinId: string): Promise<WatchlistItem> {
    // Append at the end of the list.
    const last = await this.#db.watchlistItem.findFirst({
      where: { watchlistId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    return this.#db.watchlistItem.upsert({
      where: { watchlistId_coinId: { watchlistId, coinId } },
      create: { watchlistId, coinId, position: (last?.position ?? -1) + 1 },
      update: {},
    });
  }

  async removeCoin(watchlistId: string, coinId: string): Promise<void> {
    await this.#db.watchlistItem.deleteMany({ where: { watchlistId, coinId } });
  }

  async setPinned(watchlistId: string, coinId: string, pinned: boolean): Promise<void> {
    await this.#db.watchlistItem.updateMany({
      where: { watchlistId, coinId },
      data: { isPinned: pinned },
    });
  }

  /** Persist a drag-and-drop reorder in one transaction. */
  async reorder(watchlistId: string, orderedCoinIds: readonly string[]): Promise<void> {
    await this.#db.$transaction(
      orderedCoinIds.map((coinId, index) =>
        this.#db.watchlistItem.updateMany({
          where: { watchlistId, coinId },
          data: { position: index },
        }),
      ),
    );
  }
}

export class PrismaPortfolioRepository implements PortfolioRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async listForUser(userId: string): Promise<Portfolio[]> {
    return this.#db.portfolio.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  async create(userId: string, name: string, baseCurrency = 'USD'): Promise<Portfolio> {
    return this.#db.portfolio.create({ data: { userId, name, baseCurrency } });
  }

  async remove(id: string): Promise<void> {
    await this.#db.portfolio.delete({ where: { id } });
  }

  async listHoldings(portfolioId: string): Promise<PortfolioHolding[]> {
    return this.#db.portfolioHolding.findMany({ where: { portfolioId } });
  }

  async upsertHolding(
    portfolioId: string,
    coinId: string,
    quantity: number,
    costBasis?: number | null,
  ): Promise<PortfolioHolding> {
    return this.#db.portfolioHolding.upsert({
      where: { portfolioId_coinId: { portfolioId, coinId } },
      create: { portfolioId, coinId, quantity, costBasis: costBasis ?? null },
      update: { quantity, costBasis: costBasis ?? null },
    });
  }

  async removeHolding(portfolioId: string, coinId: string): Promise<void> {
    await this.#db.portfolioHolding.deleteMany({ where: { portfolioId, coinId } });
  }
}

export class PrismaTagRepository implements TagRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async listForUser(userId: string): Promise<Tag[]> {
    return this.#db.tag.findMany({ where: { userId }, orderBy: { name: 'asc' } });
  }

  async create(userId: string, name: string, color?: string): Promise<Tag> {
    return this.#db.tag.upsert({
      where: { userId_name: { userId, name } },
      create: { userId, name, ...(color ? { color } : {}) },
      update: { ...(color ? { color } : {}) },
    });
  }

  async remove(id: string): Promise<void> {
    await this.#db.tag.delete({ where: { id } });
  }

  async assign(tagId: string, coinId: string): Promise<void> {
    await this.#db.coinTag.upsert({
      where: { tagId_coinId: { tagId, coinId } },
      create: { tagId, coinId },
      update: {},
    });
  }

  async unassign(tagId: string, coinId: string): Promise<void> {
    await this.#db.coinTag.deleteMany({ where: { tagId, coinId } });
  }

  /** Tags for many coins in one query, keyed by coin id. */
  async listCoinTags(coinIds: readonly string[]): Promise<Map<string, Tag[]>> {
    if (coinIds.length === 0) return new Map();
    const rows = await this.#db.coinTag.findMany({
      where: { coinId: { in: [...coinIds] } },
      include: { tag: true },
    });
    const out = new Map<string, Tag[]>();
    for (const row of rows) {
      const list = out.get(row.coinId) ?? [];
      list.push(row.tag);
      out.set(row.coinId, list);
    }
    return out;
  }
}
