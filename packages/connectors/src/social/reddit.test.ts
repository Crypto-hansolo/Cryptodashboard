import { describe, expect, it } from 'vitest';
import { UpstreamError } from '@cid/core';
import { FIXED_NOW, makeCoin, makeContext, makeRequest } from '../connector-fixtures.js';
import { RedditConnector, type MentionBaselineLookup } from './reddit.js';

/**
 * The interesting behaviour here is aggregation, not fetching: which posts count
 * as signal, how sentiment is weighted, and how mention velocity is measured
 * against a trailing baseline. Those decide whether a social-velocity alert fires
 * on a genuine surge or on a moderator's pinned rules post.
 */

const coin = makeCoin({ id: 'coin-cro', symbol: 'CRO', subreddit: 'Crypto_com' });

/** Baseline stub: a fixed trailing history of hourly mention counts. */
function baselines(history: number[] = [10, 10, 10]): MentionBaselineLookup {
  return { mentionBaseline: async () => history };
}

function post(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: 't3_abc',
      title: 'CRO listed on Binance',
      selftext: 'Great news for the ecosystem.',
      author: 'someuser',
      // 10 minutes before the fixed clock, so inside the 60-minute window.
      created_utc: (FIXED_NOW.getTime() - 600_000) / 1000,
      score: 40,
      num_comments: 12,
      permalink: '/r/Crypto_com/comments/abc/cro_listed/',
      stickied: false,
      over_18: false,
      ...((overrides.data as Record<string, unknown>) ?? {}),
    },
  };
}

function listing(posts: ReturnType<typeof post>[]) {
  return { data: { children: posts } };
}

const route = (body: unknown) => [{ match: '/new.json', body }];

describe('RedditConnector', () => {
  const connector = new RedditConnector(baselines());

  it('runs keyless but reports itself degraded', () => {
    const { context } = makeContext();
    expect(connector.isEnabled(context)).toBe(true);
    expect(connector.missingRequirements(context)).toEqual(['REDDIT_CLIENT_ID']);
  });

  it('sends a user agent, because Reddit rejects the default outright', async () => {
    const { context, http } = makeContext(route(listing([])));

    await connector.collect(makeRequest([coin]), context);

    expect(http.lastRequest?.headers?.['user-agent']).toBe(
      'cid/1.0 (crypto-intelligence-dashboard)',
    );
    expect(http.lastRequest?.query).toEqual({ limit: 50, raw_json: 1 });
  });

  it('honours a configured user agent', async () => {
    const { context, http } = makeContext(route(listing([])), {
      REDDIT_USER_AGENT: 'my-app/2.0',
    });

    await connector.collect(makeRequest([coin]), context);

    expect(http.lastRequest?.headers?.['user-agent']).toBe('my-app/2.0');
  });

  it('URL-encodes the subreddit name', async () => {
    const { context, http } = makeContext(route(listing([])));

    await connector.collect(makeRequest([makeCoin({ subreddit: 'a b' })]), context);

    expect(http.lastRequest?.url).toContain('/r/a%20b/new.json');
  });

  it('records every usable post and aggregates the window', async () => {
    const { context } = makeContext(route(listing([post()])));

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.records.socialPosts?.[0]).toMatchObject({
      sourceKey: 'reddit',
      platform: 'REDDIT',
      externalId: 't3_abc',
      authorHandle: 'someuser',
      likes: 40,
      reposts: 0,
      replies: 12,
      url: 'https://www.reddit.com/r/Crypto_com/comments/abc/cro_listed/',
      coinIds: ['coin-cro'],
    });
    expect(result.value.records.socialMetrics?.[0]).toMatchObject({
      coinId: 'coin-cro',
      platform: 'REDDIT',
      observedAt: FIXED_NOW,
      windowMinutes: 60,
      mentions: 1,
      uniqueAuthors: 1,
    });
  });

  it('skips stickied and NSFW posts — moderator notices are not signal', async () => {
    const { context } = makeContext(
      route(
        listing([
          post({ data: { id: 'sticky', stickied: true } }),
          post({ data: { id: 'nsfw', over_18: true } }),
        ]),
      ),
    );

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.socialPosts ?? []).toEqual([]);
    expect(result.value.records.socialMetrics?.[0]?.mentions).toBe(0);
  });

  it('counts only posts inside the window toward mentions', async () => {
    /*
     * `/new.json` returns the last 50 posts regardless of age. Counting all of
     * them as "this hour" would make velocity meaningless on a quiet subreddit.
     */
    const old = post({
      data: { id: 'old', created_utc: (FIXED_NOW.getTime() - 5 * 3_600_000) / 1000 },
    });
    const { context } = makeContext(route(listing([post(), old])));

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    // Both are stored as posts...
    expect(result.value.records.socialPosts).toHaveLength(2);
    // ...but only the recent one is a mention in this window.
    expect(result.value.records.socialMetrics?.[0]?.mentions).toBe(1);
  });

  it('drops a post with an unusable timestamp', async () => {
    const { context } = makeContext(route(listing([post({ data: { created_utc: null } })])));

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.socialPosts ?? []).toEqual([]);
  });

  it('promotes only notable posts to the timeline', async () => {
    /*
     * A busy subreddit posts constantly. Without a notability floor the timeline
     * becomes a Reddit feed, which is the opposite of the point.
     */
    const quiet = post({ data: { id: 'quiet', score: 3, num_comments: 1 } });
    const loud = post({ data: { id: 'loud', score: 900, num_comments: 140 } });
    const { context } = makeContext(route(listing([quiet, loud])));

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.socialPosts).toHaveLength(2);
    expect(result.value.events).toHaveLength(1);
    expect(result.value.events[0]).toMatchObject({
      sourceKey: 'reddit',
      coinId: 'coin-cro',
      category: 'SOCIAL',
      subtype: 'REDDIT_POST',
      headline: 'CRO listed on Binance',
      author: 'someuser',
    });
  });

  it('does not re-announce a notable post already seen', async () => {
    const loud = post({ data: { score: 900, num_comments: 140 } });
    const { context } = makeContext(route(listing([loud])));

    const result = await connector.collect(
      makeRequest([coin], new Date(FIXED_NOW.getTime() - 60_000)),
      context,
    );

    if (!result.ok) throw new Error('expected success');
    expect(result.value.events).toEqual([]);
    // Still aggregated, so velocity is unaffected by the high-water mark.
    expect(result.value.records.socialMetrics?.[0]?.mentions).toBe(1);
  });

  it('treats a negative net score as zero likes', async () => {
    // Reddit reports a *net* score, which goes negative on a downvoted post.
    // Negative "likes" would corrupt the engagement calculation.
    const { context } = makeContext(route(listing([post({ data: { score: -25 } })])));

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.socialPosts?.[0]?.likes).toBe(0);
  });

  it('measures velocity against the trailing baseline', async () => {
    // Five mentions this hour against a baseline of one is a 5x surge, which is
    // what a social-velocity alert keys on.
    const posts = Array.from({ length: 5 }, (_, index) =>
      post({ data: { id: `p${index}`, author: `author${index}` } }),
    );
    const surging = new RedditConnector(baselines([1, 1, 1]));
    const { context } = makeContext(route(listing(posts)));

    const result = await surging.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    const metrics = result.value.records.socialMetrics?.[0];
    expect(metrics?.mentions).toBe(5);
    expect(metrics?.uniqueAuthors).toBe(5);
    expect(metrics?.velocity as number).toBeCloseTo(5, 5);
    expect(metrics?.trendingScore as number).toBeGreaterThan(0);
  });

  it('stores a non-finite velocity as null', async () => {
    /*
     * A baseline of zero makes the ratio Infinity, which is a meaningful state
     * ("first ever mentions") but not a storable double — Postgres rejects it.
     */
    const fromZero = new RedditConnector(baselines([0, 0, 0]));
    const { context } = makeContext(route(listing([post()])));

    const result = await fromZero.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.socialMetrics?.[0]?.velocity).toBeNull();
  });

  it('collects hashtags from titles and bodies', async () => {
    const { context } = makeContext(
      route(listing([post({ data: { title: 'CRO #Cronos pump', selftext: 'see #DeFi' } })])),
    );

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.socialMetrics?.[0]?.topHashtags).toEqual(
      expect.arrayContaining(['cronos', 'defi']),
    );
  });

  it('skips a subreddit whose fetch fails, without failing the run', async () => {
    const { context } = makeContext([
      { match: '/r/gone/', error: new UpstreamError('reddit', 'forbidden', 403) },
      { match: '/new.json', body: listing([post()]) },
    ]);

    const result = await connector.collect(
      makeRequest([makeCoin({ id: 'coin-gone', subreddit: 'gone' }), coin]),
      context,
    );

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.socialMetrics).toHaveLength(1);
    expect(result.value.records.socialMetrics?.[0]?.coinId).toBe('coin-cro');
  });

  it('skips a malformed listing', async () => {
    const { context } = makeContext(route({ data: { children: 'nope' } }));

    const result = await connector.collect(makeRequest([coin]), context);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.records.socialMetrics ?? []).toEqual([]);
  });

  it('caps fan-out at 10 subreddits per run', async () => {
    const coins = Array.from({ length: 25 }, (_, index) =>
      makeCoin({ id: `coin-${index}`, subreddit: `sub${index}` }),
    );
    const { context, http } = makeContext(route(listing([])));

    await connector.collect(makeRequest(coins), context);

    expect(http.requests).toHaveLength(10);
  });

  it('does nothing for coins with no subreddit', async () => {
    const { context, http } = makeContext(route(listing([])));

    const result = await connector.collect(
      makeRequest([makeCoin({ subreddit: null }), makeCoin({ subreddit: '' })]),
      context,
    );

    expect(result.ok).toBe(true);
    expect(http.requests).toHaveLength(0);
  });
});
