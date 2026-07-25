import { describe, expect, it } from 'vitest';
import { UpstreamError } from '@cid/core';
import { FIXED_NOW, makeCoin, makeContext, makeRequest } from '../connector-fixtures.js';
import { GithubConnector } from './github.js';

/**
 * The GitHub connector's judgement calls are what these pin down: which activity
 * reaches the timeline (releases, not commits), how the request budget adapts to
 * whether a token is present, and how a repo's activity score is composed.
 */

const REPO = 'ethereum/go-ethereum';

const repoPayload = {
  full_name: REPO,
  stargazers_count: 47_800,
  forks_count: 20_100,
  open_issues_count: 312,
  subscribers_count: 2_100,
  watchers_count: 47_800,
  pushed_at: '2026-07-25T10:00:00.000Z',
};

function commit(overrides: Record<string, unknown> = {}) {
  return {
    sha: 'abc123',
    html_url: `https://github.com/${REPO}/commit/abc123`,
    commit: {
      message: 'core/vm: optimise the interpreter loop\n\nLong body text here.',
      author: { name: 'Alice Dev', date: '2026-07-25T09:00:00.000Z' },
    },
    author: { login: 'alicedev' },
    ...overrides,
  };
}

function release(overrides: Record<string, unknown> = {}) {
  return {
    id: 9001,
    tag_name: 'v1.15.0',
    name: 'Pectra support',
    body: 'Adds Pectra support.',
    html_url: `https://github.com/${REPO}/releases/tag/v1.15.0`,
    published_at: '2026-07-25T08:00:00.000Z',
    created_at: '2026-07-25T07:00:00.000Z',
    draft: false,
    prerelease: false,
    author: { login: 'releasebot' },
    ...overrides,
  };
}

const coin = makeCoin({ id: 'coin-eth', symbol: 'ETH', githubRepos: [REPO] });

function routes(
  overrides: {
    repo?: unknown;
    commits?: unknown;
    releases?: unknown;
  } = {},
) {
  return [
    { match: '/releases', body: overrides.releases ?? [] },
    { match: '/commits', body: overrides.commits ?? [] },
    // Least specific last: the bare repo URL is a prefix of the other two.
    { match: `/repos/${REPO}`, body: overrides.repo ?? repoPayload },
  ];
}

describe('GithubConnector', () => {
  const connector = new GithubConnector();

  it('runs keyless but reports itself degraded', () => {
    const { context } = makeContext();
    expect(connector.isEnabled(context)).toBe(true);
    expect(connector.isDegraded(context)).toBe(true);
    expect(connector.missingRequirements(context)).toEqual(['GITHUB_TOKEN']);
  });

  it('sends the API version header, and a bearer token only when configured', async () => {
    const keyless = makeContext(routes());
    await connector.collect(makeRequest([coin]), keyless.context);
    expect(keyless.http.requests[0]?.headers).toEqual({
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    });

    const keyed = makeContext(routes(), { GITHUB_TOKEN: 'ghp_x' });
    await connector.collect(makeRequest([coin]), keyed.context);
    expect(keyed.http.requests[0]?.headers).toMatchObject({ authorization: 'Bearer ghp_x' });
  });

  it('caps repos at 3 without a token and 20 with one', async () => {
    /*
     * Unauthenticated GitHub allows 60 requests per *hour* and this connector
     * makes three calls per repo. At a 60-second cadence, more than three repos
     * would exhaust the hourly budget within minutes and then fail everything.
     */
    const manyRepos = Array.from({ length: 30 }, (_, index) =>
      makeCoin({ id: `coin-${index}`, githubRepos: [`org/repo-${index}`] }),
    );

    const keyless = makeContext([
      { match: '/releases', body: [] },
      { match: '/commits', body: [] },
      { match: '/repos/', body: repoPayload },
    ]);
    await connector.collect(makeRequest(manyRepos), keyless.context);
    const keylessRepoCalls = new Set(
      keyless.http.urls.map((url) => url.split('/repos/')[1]?.split(/[/?]/).slice(0, 2).join('/')),
    );
    expect(keylessRepoCalls.size).toBe(3);

    const keyed = makeContext(
      [
        { match: '/releases', body: [] },
        { match: '/commits', body: [] },
        { match: '/repos/', body: repoPayload },
      ],
      { GITHUB_TOKEN: 'ghp_x' },
    );
    await connector.collect(makeRequest(manyRepos), keyed.context);
    const keyedRepoCalls = new Set(
      keyed.http.urls.map((url) => url.split('/repos/')[1]?.split(/[/?]/).slice(0, 2).join('/')),
    );
    expect(keyedRepoCalls.size).toBe(20);
  });

  it('promotes a release to a timeline event', async () => {
    const { context } = makeContext(routes({ releases: [release()] }));

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.events).toHaveLength(1);
    expect(result.value.events[0]).toMatchObject({
      occurredAt: new Date('2026-07-25T08:00:00.000Z'),
      sourceKey: 'github',
      coinId: 'coin-eth',
      category: 'DEVELOPMENT',
      subtype: 'GITHUB_RELEASE',
      headline: `${REPO} released v1.15.0: Pectra support`,
      url: `https://github.com/${REPO}/releases/tag/v1.15.0`,
      author: 'releasebot',
      importanceHint: 62,
    });
  });

  it('scores a prerelease lower than a stable release', async () => {
    const { context } = makeContext(
      routes({ releases: [release({ prerelease: true, tag_name: 'v1.15.0-rc1' })] }),
    );

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.events[0]?.importanceHint).toBe(45);
  });

  it('ignores drafts, which are not public events yet', async () => {
    const { context } = makeContext(routes({ releases: [release({ draft: true })] }));

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.events).toEqual([]);
  });

  it('falls back to the tag when a release has no name', async () => {
    const { context } = makeContext(routes({ releases: [release({ name: '   ' })] }));

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.events[0]?.headline).toBe(`${REPO} released v1.15.0: v1.15.0`);
  });

  it('falls back to created_at when a release was never published', async () => {
    const { context } = makeContext(routes({ releases: [release({ published_at: null })] }));

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.events[0]?.occurredAt).toEqual(new Date('2026-07-25T07:00:00.000Z'));
  });

  it('emits no event for a release older than the high-water mark', async () => {
    // Without this, every poll would re-announce every release in the last page.
    const { context } = makeContext(routes({ releases: [release()] }));

    const result = await connector.collect(
      makeRequest([coin], new Date('2026-07-25T09:00:00.000Z')),
      context,
    );

    if (!result.ok) throw new Error('expected success');
    expect(result.value.events).toEqual([]);
    // The activity row is skipped too — it was already written by the run that
    // first saw this release, so re-sending it every poll is pure waste.
    expect(result.value.records.githubActivity ?? []).toEqual([]);
    // It does still count toward the release cadence in the activity score.
    expect(result.value.records.githubSnapshots?.[0]?.activityScore as number).toBeGreaterThan(0);
  });

  it('records commits as activity but never as timeline events', async () => {
    /*
     * A repo doing 200 commits a month would bury every other kind of event.
     * Commits drive the activity chart and the dev score; releases are the
     * timeline-worthy signal.
     */
    const { context } = makeContext(routes({ commits: [commit(), commit({ sha: 'def456' })] }));

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.events).toEqual([]);
    const commitRows = result.value.records.githubActivity?.filter((row) => row.type === 'COMMIT');
    expect(commitRows).toHaveLength(2);
    expect(commitRows?.[0]).toMatchObject({
      repo: REPO,
      externalId: 'abc123',
      // First line only — a commit body would swamp the row.
      title: 'core/vm: optimise the interpreter loop',
      author: 'alicedev',
    });
  });

  it('attributes a commit to the committer name when there is no GitHub login', async () => {
    const { context } = makeContext(routes({ commits: [commit({ author: null })] }));

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.githubActivity?.[0]?.author).toBe('Alice Dev');
  });

  it('counts distinct contributors, not commits', async () => {
    const { context } = makeContext(
      routes({
        commits: [
          commit({ sha: '1', author: { login: 'alice' } }),
          commit({ sha: '2', author: { login: 'alice' } }),
          commit({ sha: '3', author: { login: 'bob' } }),
        ],
      }),
    );

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.githubSnapshots?.[0]).toMatchObject({
      commits30d: 3,
      contributors30d: 2,
    });
  });

  it('snapshots repo stats and produces an activity score', async () => {
    const { context } = makeContext(routes({ commits: [commit()], releases: [release()] }));

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    const snapshot = result.value.records.githubSnapshots?.[0];
    expect(snapshot).toMatchObject({
      sourceKey: 'github',
      coinId: 'coin-eth',
      repo: REPO,
      observedAt: FIXED_NOW,
      stars: 47_800,
      forks: 20_100,
      openIssues: 312,
      // subscribers_count is the real watcher count; watchers_count duplicates stars.
      watchers: 2_100,
    });
    expect(snapshot?.activityScore as number).toBeGreaterThan(0);
    expect(snapshot?.activityScore as number).toBeLessThanOrEqual(100);
  });

  it('requests only the last 30 days of commits', async () => {
    const { context, http } = makeContext(routes());

    await connector.collect(makeRequest([coin]), context);

    const commitsCall = http.requests.find((request) => request.url.includes('/commits'));
    expect(commitsCall?.query?.since).toBe(
      new Date(FIXED_NOW.getTime() - 30 * 86_400_000).toISOString(),
    );
    expect(commitsCall?.query?.per_page).toBe(100);
  });

  it('skips a repo whose metadata call fails, without failing the run', async () => {
    // A renamed or deleted repo in a coin's metadata must not stop the others.
    const { context } = makeContext([
      { match: '/repos/org/gone', error: new UpstreamError('github', 'not found', 404) },
      { match: '/releases', body: [release()] },
      { match: '/commits', body: [] },
      { match: '/repos/', body: repoPayload },
    ]);

    const result = await connector.collect(
      makeRequest([makeCoin({ id: 'coin-gone', githubRepos: ['org/gone'] }), coin]),
      context,
    );

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.githubSnapshots).toHaveLength(1);
    expect(result.value.records.githubSnapshots?.[0]?.coinId).toBe('coin-eth');
  });

  it('still snapshots the repo when commits and releases both fail', async () => {
    const { context } = makeContext([
      { match: '/commits', error: new UpstreamError('github', 'timeout') },
      { match: '/releases', error: new UpstreamError('github', 'timeout') },
      { match: `/repos/${REPO}`, body: repoPayload },
    ]);

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.githubSnapshots).toHaveLength(1);
    expect(result.value.records.githubSnapshots?.[0]?.commits30d).toBeNull();
  });

  it('does nothing for coins with no repos configured', async () => {
    const { context, http } = makeContext(routes());

    const result = await connector.collect(makeRequest([makeCoin()]), context);

    expect(result.ok).toBe(true);
    expect(http.requests).toHaveLength(0);
  });
});
