import type {
  ContentRepository,
  GithubActivity,
  GithubRepoSnapshot,
  GovernanceProposal,
  NewsArticle,
  OnchainEvent,
  OnchainMetric,
  SocialAuthor,
  SocialMetric,
  SocialPlatform,
  SocialPost,
  TokenUnlock,
  TokenomicsSnapshot,
  Wallet,
} from '@cid/core';
import type { Prisma } from '@prisma/client';
import type { Db } from '../client.js';
import { toOnchainEvent, toWallet } from '../mappers.js';
import type { PrismaSourceRepository } from './source-repository.js';

type WithSourceKey<T> = T & { sourceKey: string };

/**
 * News, social, on-chain, development, governance and tokenomics persistence.
 *
 * Grouped into one repository because these all share the same shape — a typed
 * record hanging off an `Event` — and splitting them into six classes would
 * multiply boilerplate without improving cohesion. The aggregate query methods
 * (whale flows, mention baselines, activity histograms) are the interesting part.
 */
export class PrismaContentRepository implements ContentRepository {
  readonly #db: Db;
  readonly #sources: PrismaSourceRepository;

  constructor(db: Db, sources: PrismaSourceRepository) {
    this.#db = db;
    this.#sources = sources;
  }

  async #withSourceIds<T extends { sourceKey: string }>(
    rows: readonly T[],
  ): Promise<Array<Omit<T, 'sourceKey'> & { sourceId: string }>> {
    if (rows.length === 0) return [];
    const ids = await this.#sources.resolveIds(rows.map((row) => row.sourceKey));
    return rows.flatMap((row) => {
      const sourceId = ids.get(row.sourceKey);
      if (!sourceId) return [];
      const { sourceKey: _sourceKey, ...rest } = row;
      return [{ ...rest, sourceId } as Omit<T, 'sourceKey'> & { sourceId: string }];
    });
  }

  // ─── News ──────────────────────────────────────────────────────────────────

  async insertNews(
    articles: readonly WithSourceKey<Omit<NewsArticle, 'id' | 'sourceId'>>[],
  ): Promise<number> {
    const data = await this.#withSourceIds(articles);
    if (data.length === 0) return 0;
    // eventId is unique, so skipDuplicates makes re-ingestion idempotent.
    const result = await this.#db.newsArticle.createMany({ data, skipDuplicates: true });
    return result.count;
  }

  async findNewsByEventIds(eventIds: readonly string[]): Promise<Map<string, NewsArticle>> {
    if (eventIds.length === 0) return new Map();
    const rows = await this.#db.newsArticle.findMany({ where: { eventId: { in: [...eventIds] } } });
    return new Map(rows.map((row) => [row.eventId, row]));
  }

  // ─── Social ────────────────────────────────────────────────────────────────

  async upsertSocialAuthor(
    author: Omit<SocialAuthor, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<SocialAuthor> {
    return this.#db.socialAuthor.upsert({
      where: { platform_externalId: { platform: author.platform, externalId: author.externalId } },
      create: author,
      update: {
        handle: author.handle,
        displayName: author.displayName,
        isVerified: author.isVerified,
        followers: author.followers,
        // Role is curated (a founder does not stop being one), so only ever
        // upgrade away from the default rather than overwrite a known value.
        ...(author.role !== 'ANONYMOUS' ? { role: author.role } : {}),
        affiliatedCoinIds: author.affiliatedCoinIds,
      },
    });
  }

  async findSocialAuthor(
    platform: SocialPlatform,
    externalId: string,
  ): Promise<SocialAuthor | null> {
    return this.#db.socialAuthor.findUnique({
      where: { platform_externalId: { platform, externalId } },
    });
  }

  async insertSocialPosts(
    posts: readonly WithSourceKey<Omit<SocialPost, 'id' | 'sourceId'>>[],
  ): Promise<number> {
    const data = await this.#withSourceIds(posts);
    if (data.length === 0) return 0;
    const result = await this.#db.socialPost.createMany({ data, skipDuplicates: true });
    return result.count;
  }

  async insertSocialMetrics(metrics: readonly Omit<SocialMetric, 'id'>[]): Promise<number> {
    if (metrics.length === 0) return 0;
    const result = await this.#db.socialMetric.createMany({ data: [...metrics] });
    return result.count;
  }

  async latestSocialMetric(coinId: string, platform: SocialPlatform): Promise<SocialMetric | null> {
    return this.#db.socialMetric.findFirst({
      where: { coinId, platform },
      orderBy: { observedAt: 'desc' },
    });
  }

  async socialMetricHistory(input: {
    coinId: string;
    platform?: SocialPlatform;
    from: Date;
    to: Date;
  }): Promise<SocialMetric[]> {
    return this.#db.socialMetric.findMany({
      where: {
        coinId: input.coinId,
        ...(input.platform ? { platform: input.platform } : {}),
        observedAt: { gte: input.from, lte: input.to },
      },
      orderBy: { observedAt: 'asc' },
    });
  }

  /**
   * Trailing mention counts per window, for velocity baselines.
   *
   * Returns the previous `periods` windows *excluding* the current one — the
   * baseline must not include the spike being measured against it, or a large
   * enough spike would partly cancel itself out.
   */
  async mentionBaseline(input: {
    coinId: string;
    platform: SocialPlatform;
    windowMinutes: number;
    periods: number;
  }): Promise<number[]> {
    const rows = await this.#db.socialMetric.findMany({
      where: {
        coinId: input.coinId,
        platform: input.platform,
        windowMinutes: input.windowMinutes,
      },
      orderBy: { observedAt: 'desc' },
      take: input.periods + 1,
      select: { mentions: true },
    });
    return rows.slice(1).map((row) => row.mentions);
  }

  // ─── On-chain ──────────────────────────────────────────────────────────────

  async upsertWallet(wallet: Omit<Wallet, 'id' | 'createdAt' | 'updatedAt'>): Promise<Wallet> {
    const row = await this.#db.wallet.upsert({
      where: { chain_address: { chain: wallet.chain, address: wallet.address.toLowerCase() } },
      create: { ...wallet, address: wallet.address.toLowerCase() },
      update: {
        // Never downgrade a known label back to UNKNOWN: one provider not
        // recognising an address does not unlabel it.
        ...(wallet.label !== 'UNKNOWN' ? { label: wallet.label } : {}),
        ...(wallet.entityName ? { entityName: wallet.entityName } : {}),
        coinIds: wallet.coinIds,
      },
    });
    return toWallet(row);
  }

  async findWallets(chain: string, addresses: readonly string[]): Promise<Map<string, Wallet>> {
    if (addresses.length === 0) return new Map();
    const rows = await this.#db.wallet.findMany({
      where: { chain, address: { in: addresses.map((address) => address.toLowerCase()) } },
    });
    return new Map(rows.map((row) => [row.address, toWallet(row)]));
  }

  async insertOnchainEvents(
    events: readonly WithSourceKey<Omit<OnchainEvent, 'id' | 'sourceId'>>[],
  ): Promise<number> {
    const data = await this.#withSourceIds(events);
    if (data.length === 0) return 0;
    const result = await this.#db.onchainEvent.createMany({
      data: data.map((event) => ({
        ...event,
        blockNumber: event.blockNumber === null ? null : BigInt(event.blockNumber),
        metadata: (event.metadata ?? {}) as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });
    return result.count;
  }

  async listOnchainEvents(input: {
    coinId: string;
    from: Date;
    to: Date;
    minUsd?: number;
    limit: number;
  }): Promise<OnchainEvent[]> {
    const rows = await this.#db.onchainEvent.findMany({
      where: {
        coinId: input.coinId,
        occurredAt: { gte: input.from, lte: input.to },
        ...(input.minUsd !== undefined ? { amountUsd: { gte: input.minUsd } } : {}),
      },
      orderBy: { occurredAt: 'desc' },
      take: input.limit,
    });
    return rows.map(toOnchainEvent);
  }

  /**
   * Exchange in/outflow totals per bucket.
   *
   * Direction is derived from the wallet labels rather than from the event type
   * alone, because a plain WHALE_TRANSFER into a labelled exchange wallet is an
   * inflow whether or not the provider classified it as one.
   */
  async whaleFlows(input: {
    coinId: string;
    from: Date;
    to: Date;
    bucketMinutes: number;
    minUsd: number;
  }): Promise<Array<{ bucket: Date; inflowUsd: number; outflowUsd: number; count: number }>> {
    const interval = `${Math.max(1, Math.floor(input.bucketMinutes))} minutes`;
    const rows = await this.#db.$queryRaw<
      Array<{ bucket: Date; inflow: number | null; outflow: number | null; count: bigint }>
    >`
      SELECT
        date_bin(${interval}::interval, "occurredAt", ${input.from}::timestamptz) AS bucket,
        sum(CASE
          WHEN type = 'EXCHANGE_INFLOW' OR "toLabel" = 'EXCHANGE' THEN "amountUsd"
          ELSE 0
        END) AS inflow,
        sum(CASE
          WHEN type = 'EXCHANGE_OUTFLOW' OR "fromLabel" = 'EXCHANGE' THEN "amountUsd"
          ELSE 0
        END) AS outflow,
        count(*) AS count
      FROM "OnchainEvent"
      WHERE "coinId" = ${input.coinId}
        AND "occurredAt" >= ${input.from} AND "occurredAt" <= ${input.to}
        AND "amountUsd" >= ${input.minUsd}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;
    return rows.map((row) => ({
      bucket: row.bucket,
      inflowUsd: Number(row.inflow ?? 0),
      outflowUsd: Number(row.outflow ?? 0),
      count: Number(row.count),
    }));
  }

  async insertOnchainMetrics(
    metrics: readonly WithSourceKey<Omit<OnchainMetric, 'id' | 'sourceId'>>[],
  ): Promise<number> {
    const data = await this.#withSourceIds(metrics);
    if (data.length === 0) return 0;
    const result = await this.#db.onchainMetric.createMany({ data, skipDuplicates: true });
    return result.count;
  }

  // ─── Development ───────────────────────────────────────────────────────────

  async insertGithubActivity(
    activity: readonly WithSourceKey<Omit<GithubActivity, 'id' | 'sourceId'>>[],
  ): Promise<number> {
    const data = await this.#withSourceIds(activity);
    if (data.length === 0) return 0;
    const result = await this.#db.githubActivity.createMany({ data, skipDuplicates: true });
    return result.count;
  }

  async insertGithubSnapshot(
    snapshot: WithSourceKey<Omit<GithubRepoSnapshot, 'id' | 'sourceId'>>,
  ): Promise<GithubRepoSnapshot> {
    const [data] = await this.#withSourceIds([snapshot]);
    if (!data) throw new Error(`Unknown source key "${snapshot.sourceKey}"`);
    return this.#db.githubRepoSnapshot.create({ data });
  }

  async latestGithubSnapshots(coinId: string): Promise<GithubRepoSnapshot[]> {
    return this.#db.$queryRaw<GithubRepoSnapshot[]>`
      SELECT DISTINCT ON (repo) *
      FROM "GithubRepoSnapshot"
      WHERE "coinId" = ${coinId}
      ORDER BY repo, "observedAt" DESC
    `;
  }

  async githubActivityHistory(input: {
    coinId: string;
    from: Date;
    to: Date;
    bucketMinutes: number;
  }): Promise<Array<{ bucket: Date; commits: number; releases: number; pullRequests: number }>> {
    const interval = `${Math.max(1, Math.floor(input.bucketMinutes))} minutes`;
    const rows = await this.#db.$queryRaw<
      Array<{ bucket: Date; commits: bigint; releases: bigint; pull_requests: bigint }>
    >`
      SELECT
        date_bin(${interval}::interval, "occurredAt", ${input.from}::timestamptz) AS bucket,
        count(*) FILTER (WHERE type = 'COMMIT') AS commits,
        count(*) FILTER (WHERE type = 'RELEASE') AS releases,
        count(*) FILTER (WHERE type = 'PULL_REQUEST') AS pull_requests
      FROM "GithubActivity"
      WHERE "coinId" = ${input.coinId}
        AND "occurredAt" >= ${input.from} AND "occurredAt" <= ${input.to}
      GROUP BY bucket
      ORDER BY bucket ASC
    `;
    return rows.map((row) => ({
      bucket: row.bucket,
      commits: Number(row.commits),
      releases: Number(row.releases),
      pullRequests: Number(row.pull_requests),
    }));
  }

  // ─── Governance ────────────────────────────────────────────────────────────

  /**
   * Upsert proposals, reporting which are new and which changed state.
   *
   * State transitions are the alertable moment ("proposal is now ACTIVE"), so
   * they are detected here rather than by diffing in the caller.
   */
  async upsertProposals(
    proposals: readonly WithSourceKey<Omit<GovernanceProposal, 'id' | 'sourceId'>>[],
  ): Promise<{ created: GovernanceProposal[]; stateChanged: GovernanceProposal[] }> {
    const data = await this.#withSourceIds(proposals);
    if (data.length === 0) return { created: [], stateChanged: [] };

    const existing = await this.#db.governanceProposal.findMany({
      where: { OR: data.map((p) => ({ space: p.space, externalId: p.externalId })) },
      select: { space: true, externalId: true, state: true },
    });
    const previousState = new Map<string, GovernanceProposal['state']>(
      existing.map((p) => [`${p.space}:${p.externalId}`, p.state]),
    );

    const created: GovernanceProposal[] = [];
    const stateChanged: GovernanceProposal[] = [];

    for (const proposal of data) {
      const key = `${proposal.space}:${proposal.externalId}`;
      const before = previousState.get(key);

      const row = await this.#db.governanceProposal.upsert({
        where: {
          space_externalId: { space: proposal.space, externalId: proposal.externalId },
        },
        create: proposal,
        update: {
          title: proposal.title,
          body: proposal.body,
          state: proposal.state,
          endsAt: proposal.endsAt,
          choices: proposal.choices,
          scores: proposal.scores,
          totalVotes: proposal.totalVotes,
          quorum: proposal.quorum,
        },
      });

      if (before === undefined) created.push(row);
      else if (before !== proposal.state) stateChanged.push(row);
    }

    return { created, stateChanged };
  }

  async listProposals(coinId: string, limit: number): Promise<GovernanceProposal[]> {
    return this.#db.governanceProposal.findMany({
      where: { coinId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  // ─── Tokenomics ────────────────────────────────────────────────────────────

  async upsertUnlocks(
    unlocks: readonly WithSourceKey<Omit<TokenUnlock, 'id' | 'sourceId'>>[],
  ): Promise<number> {
    const data = await this.#withSourceIds(unlocks);
    if (data.length === 0) return 0;

    let written = 0;
    for (const unlock of data) {
      await this.#db.tokenUnlock.upsert({
        where: {
          coinId_unlockAt_category: {
            coinId: unlock.coinId,
            unlockAt: unlock.unlockAt,
            // The unique constraint includes category; normalise null to a
            // sentinel so revisions to the same tranche update in place.
            category: unlock.category ?? '',
          },
        },
        create: { ...unlock, category: unlock.category ?? '' },
        update: {
          amount: unlock.amount,
          amountUsd: unlock.amountUsd,
          pctOfCirculating: unlock.pctOfCirculating,
          isCliff: unlock.isCliff,
          notes: unlock.notes,
        },
      });
      written++;
    }
    return written;
  }

  async listUpcomingUnlocks(input: {
    coinIds?: readonly string[];
    before: Date;
  }): Promise<TokenUnlock[]> {
    return this.#db.tokenUnlock.findMany({
      where: {
        unlockAt: { gte: new Date(), lte: input.before },
        ...(input.coinIds?.length ? { coinId: { in: [...input.coinIds] } } : {}),
      },
      orderBy: { unlockAt: 'asc' },
    });
  }

  async insertTokenomics(
    snapshots: readonly WithSourceKey<Omit<TokenomicsSnapshot, 'id' | 'sourceId'>>[],
  ): Promise<number> {
    const data = await this.#withSourceIds(snapshots);
    if (data.length === 0) return 0;
    const result = await this.#db.tokenomicsSnapshot.createMany({ data });
    return result.count;
  }

  async latestTokenomics(coinId: string): Promise<TokenomicsSnapshot | null> {
    return this.#db.tokenomicsSnapshot.findFirst({
      where: { coinId },
      orderBy: { observedAt: 'desc' },
    });
  }
}
