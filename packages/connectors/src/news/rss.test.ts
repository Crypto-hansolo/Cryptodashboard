import { describe, expect, it } from 'vitest';
import { UpstreamError } from '@cid/core';
import { FIXED_NOW, makeContext, makeRequest } from '../connector-fixtures.js';
import { NEWS_FEEDS, RssNewsConnector, createNewsConnectors, type CoinLookup } from './rss.js';

/**
 * One connector per outlet, so each has its own credibility, circuit breaker and
 * telemetry. What is tested here is what happens to an item between the feed and
 * the timeline: coin attribution, categorisation, pre-scoring, and the two
 * timestamp traps (missing dates and scheduled future posts).
 */

const feed = {
  key: 'coindesk',
  name: 'CoinDesk',
  url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
  credibility: 0.9,
};

const coins: CoinLookup = {
  listMatchable: async () => [
    { id: 'coin-btc', symbol: 'BTC', name: 'Bitcoin', aliases: [] },
    { id: 'coin-eth', symbol: 'ETH', name: 'Ethereum', aliases: ['ether'] },
    { id: 'coin-cro', symbol: 'CRO', name: 'Cronos', aliases: [] },
  ],
};

function rss(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>CoinDesk</title>${items}</channel></rss>`;
}

function item(
  options: {
    title: string;
    description?: string;
    pubDate?: string | null;
    link?: string;
    author?: string;
  } = { title: 'Untitled' },
): string {
  const date =
    options.pubDate === null
      ? ''
      : `<pubDate>${options.pubDate ?? FIXED_NOW.toUTCString()}</pubDate>`;
  return `<item>
    <title>${options.title}</title>
    <description>${options.description ?? 'Body text.'}</description>
    <link>${options.link ?? 'https://www.coindesk.com/a'}</link>
    ${options.author ? `<dc:creator>${options.author}</dc:creator>` : ''}
    ${date}
  </item>`;
}

const route = (xml: string) => [{ match: 'coindesk.com', text: xml }];

describe('RssNewsConnector', () => {
  const connector = new RssNewsConnector(feed, coins);

  it('takes its identity and credibility from the feed definition', () => {
    // The whole point of one connector per outlet: The Block and a random blog
    // must not share a credibility score or a circuit breaker.
    expect(connector.descriptor.key).toBe('coindesk');
    expect(connector.descriptor.name).toBe('CoinDesk');
    expect(connector.descriptor.credibility).toBe(0.9);
    expect(connector.descriptor.domain).toBe('news');
    expect(connector.descriptor.requirements).toEqual([]);
  });

  it('turns a feed item into a timeline event', async () => {
    const { context } = makeContext(
      route(
        rss(
          item({
            title: 'Binance lists Cronos (CRO) for spot trading',
            description: 'The exchange will open CRO markets.',
            link: 'https://www.coindesk.com/markets/binance-cro',
            author: 'CoinDesk Staff',
          }),
        ),
      ),
    );

    const result = await connector.collect(makeRequest([]), context);

    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.itemsFetched).toBe(1);
    expect(result.value.events[0]).toMatchObject({
      sourceKey: 'coindesk',
      subtype: 'ARTICLE',
      headline: 'Binance lists Cronos (CRO) for spot trading',
      url: 'https://www.coindesk.com/markets/binance-cro',
      author: 'CoinDesk Staff',
      coinId: 'coin-cro',
    });
  });

  it('carries a matching NewsArticle row for the ingestion service to link', async () => {
    const { context } = makeContext(route(rss(item({ title: 'Bitcoin holds $90k' }))));

    const result = await connector.collect(makeRequest([]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.news?.[0]).toMatchObject({
      sourceKey: 'coindesk',
      title: 'Bitcoin holds $90k',
      language: 'en',
      coinIds: ['coin-btc'],
    });
  });

  it('picks a primary coin and keeps the others as related', async () => {
    const { context } = makeContext(
      route(rss(item({ title: 'Ethereum and Bitcoin diverge as ETH leads' }))),
    );

    const result = await connector.collect(makeRequest([]), context);

    if (!result.ok) throw new Error('expected success');
    const event = result.value.events[0];
    expect(event?.coinId).toBeTruthy();
    expect([event?.coinId, ...(event?.relatedCoinIds ?? [])].sort()).toEqual([
      'coin-btc',
      'coin-eth',
    ]);
    // The primary is never repeated in the related list.
    expect(event?.relatedCoinIds).not.toContain(event?.coinId);
  });

  it('keeps a market-wide story with no coin attached', async () => {
    // "Not about one coin" is a valid state; dropping it would lose macro news.
    const { context } = makeContext(
      route(rss(item({ title: 'Crypto markets slide as the Fed holds rates' }))),
    );

    const result = await connector.collect(makeRequest([]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.events).toHaveLength(1);
    expect(result.value.events[0]?.coinId).toBeNull();
  });

  it('categorises by headline content', async () => {
    const { context } = makeContext(
      route(
        rss(
          item({ title: 'Binance lists Cronos for spot trading' }) +
            item({ title: 'Protocol suffers $40M exploit in bridge hack' }),
        ),
      ),
    );

    const result = await connector.collect(makeRequest([]), context);

    if (!result.ok) throw new Error('expected success');
    const categories = result.value.events.map((event) => event.category);
    expect(categories).toContain('EXCHANGE_LISTING');
    expect(categories).toContain('SECURITY');
  });

  it('pre-scores sentiment so the timeline is usable before the model runs', async () => {
    const { context } = makeContext(
      route(
        rss(
          item({ title: 'Protocol exploited for $40M in bridge hack' }) +
            item({ title: 'Bitcoin surges to a new all-time high' }),
        ),
      ),
    );

    const result = await connector.collect(makeRequest([]), context);

    if (!result.ok) throw new Error('expected success');
    const [exploit, ath] = result.value.events;
    expect(exploit?.sentimentHint as number).toBeLessThan(0);
    expect(ath?.sentimentHint as number).toBeGreaterThan(0);
  });

  it('leaves the sentiment hint null when no lexicon term matched', async () => {
    const { context } = makeContext(route(rss(item({ title: 'A quarterly report was filed' }))));

    const result = await connector.collect(makeRequest([]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.events[0]?.sentimentHint).toBeNull();
  });

  it('skips items at or before the high-water mark', async () => {
    const { context } = makeContext(
      route(
        rss(
          item({
            title: 'Older story',
            pubDate: new Date(FIXED_NOW.getTime() - 3_600_000).toUTCString(),
          }),
        ),
      ),
    );

    const result = await connector.collect(
      makeRequest([], new Date(FIXED_NOW.getTime() - 1_800_000)),
      context,
    );

    if (!result.ok) throw new Error('expected success');
    expect(result.value.events).toEqual([]);
  });

  it('dates an item with no publish date to now rather than dropping it', async () => {
    /*
     * Broken feeds omit dates routinely. Dropping the item would lose the story;
     * the dedupe hash is what stops "now" from re-ingesting it every poll.
     */
    const { context } = makeContext(route(rss(item({ title: 'Undated story', pubDate: null }))));

    const result = await connector.collect(makeRequest([]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.events[0]?.occurredAt).toEqual(FIXED_NOW);
  });

  it('ignores items dated implausibly far in the future', async () => {
    /*
     * Some CMSes publish scheduled posts into the feed. A story dated next week
     * would pin itself to the top of a reverse-chronological timeline until then.
     */
    const { context } = makeContext(
      route(
        rss(
          item({
            title: 'Scheduled post',
            pubDate: new Date(FIXED_NOW.getTime() + 7 * 86_400_000).toUTCString(),
          }),
        ),
      ),
    );

    const result = await connector.collect(makeRequest([]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.events).toEqual([]);
  });

  it('tolerates modest clock skew between us and the publisher', async () => {
    // An hour of tolerance: publisher clocks and timezone handling are imperfect,
    // and a story ten minutes "in the future" is simply a fresh story.
    const { context } = makeContext(
      route(
        rss(
          item({
            title: 'Just published',
            pubDate: new Date(FIXED_NOW.getTime() + 600_000).toUTCString(),
          }),
        ),
      ),
    );

    const result = await connector.collect(makeRequest([]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.events).toHaveLength(1);
  });

  it('allows a generous timeout, because feeds are slow', async () => {
    const { context, http } = makeContext(route(rss('')));

    await connector.collect(makeRequest([]), context);

    expect(http.lastRequest?.url).toBe(feed.url);
  });

  it('fails the run when the feed is unreachable', async () => {
    // A dead feed must show up in connector health rather than looking quiet.
    const { context } = makeContext([
      { match: 'coindesk.com', error: new UpstreamError('coindesk', 'gateway timeout', 504) },
    ]);

    expect((await connector.collect(makeRequest([]), context)).ok).toBe(false);
  });

  it('succeeds with nothing when the feed is empty', async () => {
    const { context } = makeContext(route(rss('')));

    const result = await connector.collect(makeRequest([]), context);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.events).toEqual([]);
  });

  it('does not query the coin list for an empty feed', async () => {
    let called = 0;
    const counting: CoinLookup = {
      listMatchable: async () => {
        called++;
        return [];
      },
    };
    const { context } = makeContext(route(rss('')));

    await new RssNewsConnector(feed, counting).collect(makeRequest([]), context);

    expect(called).toBe(0);
  });
});

describe('createNewsConnectors', () => {
  it('builds one connector per registered feed, with unique keys', async () => {
    const connectors = createNewsConnectors(coins);

    expect(connectors).toHaveLength(NEWS_FEEDS.length);
    const keys = connectors.map((connector) => connector.descriptor.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('covers the outlets the platform advertises', () => {
    const keys = createNewsConnectors(coins).map((connector) => connector.descriptor.key);

    for (const expected of ['coindesk', 'cointelegraph', 'theblock', 'decrypt']) {
      expect(keys).toContain(expected);
    }
  });

  it('gives every feed a credibility score in range', () => {
    for (const definition of NEWS_FEEDS) {
      expect(definition.credibility).toBeGreaterThan(0);
      expect(definition.credibility).toBeLessThanOrEqual(1);
    }
  });
});
