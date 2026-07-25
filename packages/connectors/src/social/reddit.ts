import { z } from 'zod';
import type {
  CollectionRequest,
  ConnectorContext,
  ConnectorDescriptor,
  EventDraft,
} from '@cid/core';
import {
  aggregateSentiment,
  classifyWithLexicon,
  computeEngagement,
  computeTrendingScore,
  extractHashtags,
  truncate,
  velocityRatio,
} from '@cid/core';
import { BaseConnector, type CollectionBuilder, num, parseTimestamp } from '../sdk/base.js';

/**
 * Reddit connector.
 *
 * Reads the public `.json` endpoints, which work without credentials but are
 * aggressively rate limited — hence the conservative declared limit and the
 * required custom User-Agent (Reddit 429s the default one immediately).
 *
 * Posts are recorded individually *and* aggregated into a `SocialMetric` per
 * run, because the interesting question is rarely "what did one person say" but
 * "is chatter unusual right now", which needs the aggregate plus a baseline.
 */

const postSchema = z
  .object({
    data: z.object({
      id: z.string(),
      title: z.string(),
      selftext: z.string().nullish(),
      author: z.string().nullish(),
      permalink: z.string().nullish(),
      created_utc: z.number().nullish(),
      score: z.number().nullish(),
      num_comments: z.number().nullish(),
      upvote_ratio: z.number().nullish(),
      link_flair_text: z.string().nullish(),
      stickied: z.boolean().nullish(),
      over_18: z.boolean().nullish(),
    }),
  })
  .passthrough();

const listingSchema = z.object({
  data: z.object({ children: z.array(postSchema).default([]) }),
});

/** Baseline provider, injected so the connector needs no repository. */
export interface MentionBaselineLookup {
  mentionBaseline(input: {
    coinId: string;
    platform: 'REDDIT';
    windowMinutes: number;
    periods: number;
  }): Promise<number[]>;
}

const WINDOW_MINUTES = 60;

export class RedditConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    key: 'reddit',
    name: 'Reddit',
    domain: 'social',
    sourceKind: 'FORUM',
    homepageUrl: 'https://reddit.com',
    credibility: 0.4,
    requirements: [
      {
        envKey: 'REDDIT_CLIENT_ID',
        required: false,
        description:
          'Optional. Public .json endpoints work unauthenticated but are heavily throttled; an OAuth app raises the ceiling substantially.',
      },
    ],
    defaultIntervalMs: 60_000,
    // Reddit's unauthenticated guidance is ~1 req/s; stay well under.
    rateLimit: { requestsPerMinute: 20, burst: 5 },
    batchesCoins: false,
  };

  readonly #baselines: MentionBaselineLookup;

  constructor(baselines: MentionBaselineLookup) {
    super();
    this.#baselines = baselines;
  }

  protected async run(
    request: CollectionRequest,
    context: ConnectorContext,
    builder: CollectionBuilder,
  ): Promise<void> {
    const userAgent =
      this.config(context, 'REDDIT_USER_AGENT') ?? 'cid/1.0 (crypto-intelligence-dashboard)';

    const targets = request.coins
      .filter((coin) => coin.subreddit !== null && coin.subreddit !== '')
      .slice(0, 10);
    if (targets.length === 0) return;

    const now = context.clock.now();
    const events: EventDraft[] = [];
    const posts: Array<Record<string, unknown>> = [];
    const metrics: Array<Record<string, unknown>> = [];

    for (const coin of targets) {
      const subreddit = coin.subreddit!;
      const response = await context.http.getJson<unknown>(
        `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/new.json`,
        {
          query: { limit: 50, raw_json: 1 },
          // Reddit rejects the default UA outright.
          headers: { 'user-agent': userAgent },
          cacheTtlSeconds: 45,
        },
      );
      if (!response.ok) {
        context.logger.debug(
          { connector: this.descriptor.key, subreddit, err: response.error.message },
          'reddit fetch failed',
        );
        continue;
      }

      const parsed = listingSchema.safeParse(response.value);
      if (!parsed.success) continue;

      const children = parsed.data.data.children;
      builder.countFetched(children.length);

      const windowStart = now.getTime() - WINDOW_MINUTES * 60_000;
      const sentiments: Array<{ score: number; weight: number }> = [];
      const engagements: number[] = [];
      const authors = new Set<string>();
      const hashtags = new Set<string>();
      let mentionsInWindow = 0;

      for (const child of children) {
        const post = child.data;
        // Pinned mod posts and NSFW noise are not signal.
        if (post.stickied === true || post.over_18 === true) continue;

        const postedAt = parseTimestamp(post.created_utc);
        if (!postedAt) continue;

        const text = `${post.title} ${post.selftext ?? ''}`.trim();
        const score = num(post.score) ?? 0;
        const comments = num(post.num_comments) ?? 0;

        const engagement = computeEngagement({
          // Reddit reports net score, not raw upvotes; treat it as likes.
          likes: Math.max(score, 0),
          reposts: 0,
          replies: comments,
          followers: null,
          views: null,
        });

        const lexicon = classifyWithLexicon(text);

        if (postedAt.getTime() >= windowStart) {
          mentionsInWindow++;
          if (post.author) authors.add(post.author);
          for (const tag of extractHashtags(text)) hashtags.add(tag);
          engagements.push(engagement);
          if (lexicon.confidence > 0) {
            // Weight by engagement: a heavily-upvoted post reflects the
            // community's view more than a post nobody read.
            sentiments.push({ score: lexicon.score, weight: 0.2 + engagement });
          }
        }

        const url = post.permalink ? `https://www.reddit.com${post.permalink}` : null;

        // Only genuinely notable posts become timeline events; the rest are
        // recorded as social posts and folded into the aggregate. Without this
        // filter a busy subreddit drowns the timeline.
        const isNotable = engagement > 0.5 || comments >= 25 || score >= 250;
        if (isNotable && (!request.since || postedAt > request.since)) {
          events.push({
            occurredAt: postedAt,
            sourceKey: this.descriptor.key,
            coinId: coin.id,
            category: 'SOCIAL',
            subtype: 'REDDIT_POST',
            headline: truncate(post.title, 300),
            body: post.selftext ? truncate(post.selftext, 2_000) : null,
            url,
            author: post.author ?? null,
            sentimentHint: lexicon.confidence > 0 ? lexicon.score : null,
            payload: { externalId: post.id, subreddit, score, comments },
          });
        }

        posts.push({
          sourceKey: this.descriptor.key,
          platform: 'REDDIT' as const,
          externalId: post.id,
          authorId: null,
          authorHandle: post.author ?? null,
          postedAt,
          text: truncate(text, 4_000),
          url,
          likes: Math.max(score, 0),
          reposts: 0,
          replies: comments,
          views: null,
          engagementScore: engagement,
          hashtags: extractHashtags(text),
          coinIds: [coin.id],
        });
      }

      // ── Aggregate + velocity against the trailing baseline ──
      const baseline = await this.#baselines.mentionBaseline({
        coinId: coin.id,
        platform: 'REDDIT',
        windowMinutes: WINDOW_MINUTES,
        periods: 12,
      });
      const velocity = velocityRatio(mentionsInWindow, baseline);
      const meanEngagement =
        engagements.length > 0
          ? engagements.reduce((sum, value) => sum + value, 0) / engagements.length
          : null;

      metrics.push({
        coinId: coin.id,
        platform: 'REDDIT' as const,
        observedAt: now,
        windowMinutes: WINDOW_MINUTES,
        mentions: mentionsInWindow,
        uniqueAuthors: authors.size,
        totalEngagement: engagements.reduce((sum, value) => sum + value, 0),
        sentimentScore: aggregateSentiment(sentiments),
        // Infinity is a valid ratio (baseline of zero) but not a storable float.
        velocity: velocity !== null && Number.isFinite(velocity) ? velocity : null,
        trendingScore: computeTrendingScore({
          velocity,
          mentions: mentionsInWindow,
          uniqueAuthors: authors.size,
          meanEngagement,
        }),
        topHashtags: [...hashtags].slice(0, 10),
      });
    }

    builder.addEvents(events);
    builder.add('socialPosts', posts);
    builder.add('socialMetrics', metrics);
  }
}
