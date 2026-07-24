import { describe, expect, it } from 'vitest';
import {
  extractCashtags,
  extractHashtags,
  isAmbiguousSymbol,
  matchCoins,
  primaryCoin,
  type MatchableCoin,
} from './coin-matcher.js';

const COINS: MatchableCoin[] = [
  { id: 'btc', symbol: 'BTC', name: 'Bitcoin', aliases: ['btc'] },
  { id: 'eth', symbol: 'ETH', name: 'Ethereum', aliases: ['ether'] },
  { id: 'cro', symbol: 'CRO', name: 'Crypto.com Coin', aliases: ['cronos'] },
  { id: 'link', symbol: 'LINK', name: 'Chainlink' },
  { id: 'gas', symbol: 'GAS', name: 'Gas' },
  { id: 'time', symbol: 'TIME', name: 'Chrono Tech' },
];

describe('isAmbiguousSymbol', () => {
  it('flags English words and very short tickers', () => {
    expect(isAmbiguousSymbol('LINK')).toBe(true);
    expect(isAmbiguousSymbol('GAS')).toBe(true);
    expect(isAmbiguousSymbol('TIME')).toBe(true);
    expect(isAmbiguousSymbol('ID')).toBe(true);
    expect(isAmbiguousSymbol('OP')).toBe(true);
  });

  it('does not flag distinctive tickers', () => {
    expect(isAmbiguousSymbol('BTC')).toBe(false);
    expect(isAmbiguousSymbol('CRO')).toBe(false);
    expect(isAmbiguousSymbol('SOL')).toBe(true); // 'sol' is a listed ambiguous word
  });
});

describe('matchCoins', () => {
  it('returns nothing for empty input', () => {
    expect(matchCoins('', COINS)).toEqual([]);
    expect(matchCoins('anything', [])).toEqual([]);
  });

  it('matches a cashtag with maximum confidence', () => {
    const [match] = matchCoins('Loading up on $CRO today', COINS);
    expect(match).toMatchObject({ coinId: 'cro', via: 'cashtag', confidence: 1 });
  });

  it('matches a full name', () => {
    const matches = matchCoins('Bitcoin just cleared resistance', COINS);
    expect(matches[0]).toMatchObject({ coinId: 'btc', via: 'name' });
  });

  it('matches a name containing punctuation', () => {
    const matches = matchCoins('Crypto.com Coin gained on the listing news', COINS);
    expect(matches.some((m) => m.coinId === 'cro')).toBe(true);
  });

  it('matches an alias', () => {
    const matches = matchCoins('The cronos ecosystem keeps growing', COINS);
    expect(matches.find((m) => m.coinId === 'cro')?.via).toBe('alias');
  });

  it('matches a distinctive bare ticker in uppercase', () => {
    const matches = matchCoins('BTC dominance is rising', COINS);
    expect(matches.some((m) => m.coinId === 'btc')).toBe(true);
  });

  // The core false-positive guards.
  it('does NOT tag prose containing ambiguous tickers as lowercase words', () => {
    const matches = matchCoins(
      'Click the link to see how much gas this will take at the time of writing',
      COINS,
    );
    expect(matches).toEqual([]);
  });

  it('does NOT match an ambiguous ticker even in uppercase without a sigil', () => {
    // "GAS" in a headline about network fees must not tag the GAS token.
    const matches = matchCoins('ETHEREUM GAS FEES SPIKE', COINS);
    expect(matches.some((m) => m.coinId === 'gas')).toBe(false);
    expect(matches.some((m) => m.coinId === 'time')).toBe(false);
  });

  it('DOES match an ambiguous ticker when given an explicit cashtag', () => {
    const matches = matchCoins('$LINK looks strong here', COINS);
    expect(matches[0]).toMatchObject({ coinId: 'link', via: 'cashtag' });
  });

  it('matches an ambiguous ticker via its unambiguous name', () => {
    const matches = matchCoins('Chainlink announced a new oracle integration', COINS);
    expect(matches[0]?.coinId).toBe('link');
  });

  it('is case-sensitive for bare tickers to avoid prose collisions', () => {
    expect(matchCoins('btc is a currency', COINS).some((m) => m.via === 'symbol')).toBe(false);
  });

  it('ranks multiple coins by confidence', () => {
    const matches = matchCoins('$CRO surges while Ethereum lags', COINS);
    expect(matches[0]?.coinId).toBe('cro');
    expect(matches.map((m) => m.coinId)).toContain('eth');
  });

  it('keeps only the best match per coin', () => {
    const matches = matchCoins('$BTC Bitcoin BTC bitcoin', COINS);
    const btcMatches = matches.filter((m) => m.coinId === 'btc');
    expect(btcMatches).toHaveLength(1);
    expect(btcMatches[0]?.via).toBe('cashtag');
  });

  it('respects maxMatches', () => {
    expect(matchCoins('$BTC $ETH $CRO $LINK', COINS, { maxMatches: 2 })).toHaveLength(2);
  });

  it('respects minConfidence', () => {
    expect(matchCoins('BTC up', COINS, { minConfidence: 0.9 })).toEqual([]);
  });

  it('handles regex-special characters in coin names without throwing', () => {
    const tricky: MatchableCoin[] = [{ id: 'x', symbol: 'C++', name: 'C++ (token)' }];
    expect(() => matchCoins('talking about C++ (token) here', tricky)).not.toThrow();
    expect(matchCoins('talking about C++ (token) here', tricky).length).toBeGreaterThan(0);
  });
});

describe('primaryCoin', () => {
  it('returns null with no matches', () => {
    expect(primaryCoin([])).toBeNull();
  });

  it('returns the top match when it clears the bar', () => {
    const matches = matchCoins('$CRO listing confirmed', COINS);
    expect(primaryCoin(matches)?.coinId).toBe('cro');
  });

  it('refuses to guess below the confidence bar', () => {
    expect(
      primaryCoin([{ coinId: 'x', symbol: 'X', confidence: 0.5, via: 'symbol', index: 0 }]),
    ).toBeNull();
  });
});

describe('extractHashtags / extractCashtags', () => {
  it('extracts and normalises hashtags', () => {
    expect(extractHashtags('gm #Bitcoin #DeFi #bitcoin')).toEqual(['bitcoin', 'defi']);
  });

  it('extracts and normalises cashtags', () => {
    expect(extractCashtags('buying $btc and $ETH and $btc')).toEqual(['BTC', 'ETH']);
  });

  it('returns empty arrays when there are none', () => {
    expect(extractHashtags('plain text')).toEqual([]);
    expect(extractCashtags('plain text')).toEqual([]);
  });

  it('handles unicode hashtags', () => {
    expect(extractHashtags('#криптовалюта rising')).toEqual(['криптовалюта']);
  });
});
