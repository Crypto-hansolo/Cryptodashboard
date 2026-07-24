import { describe, expect, it } from 'vitest';
import {
  canonicalizeUrl,
  clusterBatch,
  computeDedupeHash,
  deriveClusterId,
  findCluster,
  jaccardSimilarity,
  normalizeText,
  shingles,
  stem,
  textSimilarity,
  tokenize,
} from './dedupe.js';

describe('canonicalizeUrl', () => {
  it('strips tracking parameters', () => {
    expect(canonicalizeUrl('https://coindesk.com/a?utm_source=twitter&utm_campaign=x&id=5')).toBe(
      'https://coindesk.com/a?id=5',
    );
  });

  it('normalises host, scheme and trailing slash', () => {
    expect(canonicalizeUrl('http://WWW.CoinDesk.com/markets/')).toBe(
      'https://coindesk.com/markets',
    );
  });

  it('ignores fragments', () => {
    expect(canonicalizeUrl('https://a.com/b#section-2')).toBe('https://a.com/b');
  });

  it('treats parameter order as insignificant', () => {
    expect(canonicalizeUrl('https://a.com/b?y=2&x=1')).toBe(
      canonicalizeUrl('https://a.com/b?x=1&y=2'),
    );
  });

  it('returns unparseable input lowercased rather than throwing', () => {
    expect(canonicalizeUrl('not a url')).toBe('not a url');
    expect(canonicalizeUrl('')).toBe('');
  });

  it('leaves a bare origin intact', () => {
    expect(canonicalizeUrl('https://a.com/')).toBe('https://a.com/');
  });
});

describe('normalizeText and tokenize', () => {
  it('folds accents, case and punctuation', () => {
    expect(normalizeText('Café — Ethereum’s L2!')).toBe('cafe ethereum s l2');
  });

  it('removes URLs', () => {
    expect(normalizeText('read https://x.com/abc now')).toBe('read now');
  });

  it('drops stopwords and single characters by default', () => {
    expect(tokenize('The price of the token is up')).toEqual(['price', 'token', 'up']);
  });

  it('can keep stopwords when asked', () => {
    expect(tokenize('the token', false)).toEqual(['the', 'token']);
  });
});

describe('computeDedupeHash', () => {
  it('prefers the provider id, so headline edits do not create a duplicate', () => {
    const a = computeDedupeHash({ sourceKey: 'coindesk', externalId: 'abc', headline: 'One' });
    const b = computeDedupeHash({ sourceKey: 'coindesk', externalId: 'abc', headline: 'Two' });
    expect(a).toBe(b);
  });

  it('falls back to the canonical URL when there is no id', () => {
    const a = computeDedupeHash({
      sourceKey: 'x',
      url: 'https://a.com/p?utm_source=rss',
      headline: 'h',
    });
    const b = computeDedupeHash({ sourceKey: 'x', url: 'https://a.com/p', headline: 'h' });
    expect(a).toBe(b);
  });

  it('falls back to normalised content plus an hour bucket', () => {
    const at = new Date('2026-01-01T10:15:00Z');
    const later = new Date('2026-01-01T10:59:00Z');
    const nextHour = new Date('2026-01-01T11:05:00Z');
    const a = computeDedupeHash({ sourceKey: 'x', headline: 'Bitcoin rallies!', occurredAt: at });
    const b = computeDedupeHash({ sourceKey: 'x', headline: 'bitcoin rallies', occurredAt: later });
    const c = computeDedupeHash({
      sourceKey: 'x',
      headline: 'Bitcoin rallies!',
      occurredAt: nextHour,
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('scopes identity to the source', () => {
    const a = computeDedupeHash({ sourceKey: 'coindesk', externalId: '1', headline: 'h' });
    const b = computeDedupeHash({ sourceKey: 'theblock', externalId: '1', headline: 'h' });
    expect(a).not.toBe(b);
  });

  it('produces a stable 64-char hex digest', () => {
    expect(computeDedupeHash({ sourceKey: 's', headline: 'h' })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('stem', () => {
  it('collapses the morphological variants that headline rewording produces', () => {
    // These pairs are why clustering needs stemming at all.
    expect(stem('lists')).toBe(stem('list'));
    expect(stem('trading')).toBe(stem('trade'));
    expect(stem('halted')).toBe(stem('halts'));
    expect(stem('rallies')).toBe(stem('rally'));
    expect(stem('surges')).toBe(stem('surge'));
    expect(stem('delayed')).toBe(stem('delay'));
  });

  it('leaves short tokens and genuine double-s endings alone', () => {
    expect(stem('cro')).toBe('cro');
    expect(stem('com')).toBe('com');
    expect(stem('loss')).toBe('loss');
    expect(stem('analysis')).toBe('analysis');
  });

  it('keeps genuinely different words apart', () => {
    expect(stem('trading')).not.toBe(stem('market'));
    expect(stem('bitcoin')).not.toBe(stem('ethereum'));
  });

  it('is idempotent', () => {
    for (const word of ['lists', 'trading', 'rallies', 'binance', 'halted']) {
      expect(stem(stem(word))).toBe(stem(word));
    }
  });
});

describe('shingles and similarity', () => {
  it('produces word n-grams', () => {
    expect([...shingles('binance will list crypto com coin', 3)]).toContain('binance list crypto');
  });

  it('handles text shorter than the shingle size', () => {
    expect(shingles('bitcoin', 3).size).toBe(1);
  });

  it('scores identical sets as 1 and disjoint sets as 0', () => {
    expect(jaccardSimilarity(new Set(['a']), new Set(['a']))).toBe(1);
    expect(jaccardSimilarity(new Set(['a']), new Set(['b']))).toBe(0);
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
    expect(jaccardSimilarity(new Set(['a']), new Set())).toBe(0);
  });

  it('rates reworded coverage of the same story as similar', () => {
    const score = textSimilarity(
      'Binance will list Crypto.com Coin (CRO) for spot trading',
      'Binance lists Crypto.com Coin CRO in spot trading',
    );
    expect(score).toBeGreaterThan(0.5);
  });

  it('rates unrelated headlines as dissimilar', () => {
    const score = textSimilarity(
      'Binance will list Crypto.com Coin for spot trading',
      'Ethereum developers delay the Pectra hard fork again',
    );
    expect(score).toBeLessThan(0.2);
  });

  it('is symmetric', () => {
    const a = 'Solana network halts block production';
    const b = 'Solana block production halted after outage';
    expect(textSimilarity(a, b)).toBeCloseTo(textSimilarity(b, a), 10);
  });
});

describe('findCluster', () => {
  const base = new Date('2026-03-01T12:00:00Z');
  const candidate = {
    id: 'e1',
    headline: 'Binance lists Crypto.com Coin CRO for spot trading',
    url: 'https://coindesk.com/binance-cro',
    occurredAt: base,
    clusterId: 'cluster-1',
  };

  it('matches conclusively on an identical canonical URL', () => {
    const match = findCluster(
      {
        id: 'e2',
        headline: 'Totally different wording here entirely',
        url: 'https://coindesk.com/binance-cro?utm_source=rss',
        occurredAt: new Date(base.getTime() + 60_000),
      },
      [candidate],
    );
    expect(match).not.toBeNull();
    expect(match?.reason).toBe('url');
    expect(match?.clusterId).toBe('cluster-1');
  });

  it('matches reworded coverage on text similarity', () => {
    const match = findCluster(
      {
        id: 'e2',
        headline: 'Binance to list Crypto.com Coin (CRO) in spot trading',
        url: 'https://theblock.co/other',
        occurredAt: new Date(base.getTime() + 600_000),
      },
      [candidate],
    );
    expect(match?.reason).toBe('text');
    expect(match?.clusterId).toBe('cluster-1');
  });

  it('does not match the same headline months later', () => {
    const match = findCluster(
      {
        id: 'e2',
        headline: 'Binance lists Crypto.com Coin CRO for spot trading',
        url: 'https://other.com/x',
        occurredAt: new Date(base.getTime() + 90 * 86_400_000),
      },
      [candidate],
    );
    expect(match).toBeNull();
  });

  it('ignores itself', () => {
    expect(findCluster(candidate, [candidate])).toBeNull();
  });

  it('picks the best of several text matches', () => {
    const weak = {
      ...candidate,
      id: 'weak',
      headline: 'Binance news roundup',
      clusterId: 'c-weak',
      url: null,
    };
    const strong = { ...candidate, id: 'strong', clusterId: 'c-strong', url: null };
    const match = findCluster(
      {
        id: 'new',
        headline: 'Binance lists Crypto.com Coin CRO for spot trading',
        url: null,
        occurredAt: base,
      },
      [weak, strong],
    );
    expect(match?.clusterId).toBe('c-strong');
  });
});

describe('deriveClusterId', () => {
  it('is deterministic for the same content', () => {
    const item = { id: 'a', headline: 'H', url: 'https://a.com/x', occurredAt: new Date(0) };
    expect(deriveClusterId(item)).toBe(deriveClusterId({ ...item, id: 'b' }));
  });

  it('differs for different content', () => {
    const at = new Date(0);
    expect(deriveClusterId({ id: 'a', headline: 'One', url: null, occurredAt: at })).not.toBe(
      deriveClusterId({ id: 'b', headline: 'Two', url: null, occurredAt: at }),
    );
  });
});

describe('clusterBatch', () => {
  it('groups a story reported by several outlets into one cluster', () => {
    const at = new Date('2026-03-01T12:00:00Z');
    const items = [
      {
        id: 'a',
        headline: 'Binance lists Crypto.com Coin CRO for spot trading',
        url: null,
        occurredAt: at,
      },
      {
        id: 'b',
        headline: 'Binance to list Crypto.com Coin (CRO) in spot markets',
        url: null,
        occurredAt: new Date(at.getTime() + 300_000),
      },
      {
        id: 'c',
        headline: 'Ethereum Pectra upgrade delayed to next quarter',
        url: null,
        occurredAt: new Date(at.getTime() + 600_000),
      },
    ];

    const assignments = clusterBatch(items);
    expect(assignments.get('a')).toBe(assignments.get('b'));
    expect(assignments.get('c')).not.toBe(assignments.get('a'));
    expect(new Set(assignments.values()).size).toBe(2);
  });

  it('is idempotent', () => {
    const at = new Date('2026-03-01T12:00:00Z');
    const items = [
      { id: 'a', headline: 'One story about bitcoin', url: null, occurredAt: at },
      { id: 'b', headline: 'Another story about ethereum', url: null, occurredAt: at },
    ];
    expect([...clusterBatch(items)]).toEqual([...clusterBatch(items)]);
  });

  it('handles an empty batch', () => {
    expect(clusterBatch([]).size).toBe(0);
  });
});
