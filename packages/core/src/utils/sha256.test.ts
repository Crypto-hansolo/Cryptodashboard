import { describe, expect, it } from 'vitest';
import { sha256Hex, sha256Short } from './sha256.js';

/**
 * Known-answer tests from RFC 6234 / NIST FIPS 180-4. If this file passes, the
 * implementation is byte-compatible with `crypto.createHash('sha256')`.
 */
describe('sha256Hex', () => {
  it('hashes the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes a 56-byte input (the padding edge case)', () => {
    // 56 bytes forces padding into a second block.
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('hashes a multi-block input', () => {
    expect(
      sha256Hex(
        'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      ),
    ).toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
  });

  it('hashes one million "a" characters', () => {
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('handles multi-byte UTF-8 and astral-plane code points', () => {
    // Expected values cross-checked against crypto.createHash('sha256').
    expect(sha256Hex('héllo')).toBe(
      '3c48591d8d098a4538f5e013dfcf406e948eac4d3277b10bf614e295d6068179',
    );
    expect(sha256Hex('🚀 BTC')).toBe(
      '41ff0afab659b6b8e9fff6edae8bc98afb1cfcee6dbf09c378ad7e6353098464',
    );
    expect(sha256Hex('🚀 ETH')).toBe(
      'f2ff44083e65157e00ba257cfe9079d06ad6ae54c55066739745f5bf3e2d8106',
    );
  });

  it('replaces unpaired surrogates with U+FFFD, matching node:crypto', () => {
    // A lone high surrogate must hash identically to an explicit U+FFFD.
    expect(sha256Hex('a\ud800b')).toBe(sha256Hex('a�b'));
    // A well-formed pair must NOT be treated as two replacement characters.
    expect(sha256Hex('🚀')).not.toBe(sha256Hex('��'));
  });

  it('is stable and collision-free across similar inputs', () => {
    const a = sha256Hex('Binance lists CRO');
    const b = sha256Hex('Binance lists CROO');
    expect(a).not.toBe(b);
    expect(a).toBe(sha256Hex('Binance lists CRO'));
  });
});

describe('sha256Short', () => {
  it('truncates to the requested length', () => {
    expect(sha256Short('abc', 16)).toBe('ba7816bf8f01cfea');
    expect(sha256Short('abc')).toHaveLength(32);
  });
});
