import { describe, expect, it } from 'vitest';
import { parseFeed, stripHtml } from './feed-parser.js';

/**
 * Feed parsing is where real-world messiness lands, so these cases are drawn
 * from the shapes crypto feeds actually emit: RSS 2.0, Atom, RDF, CDATA-wrapped
 * HTML, `content:encoded`, missing dates and single-item arrays.
 */

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>CoinDesk</title>
    <item>
      <title><![CDATA[Binance lists Cronos (CRO) &amp; opens USDT pair]]></title>
      <link>https://www.coindesk.com/markets/binance-cro?utm_source=rss</link>
      <guid isPermaLink="false">abc-123</guid>
      <pubDate>Mon, 01 Jun 2026 12:00:00 GMT</pubDate>
      <dc:creator>Jane Reporter</dc:creator>
      <description><![CDATA[<p>Binance <b>announced</b> support for CRO spot trading.</p><img src="https://img.test/a.png"/>]]></description>
      <content:encoded><![CDATA[<p>Binance announced support for CRO spot trading. Deposits open immediately with trading enabled 24 hours later, according to the exchange.</p>]]></content:encoded>
      <category>Markets</category>
      <category>Exchanges</category>
    </item>
    <item>
      <title>Second story without a description</title>
      <link>https://www.coindesk.com/second</link>
      <pubDate>Mon, 01 Jun 2026 11:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Ethereum Foundation Blog</title>
  <entry>
    <title>Pectra upgrade timeline update</title>
    <id>tag:blog.ethereum.org,2026:/pectra</id>
    <link rel="edit" href="https://blog.ethereum.org/edit/pectra"/>
    <link rel="alternate" href="https://blog.ethereum.org/2026/06/01/pectra"/>
    <published>2026-06-01T09:30:00Z</published>
    <updated>2026-06-01T10:00:00Z</updated>
    <author><name>EF Team</name></author>
    <summary>Client teams have agreed a revised timeline.</summary>
    <category term="protocol"/>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel><title>Legacy Feed</title></channel>
  <item>
    <title>An RDF-format story</title>
    <link>https://legacy.test/story</link>
    <dc:date>2026-06-01T08:00:00Z</dc:date>
    <description>A short description.</description>
  </item>
</rdf:RDF>`;

describe('stripHtml', () => {
  it('removes tags and decodes entities', () => {
    expect(stripHtml('<p>Hello &amp; <b>welcome</b></p>')).toBe('Hello & welcome');
  });

  it('does not glue words together across block elements', () => {
    expect(stripHtml('<p>First</p><p>Second</p>')).toBe('First Second');
    expect(stripHtml('one<br/>two')).toBe('one two');
  });

  it('drops script and style content entirely', () => {
    expect(stripHtml('<script>evil()</script>text<style>.a{}</style>')).toBe('text');
  });

  it('decodes numeric entities and collapses whitespace', () => {
    expect(stripHtml('a &#8212;   b')).toBe('a — b');
  });

  it('handles plain text unchanged', () => {
    expect(stripHtml('just text')).toBe('just text');
  });
});

describe('parseFeed — RSS 2.0', () => {
  const feed = parseFeed(RSS);

  it('reads the channel title and all items', () => {
    expect(feed.title).toBe('CoinDesk');
    expect(feed.items).toHaveLength(2);
  });

  it('unwraps CDATA and decodes entities in the title', () => {
    expect(feed.items[0]?.title).toBe('Binance lists Cronos (CRO) & opens USDT pair');
  });

  it('keeps the link as published, leaving canonicalisation to dedupe', () => {
    expect(feed.items[0]?.link).toBe('https://www.coindesk.com/markets/binance-cro?utm_source=rss');
  });

  it('reads the guid as the external id', () => {
    expect(feed.items[0]?.externalId).toBe('abc-123');
  });

  it('parses an RFC 822 date', () => {
    expect(feed.items[0]?.publishedAt?.toISOString()).toBe('2026-06-01T12:00:00.000Z');
  });

  it('reads dc:creator as the author', () => {
    expect(feed.items[0]?.author).toBe('Jane Reporter');
  });

  it('strips HTML from the summary', () => {
    expect(feed.items[0]?.summary).toBe('Binance announced support for CRO spot trading.');
  });

  it('prefers content:encoded for the fuller body', () => {
    expect(feed.items[0]?.content).toContain('Deposits open immediately');
  });

  it('extracts an inline image', () => {
    expect(feed.items[0]?.imageUrl).toBe('https://img.test/a.png');
  });

  it('collects categories', () => {
    expect(feed.items[0]?.categories).toEqual(['Markets', 'Exchanges']);
  });

  it('handles an item with no description or categories', () => {
    const second = feed.items[1];
    expect(second?.title).toBe('Second story without a description');
    expect(second?.summary).toBeNull();
    expect(second?.categories).toEqual([]);
    expect(second?.imageUrl).toBeNull();
  });
});

describe('parseFeed — Atom', () => {
  const feed = parseFeed(ATOM);

  it('reads entries', () => {
    expect(feed.title).toBe('Ethereum Foundation Blog');
    expect(feed.items).toHaveLength(1);
  });

  it('prefers rel="alternate" over other links', () => {
    // Picking the edit link here would produce a broken timeline URL.
    expect(feed.items[0]?.link).toBe('https://blog.ethereum.org/2026/06/01/pectra');
  });

  it('prefers published over updated', () => {
    expect(feed.items[0]?.publishedAt?.toISOString()).toBe('2026-06-01T09:30:00.000Z');
  });

  it('reads a nested author name', () => {
    expect(feed.items[0]?.author).toBe('EF Team');
  });

  it('reads the id and a category term attribute', () => {
    expect(feed.items[0]?.externalId).toBe('tag:blog.ethereum.org,2026:/pectra');
    expect(feed.items[0]?.categories).toEqual(['protocol']);
  });
});

describe('parseFeed — RDF', () => {
  it('parses the legacy RDF shape', () => {
    const feed = parseFeed(RDF);
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]?.title).toBe('An RDF-format story');
    expect(feed.items[0]?.publishedAt?.toISOString()).toBe('2026-06-01T08:00:00.000Z');
  });
});

describe('parseFeed — resilience', () => {
  it('returns an empty result for malformed XML rather than throwing', () => {
    expect(parseFeed('<rss><channel><item><title>unclosed')).toEqual({
      title: null,
      items: expect.any(Array),
    });
    expect(() => parseFeed('not xml at all')).not.toThrow();
    expect(parseFeed('not xml at all').items).toEqual([]);
  });

  it('returns an empty result for an unrecognised document', () => {
    expect(parseFeed('<html><body>a web page</body></html>').items).toEqual([]);
  });

  it('handles an empty string', () => {
    expect(parseFeed('').items).toEqual([]);
  });

  it('skips items with no title', () => {
    const xml = `<rss><channel><item><link>https://a.test/x</link></item></channel></rss>`;
    expect(parseFeed(xml).items).toEqual([]);
  });

  it('reports a null date rather than an epoch date when none is present', () => {
    const xml = `<rss><channel><item><title>No date</title><link>https://a.test/y</link></item></channel></rss>`;
    expect(parseFeed(xml).items[0]?.publishedAt).toBeNull();
  });

  it('rejects an implausible date instead of accepting 1970', () => {
    const xml = `<rss><channel><item><title>Bad date</title><pubDate>not a date</pubDate></item></channel></rss>`;
    expect(parseFeed(xml).items[0]?.publishedAt).toBeNull();
  });

  it('normalises a single item into an array', () => {
    const xml = `<rss><channel><title>One</title><item><title>Only item</title></item></channel></rss>`;
    expect(parseFeed(xml).items).toHaveLength(1);
  });

  it('does not duplicate content when it merely repeats the summary', () => {
    const xml = `<rss><channel><item>
      <title>Same body</title>
      <description>Identical text.</description>
    </item></channel></rss>`;
    const item = parseFeed(xml).items[0];
    expect(item?.summary).toBe('Identical text.');
    // description was used for both; content adds nothing, so it is dropped.
    expect(item?.content).toBeNull();
  });
});
