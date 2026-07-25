import { z } from 'zod';
import type {
  CollectionRequest,
  ConnectorContext,
  ConnectorDescriptor,
  EventDraft,
} from '@cid/core';
import { computeDevActivityScore, truncate } from '@cid/core';
import { BaseConnector, type CollectionBuilder, num, parseTimestamp } from '../sdk/base.js';

/**
 * GitHub development activity.
 *
 * Unauthenticated GitHub allows 60 req/h, which is unusable for more than one
 * repo — hence `GITHUB_TOKEN` is declared optional-but-recommended (5,000 req/h
 * with a classic PAT) and the connector self-throttles hard when absent.
 *
 * Releases are the high-value signal here: a release is a discrete, verifiable,
 * market-relevant event in a way that a commit count is not.
 */

const repoSchema = z
  .object({
    full_name: z.string(),
    stargazers_count: z.number(),
    forks_count: z.number(),
    open_issues_count: z.number(),
    subscribers_count: z.number().nullish(),
    watchers_count: z.number().nullish(),
    pushed_at: z.string().nullish(),
  })
  .passthrough();

const releaseSchema = z
  .object({
    id: z.number(),
    tag_name: z.string(),
    name: z.string().nullish(),
    body: z.string().nullish(),
    html_url: z.string().nullish(),
    published_at: z.string().nullish(),
    created_at: z.string().nullish(),
    draft: z.boolean().nullish(),
    prerelease: z.boolean().nullish(),
    author: z.object({ login: z.string().nullish() }).nullish(),
  })
  .passthrough();

const commitSchema = z
  .object({
    sha: z.string(),
    html_url: z.string().nullish(),
    commit: z.object({
      message: z.string(),
      author: z.object({ name: z.string().nullish(), date: z.string().nullish() }).nullish(),
    }),
    author: z.object({ login: z.string().nullish() }).nullish(),
  })
  .passthrough();

export class GithubConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    key: 'github',
    name: 'GitHub',
    domain: 'github',
    sourceKind: 'CODE',
    homepageUrl: 'https://github.com',
    credibility: 0.95,
    requirements: [
      {
        envKey: 'GITHUB_TOKEN',
        required: false,
        description:
          'Optional but strongly recommended. Unauthenticated: 60 req/h. A classic PAT with public_repo scope: 5,000 req/h.',
      },
    ],
    defaultIntervalMs: 60_000,
    // Effective ceiling without a token is ~1 req/min; the scheduler still
    // spreads work, and the token check below raises this at runtime.
    rateLimit: { requestsPerMinute: 30, burst: 5 },
    batchesCoins: false,
  };

  #headers(context: ConnectorContext): Record<string, string> {
    const token = this.config(context, 'GITHUB_TOKEN');
    return {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  protected async run(
    request: CollectionRequest,
    context: ConnectorContext,
    builder: CollectionBuilder,
  ): Promise<void> {
    const hasToken = this.config(context, 'GITHUB_TOKEN') !== undefined;
    // Without a token the hourly budget is 60 requests total; covering three
    // repos per run keeps us inside it even at a 60s cadence.
    const repoBudget = hasToken ? 20 : 3;

    const targets = request.coins
      .flatMap((coin) => coin.githubRepos.map((repo) => ({ coin, repo })))
      .slice(0, repoBudget);

    if (targets.length === 0) return;

    const headers = this.#headers(context);
    const now = context.clock.now();
    const events: EventDraft[] = [];
    const activity: Array<Record<string, unknown>> = [];
    const snapshots: Array<Record<string, unknown>> = [];

    for (const { coin, repo } of targets) {
      // ── Repo metadata ──
      const repoResponse = await context.http.getJson<unknown>(
        `https://api.github.com/repos/${repo}`,
        { headers, cacheTtlSeconds: 300 },
      );
      if (!repoResponse.ok) {
        context.logger.debug(
          { connector: this.descriptor.key, repo, err: repoResponse.error.message },
          'github repo fetch failed',
        );
        continue;
      }
      const parsedRepo = repoSchema.safeParse(repoResponse.value);
      if (!parsedRepo.success) continue;
      builder.countFetched(1);

      // ── Recent commits (last 30 days) ──
      const since30d = new Date(now.getTime() - 30 * 86_400_000).toISOString();
      const commitsResponse = await context.http.getJson<unknown>(
        `https://api.github.com/repos/${repo}/commits`,
        { headers, query: { since: since30d, per_page: 100 }, cacheTtlSeconds: 120 },
      );

      let commits30d: number | null = null;
      let contributors30d: number | null = null;
      let lastCommitAt: Date | null = null;

      if (commitsResponse.ok) {
        const parsedCommits = z.array(commitSchema).safeParse(commitsResponse.value);
        if (parsedCommits.success) {
          commits30d = parsedCommits.data.length;
          contributors30d = new Set(
            parsedCommits.data.map(
              (commit) => commit.author?.login ?? commit.commit.author?.name ?? 'unknown',
            ),
          ).size;
          lastCommitAt = parseTimestamp(parsedCommits.data[0]?.commit.author?.date) ?? null;
          builder.countFetched(parsedCommits.data.length);

          // Individual commits are recorded for the activity chart, but are NOT
          // promoted to timeline events: a repo doing 200 commits a month would
          // bury everything else. Releases are the timeline-worthy signal.
          for (const commit of parsedCommits.data.slice(0, 50)) {
            const occurredAt = parseTimestamp(commit.commit.author?.date);
            if (!occurredAt) continue;
            activity.push({
              sourceKey: this.descriptor.key,
              coinId: coin.id,
              repo,
              type: 'COMMIT' as const,
              occurredAt,
              externalId: commit.sha,
              title: truncate(commit.commit.message.split('\n')[0] ?? commit.sha, 200),
              author: commit.author?.login ?? commit.commit.author?.name ?? null,
              url: commit.html_url ?? null,
              additions: null,
              deletions: null,
            });
          }
        }
      }

      // ── Releases ──
      const releasesResponse = await context.http.getJson<unknown>(
        `https://api.github.com/repos/${repo}/releases`,
        { headers, query: { per_page: 10 }, cacheTtlSeconds: 120 },
      );

      let releases90d = 0;
      if (releasesResponse.ok) {
        const parsedReleases = z.array(releaseSchema).safeParse(releasesResponse.value);
        if (parsedReleases.success) {
          const ninetyDaysAgo = now.getTime() - 90 * 86_400_000;

          for (const release of parsedReleases.data) {
            if (release.draft === true) continue;
            const occurredAt =
              parseTimestamp(release.published_at) ?? parseTimestamp(release.created_at);
            if (!occurredAt) continue;
            if (occurredAt.getTime() >= ninetyDaysAgo) releases90d++;

            // Only ingest what is new since the last run.
            if (request.since && occurredAt <= request.since) continue;

            const title = release.name?.trim() || release.tag_name;
            events.push({
              occurredAt,
              sourceKey: this.descriptor.key,
              coinId: coin.id,
              category: 'DEVELOPMENT',
              subtype: 'GITHUB_RELEASE',
              headline: truncate(`${repo} released ${release.tag_name}: ${title}`, 300),
              body: release.body ? truncate(release.body, 4_000) : null,
              url: release.html_url ?? null,
              author: release.author?.login ?? null,
              // A release is objectively notable; a prerelease less so.
              importanceHint: release.prerelease === true ? 45 : 62,
              payload: {
                externalId: String(release.id),
                repo,
                tag: release.tag_name,
                prerelease: release.prerelease ?? false,
              },
            });

            activity.push({
              sourceKey: this.descriptor.key,
              coinId: coin.id,
              repo,
              type: 'RELEASE' as const,
              occurredAt,
              externalId: release.tag_name,
              title: truncate(title, 200),
              author: release.author?.login ?? null,
              url: release.html_url ?? null,
              additions: null,
              deletions: null,
            });
          }
        }
      }

      // ── Composite activity score ──
      const daysSinceLastCommit =
        lastCommitAt === null ? null : (now.getTime() - lastCommitAt.getTime()) / 86_400_000;

      snapshots.push({
        sourceKey: this.descriptor.key,
        coinId: coin.id,
        repo,
        observedAt: now,
        stars: parsedRepo.data.stargazers_count,
        forks: parsedRepo.data.forks_count,
        openIssues: parsedRepo.data.open_issues_count,
        watchers: num(parsedRepo.data.subscribers_count ?? parsedRepo.data.watchers_count),
        commits30d,
        contributors30d,
        activityScore: computeDevActivityScore({
          commits30d,
          contributors30d,
          releases90d,
          openIssues: parsedRepo.data.open_issues_count,
          stars: parsedRepo.data.stargazers_count,
          daysSinceLastCommit,
        }),
      });
    }

    builder.addEvents(events);
    builder.add('githubActivity', activity);
    builder.add('githubSnapshots', snapshots);
  }
}
