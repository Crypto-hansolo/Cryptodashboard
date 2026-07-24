import { normalizeText } from './dedupe.js';

/**
 * Finding which coins a piece of text is about.
 *
 * This is the single largest source of garbage in a naive crypto aggregator.
 * Tickers collide with ordinary English — LINK, GAS, TIME, ID, SUN, ANT, NEAR,
 * MASK, PEOPLE, AI, OP, ONE, ALL are all real listed symbols — so matching bare
 * uppercase tokens against a symbol table tags half the newsfeed with the wrong
 * asset. The rules below are deliberately conservative: a false negative costs
 * one missed timeline row, a false positive corrupts every score and chart for
 * that coin.
 */

export interface MatchableCoin {
  id: string;
  symbol: string;
  name: string;
  /** Extra names/nicknames to match, e.g. ["cro", "crypto.com coin"]. */
  aliases?: readonly string[];
}

export interface CoinMatch {
  coinId: string;
  symbol: string;
  /** Confidence on [0,1]. */
  confidence: number;
  /** What triggered the match, for debugging false positives. */
  via: 'cashtag' | 'name' | 'alias' | 'symbol';
  /** Character offset of the first occurrence. */
  index: number;
}

/**
 * Symbols that are also common English words or too short to be meaningful on
 * their own. These match ONLY via `$SYMBOL`, the coin's name, or an alias —
 * never as a bare uppercase token.
 */
const AMBIGUOUS_SYMBOLS = new Set([
  'ai',
  'all',
  'and',
  'ant',
  'any',
  'api',
  'app',
  'are',
  'art',
  'ass',
  'ata',
  'bad',
  'bag',
  'ban',
  'bar',
  'bat',
  'bet',
  'bid',
  'big',
  'bit',
  'box',
  'boy',
  'bus',
  'buy',
  'cake',
  'can',
  'cap',
  'car',
  'cash',
  'cat',
  'ceo',
  'chat',
  'city',
  'club',
  'cold',
  'come',
  'cook',
  'core',
  'cow',
  'cpu',
  'cry',
  'cut',
  'dai',
  'dao',
  'dash',
  'data',
  'day',
  'dead',
  'deal',
  'deep',
  'dev',
  'die',
  'dog',
  'dot',
  'down',
  'dream',
  'drop',
  'due',
  'each',
  'earn',
  'east',
  'easy',
  'eat',
  'edge',
  'end',
  'era',
  'etf',
  'even',
  'fact',
  'fair',
  'fan',
  'far',
  'fast',
  'fear',
  'few',
  'fire',
  'first',
  'fit',
  'fix',
  'flow',
  'fly',
  'for',
  'form',
  'four',
  'free',
  'fuel',
  'full',
  'fun',
  'fund',
  'gas',
  'get',
  'gm',
  'go',
  'gods',
  'gold',
  'good',
  'grt',
  'hard',
  'has',
  'hat',
  'have',
  'help',
  'her',
  'here',
  'hey',
  'high',
  'him',
  'his',
  'hit',
  'hold',
  'home',
  'hope',
  'hot',
  'how',
  'hub',
  'ice',
  'id',
  'idea',
  'ids',
  'ing',
  'inch',
  'index',
  'ion',
  'iot',
  'iq',
  'iron',
  'is',
  'it',
  'job',
  'joe',
  'just',
  'key',
  'kid',
  'kind',
  'king',
  'know',
  'lab',
  'land',
  'last',
  'late',
  'law',
  'lay',
  'lead',
  'left',
  'less',
  'let',
  'life',
  'like',
  'line',
  'link',
  'lion',
  'list',
  'live',
  'lock',
  'log',
  'long',
  'look',
  'lot',
  'love',
  'low',
  'luck',
  'mad',
  'made',
  'main',
  'make',
  'man',
  'many',
  'map',
  'mars',
  'mask',
  'may',
  'me',
  'meme',
  'men',
  'met',
  'mid',
  'mind',
  'mine',
  'mint',
  'mix',
  'moon',
  'more',
  'most',
  'move',
  'much',
  'must',
  'my',
  'name',
  'near',
  'need',
  'net',
  'new',
  'news',
  'next',
  'nft',
  'nice',
  'night',
  'no',
  'node',
  'none',
  'noon',
  'north',
  'not',
  'now',
  'nuts',
  'oil',
  'ok',
  'old',
  'omg',
  'on',
  'once',
  'one',
  'only',
  'onto',
  'open',
  'op',
  'or',
  'other',
  'our',
  'out',
  'over',
  'own',
  'page',
  'paid',
  'pair',
  'part',
  'past',
  'pay',
  'peak',
  'people',
  'pet',
  'pick',
  'pin',
  'plan',
  'play',
  'plus',
  'pool',
  'poor',
  'pop',
  'port',
  'post',
  'power',
  'pro',
  'pump',
  'push',
  'put',
  'race',
  'rain',
  'rank',
  'rare',
  'rate',
  'read',
  'real',
  'red',
  'rent',
  'rest',
  'rich',
  'ride',
  'ring',
  'rise',
  'risk',
  'road',
  'rock',
  'role',
  'room',
  'root',
  'rose',
  'rug',
  'rule',
  'run',
  'safe',
  'said',
  'sale',
  'salt',
  'same',
  'sand',
  'save',
  'say',
  'sea',
  'seat',
  'see',
  'seed',
  'self',
  'sell',
  'send',
  'sense',
  'set',
  'shot',
  'show',
  'side',
  'sign',
  'silo',
  'sit',
  'six',
  'size',
  'skill',
  'sky',
  'slow',
  'small',
  'snow',
  'so',
  'soft',
  'sol',
  'some',
  'son',
  'song',
  'soon',
  'soul',
  'south',
  'space',
  'spot',
  'star',
  'start',
  'stay',
  'step',
  'still',
  'stop',
  'store',
  'story',
  'sun',
  'sure',
  'swap',
  'take',
  'talk',
  'tap',
  'team',
  'tech',
  'tell',
  'ten',
  'test',
  'text',
  'than',
  'that',
  'the',
  'them',
  'then',
  'there',
  'they',
  'thing',
  'this',
  'those',
  'time',
  'tip',
  'to',
  'today',
  'told',
  'too',
  'took',
  'top',
  'tour',
  'town',
  'trade',
  'tree',
  'true',
  'trust',
  'try',
  'turn',
  'two',
  'up',
  'us',
  'use',
  'used',
  'user',
  'value',
  'very',
  'view',
  'vote',
  'wait',
  'walk',
  'wall',
  'want',
  'war',
  'was',
  'watch',
  'water',
  'wave',
  'way',
  'we',
  'web',
  'week',
  'well',
  'went',
  'were',
  'west',
  'what',
  'when',
  'where',
  'which',
  'while',
  'white',
  'who',
  'why',
  'wide',
  'wife',
  'will',
  'win',
  'wind',
  'wing',
  'wish',
  'with',
  'wood',
  'word',
  'work',
  'world',
  'would',
  'yes',
  'yet',
  'you',
  'your',
  'zero',
  'zone',
]);

/**
 * True when a bare uppercase occurrence of this symbol should be ignored.
 * Also covers 1-2 character symbols, which are hopeless without a sigil.
 */
export function isAmbiguousSymbol(symbol: string): boolean {
  const s = symbol.toLowerCase();
  return s.length <= 2 || AMBIGUOUS_SYMBOLS.has(s);
}

/** Escape a string for safe interpolation into a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match coins mentioned in `text`.
 *
 * Confidence ladder, highest first:
 *   1.00  `$SYMBOL` cashtag — explicit, unambiguous intent
 *   0.90  full name as a whole-word phrase ("Crypto.com Coin")
 *   0.75  a registered alias
 *   0.65  bare uppercase ticker, only for non-ambiguous symbols
 *
 * Results are deduped per coin (best match wins) and sorted by confidence, then
 * by position — so the first-mentioned high-confidence coin is the primary
 * subject, which is what callers use as `Event.coinId`.
 */
export function matchCoins(
  text: string,
  coins: readonly MatchableCoin[],
  options: { minConfidence?: number; maxMatches?: number } = {},
): CoinMatch[] {
  const minConfidence = options.minConfidence ?? 0.6;
  const maxMatches = options.maxMatches ?? 10;
  if (text.trim() === '' || coins.length === 0) return [];

  const best = new Map<string, CoinMatch>();
  const normalized = normalizeText(text);

  const consider = (match: CoinMatch): void => {
    if (match.confidence < minConfidence) return;
    const existing = best.get(match.coinId);
    if (!existing || match.confidence > existing.confidence) best.set(match.coinId, match);
  };

  for (const coin of coins) {
    const symbol = coin.symbol.trim();
    if (symbol === '') continue;

    // 1. Cashtag — case-insensitive, must be followed by a word boundary.
    const cashtag = new RegExp(`\\$${escapeRegExp(symbol)}\\b`, 'i');
    const cashtagMatch = cashtag.exec(text);
    if (cashtagMatch) {
      consider({
        coinId: coin.id,
        symbol,
        confidence: 1,
        via: 'cashtag',
        index: cashtagMatch.index,
      });
      continue;
    }

    // 2. Full name, matched against normalized text to survive punctuation
    //    differences ("Crypto.com" vs "Crypto com").
    //
    //    Names get the same ambiguity guard as symbols: there are listed tokens
    //    literally named "Gas", "Time" and "Index", and matching those as names
    //    would tag every article about network fees with the GAS token. A
    //    multi-word name ("Chrono Tech") is specific enough to trust.
    const normalizedName = normalizeText(coin.name);
    const nameIsAmbiguous = !normalizedName.includes(' ') && isAmbiguousSymbol(normalizedName);
    if (normalizedName.length >= 3 && !nameIsAmbiguous) {
      const namePattern = new RegExp(`\\b${escapeRegExp(normalizedName)}\\b`);
      const nameMatch = namePattern.exec(normalized);
      if (nameMatch) {
        consider({
          coinId: coin.id,
          symbol,
          confidence: 0.9,
          via: 'name',
          index: nameMatch.index,
        });
        continue;
      }
    }

    // 3. Aliases.
    let aliasMatched = false;
    for (const alias of coin.aliases ?? []) {
      const normalizedAlias = normalizeText(alias);
      if (normalizedAlias.length < 3) continue;
      const aliasPattern = new RegExp(`\\b${escapeRegExp(normalizedAlias)}\\b`);
      const aliasMatch = aliasPattern.exec(normalized);
      if (aliasMatch) {
        consider({
          coinId: coin.id,
          symbol,
          confidence: 0.75,
          via: 'alias',
          index: aliasMatch.index,
        });
        aliasMatched = true;
        break;
      }
    }
    if (aliasMatched) continue;

    // 4. Bare ticker — only when the symbol is not an English word, and only
    //    when it appears in actual uppercase (case-sensitive on purpose:
    //    "link" in prose is a link, "LINK" is Chainlink).
    if (!isAmbiguousSymbol(symbol)) {
      const bare = new RegExp(`\\b${escapeRegExp(symbol.toUpperCase())}\\b`);
      const bareMatch = bare.exec(text);
      if (bareMatch) {
        consider({
          coinId: coin.id,
          symbol,
          confidence: 0.65,
          via: 'symbol',
          index: bareMatch.index,
        });
      }
    }
  }

  return [...best.values()]
    .sort((a, b) => b.confidence - a.confidence || a.index - b.index)
    .slice(0, maxMatches);
}

/**
 * The coin an item is *about*, as opposed to merely mentioning.
 * Returns null when nothing clears the bar — better an untagged event than a
 * miscategorised one.
 */
export function primaryCoin(matches: readonly CoinMatch[]): CoinMatch | null {
  if (matches.length === 0) return null;
  const top = matches[0]!;
  if (top.confidence < 0.65) return null;
  return top;
}

/** Extract `#hashtags` (lowercased, deduped, sigil stripped). */
export function extractHashtags(text: string): string[] {
  const matches = text.match(/#[\p{L}\p{N}_]{2,50}/gu) ?? [];
  return [...new Set(matches.map((tag) => tag.slice(1).toLowerCase()))];
}

/** Extract `$CASHTAGS` (uppercased, deduped, sigil stripped). */
export function extractCashtags(text: string): string[] {
  const matches = text.match(/\$[A-Za-z][A-Za-z0-9]{1,10}\b/g) ?? [];
  return [...new Set(matches.map((tag) => tag.slice(1).toUpperCase()))];
}
