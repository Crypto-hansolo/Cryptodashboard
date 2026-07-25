import type {
  CollectionRequest,
  ConnectorContext,
  ConnectorDescriptor,
  EventCategory,
  EventDraft,
  SourceKind,
} from '@cid/core';
import { classifyWithLexicon, matchCoins, primaryCoin, truncate } from '@cid/core';
import { BaseConnector, type CollectionBuilder } from '../sdk/base.js';
import { parseFeed } from './feed-parser.js';

/**
 * RSS/Atom news connector.
 *
 * One connector *class* handles every editorial feed, instantiated once per
 * outlet from {@link NEWS_FEEDS}. That keeps each outlet an independently
 * enable-able source with its own credibility weight, telemetry and circuit
 * breaker, without duplicating parsing logic thirteen times.
 *
 * Adding an outlet is one entry in the table below.
 */

export interface FeedDefinition {
  key: string;
  name: string;
  url: string;
  /** Editorial trust on [0,1]; feeds importance scoring. */
  credibility: number;
  sourceKind?: SourceKind;
  homepageUrl?: string;
  /** Default category when the content does not suggest a more specific one. */
  defaultCategory?: EventCategory;
}

/**
 * The editorial feed registry.
 *
 * Credibility reflects primary-source proximity and editorial standards, not
 * popularity: a wire service that publishes exchange announcements verbatim
 * outranks an aggregator that rewrites them for clicks.
 */
export const NEWS_FEEDS: readonly FeedDefinition[] = [
  {
    key: 'coindesk',
    name: 'CoinDesk',
    url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
    credibility: 0.85,
    homepageUrl: 'https://www.coindesk.com',
  },
  {
    key: 'cointelegraph',
    name: 'Cointelegraph',
    url: 'https://cointelegraph.com/rss',
    credibility: 0.7,
    homepageUrl: 'https://cointelegraph.com',
  },
  {
    key: 'theblock',
    name: 'The Block',
    url: 'https://www.theblock.co/rss.xml',
    credibility: 0.88,
    homepageUrl: 'https://www.theblock.co',
  },
  {
    key: 'decrypt',
    name: 'Decrypt',
    url: 'https://decrypt.co/feed',
    credibility: 0.75,
    homepageUrl: 'https://decrypt.co',
  },
  {
    key: 'bitcoinmagazine',
    name: 'Bitcoin Magazine',
    url: 'https://bitcoinmagazine.com/feed',
    credibility: 0.7,
    homepageUrl: 'https://bitcoinmagazine.com',
  },
  {
    key: 'cryptoslate',
    name: 'CryptoSlate',
    url: 'https://cryptoslate.com/feed/',
    credibility: 0.65,
    homepageUrl: 'https://cryptoslate.com',
  },
  {
    key: 'blockworks',
    name: 'Blockworks',
    url: 'https://blockworks.co/feed',
    credibility: 0.8,
    homepageUrl: 'https://blockworks.co',
  },
  {
    key: 'bankless',
    name: 'Bankless',
    url: 'https://www.bankless.com/rss/feed',
    credibility: 0.7,
    sourceKind: 'BLOG',
    homepageUrl: 'https://www.bankless.com',
  },
  {
    key: 'thedefiant',
    name: 'The Defiant',
    url: 'https://thedefiant.io/api/feed',
    credibility: 0.75,
    homepageUrl: 'https://thedefiant.io',
  },
  {
    key: 'protos',
    name: 'Protos',
    url: 'https://protos.com/feed/',
    credibility: 0.7,
    homepageUrl: 'https://protos.com',
  },
  {
    key: 'ethereum-blog',
    name: 'Ethereum Foundation Blog',
    url: 'https://blog.ethereum.org/feed.xml',
    credibility: 0.98,
    sourceKind: 'BLOG',
    homepageUrl: 'https://blog.ethereum.org',
    defaultCategory: 'DEVELOPMENT',
  },
  {
    key: 'solana-blog',
    name: 'Solana Blog',
    url: 'https://solana.com/news/rss.xml',
    credibility: 0.95,
    sourceKind: 'BLOG',
    homepageUrl: 'https://solana.com/news',
    defaultCategory: 'DEVELOPMENT',
  },
];

/**
 * Keyword-driven category refinement.
 *
 * Ordered most-specific first: a security incident mentioning a regulator is a
 * SECURITY event, not a REGULATORY one. This runs before the LLM and gives the
 * timeline a usable category immediately, and gives the enricher a prior.
 */
const CATEGORY_RULES: ReadonlyArray<{ category: EventCategory; patterns: readonly RegExp[] }> = [
  {
    category: 'SECURITY',
    patterns: [
      /\bhack(ed|er)?\b/i,
      /\bexploit(ed)?\b/i,
      /\bbreach\b/i,
      /\bdrain(ed)?\b/i,
      /\brug ?pull\b/i,
      /\bvulnerabilit/i,
      /\bstolen\b/i,
    ],
  },
  {
    category: 'REGULATORY',
    patterns: [
      /\bSEC\b/,
      /\bCFTC\b/,
      /\blawsuit\b/i,
      /\bsue[sd]?\b/i,
      /\bregulat/i,
      /\bsubpoena\b/i,
      /\bban(ned)?\b/i,
      /\bcourt\b/i,
      /\bsettlement\b/i,
    ],
  },
  {
    category: 'EXCHANGE_LISTING',
    patterns: [/\blist(s|ing|ed)\b/i, /\bdelist/i, /\btrading pair/i, /\bspot market/i],
  },
  {
    category: 'TOKENOMICS',
    patterns: [
      /\bunlock\b/i,
      /\bvesting\b/i,
      /\bburn(ed|s)?\b/i,
      /\bemission/i,
      /\bbuyback\b/i,
      /\bsupply\b/i,
      /\binflation\b/i,
    ],
  },
  {
    category: 'GOVERNANCE',
    patterns: [/\bproposal\b/i, /\bgovernance\b/i, /\bDAO\b/, /\bvot(e|ing)\b/i, /\bquorum\b/i],
  },
  {
    category: 'DEVELOPMENT',
    patterns: [
      /\bmainnet\b/i,
      /\btestnet\b/i,
      /\bupgrade\b/i,
      /\bhard fork\b/i,
      /\brelease\b/i,
      /\bdevnet\b/i,
      /\baudit\b/i,
    ],
  },
  {
    category: 'PARTNERSHIP',
    patterns: [
      /\bpartner(ship)?\b/i,
      /\bintegrat(e|ion)\b/i,
      /\bcollaborat/i,
      /\bacquisi/i,
      /\bteams? up\b/i,
    ],
  },
  {
    category: 'DERIVATIVES',
    patterns: [
      /\bfunding rate\b/i,
      /\bopen interest\b/i,
      /\bperpetual/i,
      /\bfutures\b/i,
      /\boptions\b/i,
    ],
  },
  { category: 'WHALE', patterns: [/\bwhale\b/i, /\blarge (transfer|holder)/i] },
  {
    category: 'MACRO',
    patterns: [/\bFed\b/, /\binflation data\b/i, /\bCPI\b/, /\binterest rate/i, /\bmacro\b/i],
  },
];

export function classifyCategory(text: string, fallback: EventCategory = 'NEWS'): EventCategory {
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) return rule.category;
  }
  return fallback;
}

/** Matchable coin projection, injected so the connector needs no repository. */
export interface CoinLookup {
  listMatchable(): Promise<Array<{ id: string; symbol: string; name: string; aliases: string[] }>>;
}

export class RssNewsConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor;
  readonly #feed: FeedDefinition;
  readonly #coins: CoinLookup;

  constructor(feed: FeedDefinition, coins: CoinLookup) {
    super();
    this.#feed = feed;
    this.#coins = coins;
    this.descriptor = {
      key: feed.key,
      name: feed.name,
      domain: 'news',
      sourceKind: feed.sourceKind ?? 'NEWS',
      homepageUrl: feed.homepageUrl ?? null,
      credibility: feed.credibility,
      requirements: [],
      defaultIntervalMs: 60_000,
      // Polite: one request per poll, and feeds rarely update faster than this.
      rateLimit: { requestsPerMinute: 10, burst: 3 },
      batchesCoins: true,
    };
  }

  protected async run(
    request: CollectionRequest,
    context: ConnectorContext,
    builder: CollectionBuilder,
  ): Promise<void> {
    const response = await context.http.getText(this.#feed.url, {
      cacheTtlSeconds: 45,
      // Feeds can be slow; allow more than the default budget.
      timeoutMs: 20_000,
    });
    if (!response.ok) throw response.error;

    const feed = parseFeed(response.value);
    builder.countFetched(feed.items.length);
    if (feed.items.length === 0) return;

    const matchable = await this.#coins.listMatchable();
    const now = context.clock.now();
    // High-water mark: only ingest what is newer than the last successful run.
    const since = request.since;

    const events: EventDraft[] = [];
    const articles: Array<Record<string, unknown>> = [];

    for (const item of feed.items) {
      // Items with no date are common in broken feeds. Treat "now" as the
      // occurrence time rather than dropping the item, but never let a missing
      // date bypass the high-water mark for items we have already seen — the
      // dedupe hash handles that.
      const occurredAt = item.publishedAt ?? now;
      if (since && item.publishedAt && item.publishedAt <= since) continue;

      // Ignore anything implausibly far in the future: some feeds emit
      // scheduled posts, and they would pin to the top of the timeline forever.
      if (occurredAt.getTime() > now.getTime() + 3_600_000) continue;

      const haystack = `${item.title} ${item.summary ?? ''}`;
      const matches = matchCoins(haystack, matchable);
      const primary = primaryCoin(matches);
      const category = classifyCategory(haystack, this.#feed.defaultCategory ?? 'NEWS');

      // Deterministic pre-scoring so the timeline is usable before the LLM runs.
      const lexicon = classifyWithLexicon(haystack);

      events.push({
        occurredAt,
        sourceKey: this.descriptor.key,
        coinId: primary?.coinId ?? null,
        category,
        subtype: 'ARTICLE',
        headline: truncate(item.title, 300),
        body: item.content ?? item.summary,
        url: item.link,
        author: item.author,
        relatedCoinIds: matches.filter((m) => m.coinId !== primary?.coinId).map((m) => m.coinId),
        sentimentHint: lexicon.confidence > 0 ? lexicon.score : null,
        payload: {
          externalId: item.externalId,
          categories: item.categories,
          imageUrl: item.imageUrl,
          feed: this.#feed.key,
        },
      });

      articles.push({
        sourceKey: this.descriptor.key,
        title: truncate(item.title, 300),
        author: item.author,
        publishedAt: occurredAt,
        url: item.link ?? '',
        excerpt: item.summary,
        content: item.content,
        imageUrl: item.imageUrl,
        language: 'en',
        tags: item.categories,
        coinIds: matches.map((m) => m.coinId),
      });
    }

    builder.addEvents(events);
    // NewsArticle rows need the eventId that ingestion assigns, so they are
    // carried alongside and linked by the ingestion service.
    builder.add('news', articles);
  }
}

/** Instantiate one connector per registered feed. */
export function createNewsConnectors(coins: CoinLookup): RssNewsConnector[] {
  return NEWS_FEEDS.map((feed) => new RssNewsConnector(feed, coins));
}
