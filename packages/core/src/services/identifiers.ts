import {
  ADDRESS_FORMAT_BY_CHAIN,
  CHAINS,
  type Chain,
  type IdentifierKind,
} from '../domain/enums.js';

/**
 * Turning whatever a user typed into something we can look up.
 *
 * The search box accepts "btc", "bitcoin", "0xc02aaa...", "EPjFWdd5...",
 * "ethereum:0xabc", "coingecko:crypto-com-chain". Rather than guessing a single
 * interpretation, this returns *ranked candidates* and lets the repository try
 * them in order — the only approach that copes with genuinely ambiguous input
 * (there are several tokens whose symbol is "APE").
 */

export interface IdentifierCandidate {
  kind: IdentifierKind;
  value: string;
  chain: Chain | null;
  /** Higher is a more confident interpretation. */
  confidence: number;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Base58, 32-44 chars, no 0/O/I/l. Solana account addresses. */
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** bech32: hrp + '1' + data. Cosmos-family accounts and BTC segwit. */
const BECH32_ADDRESS = /^[a-z]{2,10}1[02-9ac-hj-np-z]{20,90}$/;
/** Legacy Bitcoin P2PKH/P2SH. */
const BTC_LEGACY_ADDRESS = /^[13][a-km-zA-HJ-NP-Z1-9]{25,39}$/;
/** Tron base58 addresses always start with T. */
const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

/** Chain prefixes users actually type, mapped to canonical chain keys. */
const CHAIN_ALIASES: Readonly<Record<string, Chain>> = Object.freeze({
  eth: 'ethereum',
  ethereum: 'ethereum',
  mainnet: 'ethereum',
  erc20: 'ethereum',
  arb: 'arbitrum',
  arbitrum: 'arbitrum',
  op: 'optimism',
  optimism: 'optimism',
  base: 'base',
  matic: 'polygon',
  polygon: 'polygon',
  bsc: 'bsc',
  bnb: 'bsc',
  bep20: 'bsc',
  avax: 'avalanche',
  avalanche: 'avalanche',
  sol: 'solana',
  solana: 'solana',
  spl: 'solana',
  btc: 'bitcoin',
  bitcoin: 'bitcoin',
  atom: 'cosmos',
  cosmos: 'cosmos',
  osmo: 'osmosis',
  osmosis: 'osmosis',
  tia: 'celestia',
  celestia: 'celestia',
  inj: 'injective',
  injective: 'injective',
  sei: 'sei',
  cro: 'cronos',
  cronos: 'cronos',
  ton: 'ton',
  tron: 'tron',
  trx: 'tron',
  near: 'near',
  apt: 'aptos',
  aptos: 'aptos',
  sui: 'sui',
});

/** bech32 human-readable prefixes -> chain. */
const BECH32_HRP: Readonly<Record<string, Chain>> = Object.freeze({
  cosmos: 'cosmos',
  osmo: 'osmosis',
  celestia: 'celestia',
  inj: 'injective',
  sei: 'sei',
  bc: 'bitcoin',
  ltc: 'litecoin',
  addr: 'cardano',
});

export function normalizeChain(input: string): Chain | null {
  const key = input.trim().toLowerCase();
  if (CHAIN_ALIASES[key]) return CHAIN_ALIASES[key]!;
  return (CHAINS as readonly string[]).includes(key) ? (key as Chain) : null;
}

/** True for a syntactically valid EVM address (checksum not verified). */
export function isEvmAddress(value: string): boolean {
  return EVM_ADDRESS.test(value.trim());
}

export function isSolanaAddress(value: string): boolean {
  const v = value.trim();
  // Exclude EVM-looking strings and Tron addresses, which also pass base58.
  return !v.startsWith('0x') && !TRON_ADDRESS.test(v) && SOLANA_ADDRESS.test(v);
}

/** Best-effort chain inference from an address's shape alone. */
export function inferChainFromAddress(address: string): Chain | null {
  const value = address.trim();
  if (EVM_ADDRESS.test(value)) return 'ethereum'; // Ambiguous across all EVM chains.
  if (TRON_ADDRESS.test(value)) return 'tron';
  if (BTC_LEGACY_ADDRESS.test(value)) return 'bitcoin';
  if (BECH32_ADDRESS.test(value)) {
    const hrp = value.slice(0, value.indexOf('1'));
    return BECH32_HRP[hrp] ?? null;
  }
  if (SOLANA_ADDRESS.test(value)) return 'solana';
  return null;
}

/**
 * Parse arbitrary user input into ranked identifier candidates.
 *
 * Recognised forms:
 *   `coingecko:bitcoin`     explicit provider namespace
 *   `cmc:1`                 CoinMarketCap numeric id
 *   `ethereum:0xabc…`       chain-qualified contract
 *   `0xabc…`                bare EVM contract (chain ambiguous -> all EVM chains)
 *   `EPjFWdd5…`             bare Solana mint
 *   `$BTC` / `btc`          ticker symbol
 *   `crypto-com-chain`      slug
 *   `Bitcoin`               name / free text
 */
export function parseIdentifier(raw: string): IdentifierCandidate[] {
  const input = raw.trim();
  if (input === '') return [];

  const candidates: IdentifierCandidate[] = [];

  // ── Explicit namespace: `prefix:value` ──
  const colonIndex = input.indexOf(':');
  if (colonIndex > 0) {
    const prefix = input.slice(0, colonIndex).trim().toLowerCase();
    const value = input.slice(colonIndex + 1).trim();

    if (value !== '') {
      if (prefix === 'coingecko' || prefix === 'cg') {
        return [{ kind: 'COINGECKO', value: value.toLowerCase(), chain: null, confidence: 1 }];
      }
      if (prefix === 'cmc' || prefix === 'coinmarketcap') {
        return [{ kind: 'COINMARKETCAP', value, chain: null, confidence: 1 }];
      }
      if (prefix === 'symbol' || prefix === 'ticker') {
        return [{ kind: 'SYMBOL', value: value.toUpperCase(), chain: null, confidence: 1 }];
      }
      if (prefix === 'slug') {
        return [{ kind: 'SLUG', value: value.toLowerCase(), chain: null, confidence: 1 }];
      }

      const chain = normalizeChain(prefix);
      if (chain) {
        // `chain:address` -> contract; `chain:` alone -> the chain's native asset.
        const format = ADDRESS_FORMAT_BY_CHAIN[chain];
        const looksLikeAddress =
          (format === 'evm' && isEvmAddress(value)) ||
          (format === 'base58' && isSolanaAddress(value)) ||
          (format === 'bech32' && BECH32_ADDRESS.test(value)) ||
          inferChainFromAddress(value) !== null;
        return [
          {
            kind: looksLikeAddress ? 'CONTRACT' : 'SYMBOL',
            value: looksLikeAddress ? normalizeAddress(value, chain) : value.toUpperCase(),
            chain,
            confidence: looksLikeAddress ? 1 : 0.6,
          },
        ];
      }
    }
  }

  // ── Bare addresses ──
  if (isEvmAddress(input)) {
    const address = input.toLowerCase();
    // Chain genuinely unknown: the same address is often deployed on several
    // EVM chains. Rank Ethereum first, then the highest-volume L2s/alt-L1s.
    const ranked: Chain[] = ['ethereum', 'base', 'arbitrum', 'bsc', 'polygon', 'optimism'];
    ranked.forEach((chain, index) => {
      candidates.push({
        kind: 'CONTRACT',
        value: address,
        chain,
        confidence: 0.95 - index * 0.05,
      });
    });
    return candidates;
  }

  const inferred = inferChainFromAddress(input);
  if (inferred && input.length >= 26) {
    return [
      {
        kind: 'CONTRACT',
        value: normalizeAddress(input, inferred),
        chain: inferred,
        confidence: 0.9,
      },
    ];
  }

  // ── Ticker with a `$` sigil: unambiguous intent ──
  if (input.startsWith('$') && input.length > 1) {
    return [{ kind: 'SYMBOL', value: input.slice(1).toUpperCase(), chain: null, confidence: 0.95 }];
  }

  // ── Bare word(s) ──
  const isSingleWord = !/\s/.test(input);
  if (isSingleWord) {
    // Short all-alphanumeric strings are overwhelmingly tickers.
    if (/^[a-zA-Z0-9]{2,6}$/.test(input)) {
      candidates.push({ kind: 'SYMBOL', value: input.toUpperCase(), chain: null, confidence: 0.8 });
      candidates.push({ kind: 'SLUG', value: input.toLowerCase(), chain: null, confidence: 0.5 });
      candidates.push({
        kind: 'COINGECKO',
        value: input.toLowerCase(),
        chain: null,
        confidence: 0.4,
      });
      return candidates;
    }
    // Hyphenated lowercase is the CoinGecko id convention.
    if (input.includes('-')) {
      candidates.push({
        kind: 'COINGECKO',
        value: input.toLowerCase(),
        chain: null,
        confidence: 0.8,
      });
      candidates.push({ kind: 'SLUG', value: input.toLowerCase(), chain: null, confidence: 0.75 });
      return candidates;
    }
    candidates.push({ kind: 'SLUG', value: input.toLowerCase(), chain: null, confidence: 0.6 });
    candidates.push({ kind: 'SYMBOL', value: input.toUpperCase(), chain: null, confidence: 0.4 });
    return candidates;
  }

  // Multi-word: a name. Slugify for lookup.
  candidates.push({ kind: 'SLUG', value: slugify(input), chain: null, confidence: 0.6 });
  candidates.push({ kind: 'COINGECKO', value: slugify(input), chain: null, confidence: 0.4 });
  return candidates;
}

/** Lowercase EVM/bech32 addresses; leave case-sensitive base58 untouched. */
export function normalizeAddress(address: string, chain: Chain): string {
  const value = address.trim();
  const format = ADDRESS_FORMAT_BY_CHAIN[chain];
  return format === 'base58' ? value : value.toLowerCase();
}

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Shorten an address for display: `0x1234…abcd`.
 * Uses U+2026 rather than "..." so it stays one character wide in the terminal UI.
 */
export function truncateAddress(address: string, lead = 6, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}
