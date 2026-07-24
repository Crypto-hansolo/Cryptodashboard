import { describe, expect, it } from 'vitest';
import {
  inferChainFromAddress,
  isEvmAddress,
  isSolanaAddress,
  normalizeChain,
  parseIdentifier,
  slugify,
  truncateAddress,
} from './identifiers.js';

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('address recognition', () => {
  it('recognises EVM addresses', () => {
    expect(isEvmAddress(WETH)).toBe(true);
    expect(isEvmAddress('0x123')).toBe(false);
    expect(isEvmAddress(`${WETH}00`)).toBe(false);
  });

  it('recognises Solana addresses and rejects EVM/Tron lookalikes', () => {
    expect(isSolanaAddress(USDC_SOL)).toBe(true);
    expect(isSolanaAddress(WETH)).toBe(false);
    expect(isSolanaAddress('TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9')).toBe(false);
  });

  it('infers a chain from address shape', () => {
    expect(inferChainFromAddress(WETH)).toBe('ethereum');
    expect(inferChainFromAddress(USDC_SOL)).toBe('solana');
    expect(inferChainFromAddress('TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9')).toBe('tron');
    expect(inferChainFromAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe('bitcoin');
    expect(inferChainFromAddress('cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu')).toBe('cosmos');
    expect(inferChainFromAddress('osmo1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu')).toBe('osmosis');
    expect(inferChainFromAddress('hello')).toBeNull();
  });
});

describe('normalizeChain', () => {
  it('resolves common aliases', () => {
    expect(normalizeChain('eth')).toBe('ethereum');
    expect(normalizeChain('ERC20')).toBe('ethereum');
    expect(normalizeChain('bnb')).toBe('bsc');
    expect(normalizeChain('matic')).toBe('polygon');
    expect(normalizeChain('sol')).toBe('solana');
  });

  it('accepts canonical keys unchanged', () => {
    expect(normalizeChain('arbitrum')).toBe('arbitrum');
  });

  it('returns null for unknown chains', () => {
    expect(normalizeChain('notachain')).toBeNull();
  });
});

describe('parseIdentifier', () => {
  it('returns nothing for empty input', () => {
    expect(parseIdentifier('   ')).toEqual([]);
  });

  it('honours explicit provider namespaces', () => {
    expect(parseIdentifier('coingecko:crypto-com-chain')[0]).toMatchObject({
      kind: 'COINGECKO',
      value: 'crypto-com-chain',
      confidence: 1,
    });
    expect(parseIdentifier('cg:bitcoin')[0]?.kind).toBe('COINGECKO');
    expect(parseIdentifier('cmc:1')[0]).toMatchObject({ kind: 'COINMARKETCAP', value: '1' });
    expect(parseIdentifier('symbol:cro')[0]).toMatchObject({ kind: 'SYMBOL', value: 'CRO' });
    expect(parseIdentifier('slug:Foo-Bar')[0]).toMatchObject({ kind: 'SLUG', value: 'foo-bar' });
  });

  it('handles chain-qualified contracts', () => {
    const [candidate] = parseIdentifier(`base:${WETH}`);
    expect(candidate).toMatchObject({
      kind: 'CONTRACT',
      chain: 'base',
      value: WETH.toLowerCase(),
      confidence: 1,
    });
  });

  it('preserves base58 case for Solana mints', () => {
    const [candidate] = parseIdentifier(`solana:${USDC_SOL}`);
    expect(candidate).toMatchObject({ kind: 'CONTRACT', chain: 'solana', value: USDC_SOL });
  });

  it('ranks candidate chains for a bare EVM address', () => {
    const candidates = parseIdentifier(WETH);
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.every((c) => c.kind === 'CONTRACT')).toBe(true);
    expect(candidates[0]?.chain).toBe('ethereum');
    expect(candidates.every((c) => c.value === WETH.toLowerCase())).toBe(true);
    // Confidence must be strictly decreasing so callers can try in order.
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i]!.confidence).toBeLessThan(candidates[i - 1]!.confidence);
    }
  });

  it('treats a cashtag as an unambiguous ticker', () => {
    expect(parseIdentifier('$cro')).toEqual([
      { kind: 'SYMBOL', value: 'CRO', chain: null, confidence: 0.95 },
    ]);
  });

  it('ranks a short bare word as a ticker first, then slug', () => {
    const candidates = parseIdentifier('btc');
    expect(candidates[0]).toMatchObject({ kind: 'SYMBOL', value: 'BTC' });
    expect(candidates.map((c) => c.kind)).toContain('SLUG');
  });

  it('reads a hyphenated word as a CoinGecko id', () => {
    const candidates = parseIdentifier('crypto-com-chain');
    expect(candidates[0]).toMatchObject({ kind: 'COINGECKO', value: 'crypto-com-chain' });
  });

  it('slugifies multi-word names', () => {
    const candidates = parseIdentifier('Crypto.com Coin');
    expect(candidates[0]).toMatchObject({ kind: 'SLUG', value: 'crypto-com-coin' });
  });

  it('reads a long single word as a slug before a ticker', () => {
    const candidates = parseIdentifier('avalanche');
    expect(candidates[0]?.kind).toBe('SLUG');
  });
});

describe('slugify', () => {
  it('produces URL-safe keys', () => {
    expect(slugify('Crypto.com Coin')).toBe('crypto-com-coin');
    expect(slugify('  Böring  Náme!! ')).toBe('boring-name');
    expect(slugify('---')).toBe('');
  });
});

describe('truncateAddress', () => {
  it('shortens long addresses', () => {
    expect(truncateAddress(WETH)).toBe('0xC02a…6Cc2');
  });

  it('leaves short strings alone', () => {
    expect(truncateAddress('0x1234')).toBe('0x1234');
  });
});
