import { XMLParser } from 'fast-xml-parser';
import { parseTimestamp } from '../sdk/base.js';

/**
 * RSS / Atom / RDF feed parsing.
 *
 * `fast-xml-parser` rather than `rss-parser`: rss-parser bundles its own HTTP
 * client, which would bypass the platform's rate limiter, caching and circuit
 * breaker entirely. Here XML parsing stays a pure function over a string that
 * the shared HTTP client fetched.
 *
 * Crypto feeds are a menagerie — RSS 2.0, Atom, RDF, CDATA-wrapped HTML,
 * `content:encoded`, missing dates, duplicate GUIDs — so this normalises
 * aggressively and skips items it cannot make sense of rather than emitting
 * half-populated rows.
 */

export interface FeedItem {
  /** Provider-supplied id (guid/id), when present. */
  externalId: string | null;
  title: string;
  link: string | null;
  author: string | null;
  publishedAt: Date | null;
  /** Plain-text summary with HTML stripped. */
  summary: string | null;
  /** Full content when the feed provides it. */
  content: string | null;
  imageUrl: string | null;
  categories: string[];
}

export interface ParsedFeed {
  title: string | null;
  items: FeedItem[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Feeds are wildly inconsistent about whether a single item is an array.
  isArray: (name) => ['item', 'entry', 'category', 'link', 'enclosure'].includes(name),
  trimValues: true,
  // CDATA is used constantly for HTML bodies; fold it into the text value.
  cdataPropName: '__cdata',
  parseTagValue: false,
  processEntities: true,
});

/** Read a node that may be a string, a `{ '#text': ... }` object, or CDATA. */
function text(node: unknown): string | null {
  if (node === null || node === undefined) return null;
  if (typeof node === 'string') return node.trim() || null;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) {
    for (const entry of node) {
      const value = text(entry);
      if (value) return value;
    }
    return null;
  }
  if (typeof node === 'object') {
    const record = node as Record<string, unknown>;
    return text(record.__cdata) ?? text(record['#text']) ?? null;
  }
  return null;
}

/**
 * Strip HTML to readable plain text.
 *
 * Feed summaries are full of markup, tracking pixels and "read more" anchors.
 * The AI enrichment prompt and the timeline both want prose, and passing raw
 * HTML to a local model wastes a large share of a small context window.
 */
export function stripHtml(html: string): string {
  return (
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      // Preserve paragraph breaks as spaces rather than gluing words together.
      .replace(/<\/(p|div|li|h[1-6]|br)>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;|&apos;/gi, "'")
      .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Extract the first image URL from an HTML fragment. */
function firstImage(html: string | null): string | null {
  if (!html) return null;
  const match = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  return match?.[1] ?? null;
}

/** Atom links are objects with rel/href; RSS links are plain text. */
function resolveLink(node: unknown): string | null {
  const direct = text(node);
  if (direct && /^https?:\/\//i.test(direct)) return direct;

  const candidates = Array.isArray(node) ? node : [node];
  // Prefer rel="alternate", which is the canonical article URL in Atom.
  for (const preferred of ['alternate', undefined]) {
    for (const candidate of candidates) {
      if (candidate === null || typeof candidate !== 'object') continue;
      const record = candidate as Record<string, unknown>;
      const rel = record['@_rel'];
      const href = record['@_href'];
      if (typeof href !== 'string') continue;
      if (preferred === undefined || rel === preferred || rel === undefined) return href;
    }
  }
  return null;
}

function collectCategories(node: unknown): string[] {
  const raw = Array.isArray(node) ? node : node === undefined ? [] : [node];
  const out = new Set<string>();
  for (const entry of raw) {
    if (entry && typeof entry === 'object') {
      const term = (entry as Record<string, unknown>)['@_term'];
      if (typeof term === 'string' && term.trim() !== '') {
        out.add(term.trim());
        continue;
      }
    }
    const value = text(entry);
    if (value) out.add(value);
  }
  return [...out].slice(0, 20);
}

/**
 * Parse a feed document. Returns an empty item list rather than throwing on
 * malformed XML — one broken feed must not fail a collector run covering twelve.
 */
export function parseFeed(xml: string): ParsedFeed {
  let document: Record<string, unknown>;
  try {
    document = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return { title: null, items: [] };
  }

  // RSS 2.0: rss > channel > item. Atom: feed > entry. RDF: rdf:RDF > item.
  const rss = document.rss as Record<string, unknown> | undefined;
  const channel = rss?.channel as Record<string, unknown> | undefined;
  const atom = document.feed as Record<string, unknown> | undefined;
  const rdf = (document['rdf:RDF'] ?? document.RDF) as Record<string, unknown> | undefined;

  const container = channel ?? atom ?? rdf;
  if (!container) return { title: null, items: [] };

  const rawItems = (container.item ?? container.entry ?? rdf?.item ?? []) as unknown[];
  const items = (Array.isArray(rawItems) ? rawItems : [rawItems]).flatMap((raw) => {
    if (raw === null || typeof raw !== 'object') return [];
    const record = raw as Record<string, unknown>;

    const title = text(record.title);
    // A feed item with no title is unusable on a timeline.
    if (!title) return [];

    const link = resolveLink(record.link) ?? text(record.guid) ?? null;

    // Content, in descending order of completeness.
    const contentHtml =
      text(record['content:encoded']) ??
      text(record.content) ??
      text(record['description']) ??
      null;
    const summaryHtml =
      text(record.description) ?? text(record.summary) ?? text(record['content:encoded']) ?? null;

    const published =
      parseTimestamp(text(record.pubDate)) ??
      parseTimestamp(text(record.published)) ??
      parseTimestamp(text(record.updated)) ??
      parseTimestamp(text(record['dc:date'])) ??
      null;

    const author =
      text(record['dc:creator']) ??
      text(record.author) ??
      text((record.author as Record<string, unknown> | undefined)?.name) ??
      null;

    const enclosureUrl = (() => {
      const enclosures = Array.isArray(record.enclosure) ? record.enclosure : [record.enclosure];
      for (const entry of enclosures) {
        if (entry && typeof entry === 'object') {
          const url = (entry as Record<string, unknown>)['@_url'];
          const type = (entry as Record<string, unknown>)['@_type'];
          if (typeof url === 'string' && (typeof type !== 'string' || type.startsWith('image'))) {
            return url;
          }
        }
      }
      return null;
    })();

    const mediaUrl = (() => {
      const media = (record['media:content'] ?? record['media:thumbnail']) as
        Record<string, unknown> | Array<Record<string, unknown>> | undefined;
      const entries = Array.isArray(media) ? media : media ? [media] : [];
      for (const entry of entries) {
        const url = entry['@_url'];
        if (typeof url === 'string') return url;
      }
      return null;
    })();

    const summary = summaryHtml ? stripHtml(summaryHtml).slice(0, 2_000) : null;
    const content = contentHtml ? stripHtml(contentHtml).slice(0, 20_000) : null;

    return [
      {
        externalId: text(record.guid) ?? text(record.id) ?? null,
        title: stripHtml(title),
        link,
        author: author ? stripHtml(author) : null,
        publishedAt: published,
        summary,
        // Only keep `content` when it adds something beyond the summary.
        content: content && summary && content.length <= summary.length ? null : content,
        // Check both bodies: many feeds put the lead image only in
        // `description` while `content:encoded` carries clean prose.
        imageUrl: enclosureUrl ?? mediaUrl ?? firstImage(contentHtml) ?? firstImage(summaryHtml),
        categories: collectCategories(record.category),
      },
    ];
  });

  return { title: text(container.title), items };
}
