import {
  UnsupportedError,
  err,
  ok,
  type CollectedRecords,
  type CollectionRequest,
  type CollectionResult,
  type Coin,
  type Connector,
  type ConnectorContext,
  type ConnectorDescriptor,
  type DomainError,
  type EventDraft,
  type Result,
} from '@cid/core';

/**
 * Connector SDK.
 *
 * A connector is deliberately a small, self-describing unit: a descriptor
 * (identity, cadence, rate limit, credential requirements) plus a `collect`
 * method. Everything else — HTTP retries, caching, rate limiting, circuit
 * breaking, source registration, scheduling, telemetry — is provided by the
 * platform and the worker, so a new source is genuinely ~100 lines.
 *
 * See docs/EXTENDING.md for a worked example.
 */

/** Convenience accumulator so `collect` implementations stay flat. */
export class CollectionBuilder {
  readonly #events: EventDraft[] = [];
  readonly #records: CollectedRecords = {};
  #fetched = 0;

  addEvent(draft: EventDraft): this {
    this.#events.push(draft);
    return this;
  }

  addEvents(drafts: readonly EventDraft[]): this {
    this.#events.push(...drafts);
    return this;
  }

  /** Append to one of the typed record buckets. */
  add<K extends keyof CollectedRecords>(bucket: K, rows: NonNullable<CollectedRecords[K]>): this {
    if (rows.length === 0) return this;
    const existing = (this.#records[bucket] ?? []) as unknown[];
    this.#records[bucket] = [...existing, ...rows] as CollectedRecords[K];
    return this;
  }

  /** Count of upstream items seen, whether or not they produced records. */
  countFetched(n: number): this {
    this.#fetched += n;
    return this;
  }

  build(): CollectionResult {
    return { events: this.#events, records: this.#records, itemsFetched: this.#fetched };
  }
}

export function emptyResult(): CollectionResult {
  return { events: [], records: {}, itemsFetched: 0 };
}

/**
 * Base class handling the parts every connector repeats.
 *
 * Subclasses implement `run`, and get: credential checks derived from the
 * descriptor, config access, and the guarantee that a thrown exception becomes
 * an `Err` rather than taking down a scheduler tick.
 */
export abstract class BaseConnector implements Connector {
  abstract readonly descriptor: ConnectorDescriptor;

  /** The actual work. Exceptions are caught by {@link collect}. */
  protected abstract run(
    request: CollectionRequest,
    context: ConnectorContext,
    builder: CollectionBuilder,
  ): Promise<void>;

  /**
   * Enabled when every `required: true` requirement has a non-empty value.
   * Optional requirements only affect rate limits and field coverage, so their
   * absence degrades rather than disables.
   */
  isEnabled(context: ConnectorContext): boolean {
    return this.descriptor.requirements
      .filter((requirement) => requirement.required)
      .every((requirement) => {
        const value = context.config[requirement.envKey];
        return value !== undefined && value !== null && String(value).trim() !== '';
      });
  }

  /** Requirements that are declared but unmet — surfaced in the status UI. */
  missingRequirements(context: ConnectorContext): string[] {
    return this.descriptor.requirements
      .filter((requirement) => {
        const value = context.config[requirement.envKey];
        return value === undefined || value === null || String(value).trim() === '';
      })
      .map((requirement) => requirement.envKey);
  }

  /** True when running without an optional credential. */
  isDegraded(context: ConnectorContext): boolean {
    return this.descriptor.requirements.some((requirement) => {
      if (requirement.required) return false;
      const value = context.config[requirement.envKey];
      return value === undefined || value === null || String(value).trim() === '';
    });
  }

  async collect(
    request: CollectionRequest,
    context: ConnectorContext,
  ): Promise<Result<CollectionResult, DomainError>> {
    if (!this.isEnabled(context)) {
      return err(
        new UnsupportedError(`${this.descriptor.key} is not configured`, {
          missing: this.missingRequirements(context),
        }),
      );
    }

    const builder = new CollectionBuilder();
    try {
      await this.run(request, context, builder);
      return ok(builder.build());
    } catch (error) {
      // A connector bug must degrade one source, not the whole tick.
      context.logger.error(
        { connector: this.descriptor.key, err: error },
        'connector threw during collect',
      );
      return err(
        error instanceof Error
          ? new UnsupportedError(`${this.descriptor.key}: ${error.message}`)
          : new UnsupportedError(`${this.descriptor.key}: unknown failure`),
      );
    }
  }

  // ── Helpers for subclasses ──

  protected config(context: ConnectorContext, key: string): string | undefined {
    const value = context.config[key];
    if (value === undefined || value === null) return undefined;
    const asString = String(value).trim();
    return asString === '' ? undefined : asString;
  }

  protected requireConfig(context: ConnectorContext, key: string): string {
    const value = this.config(context, key);
    if (value === undefined) {
      throw new Error(`${this.descriptor.key}: missing required config ${key}`);
    }
    return value;
  }

  protected configNumber(context: ConnectorContext, key: string, fallback: number): number {
    const value = this.config(context, key);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}

// ─── Shared symbol helpers ───────────────────────────────────────────────────

/**
 * Index coins by uppercase symbol.
 *
 * Exchange APIs speak in symbols, not our ids, so every CEX connector needs
 * this. Colliding symbols resolve to the highest-ranked coin, matching how
 * `CoinRepository.findByIdentifiers` breaks the same tie — the two must agree or
 * the same ticker maps to different assets depending on the path taken.
 */
export function indexBySymbol(coins: readonly Coin[]): Map<string, Coin> {
  const bySymbol = new Map<string, Coin>();
  for (const coin of coins) {
    const key = coin.symbol.toUpperCase();
    const existing = bySymbol.get(key);
    if (!existing) {
      bySymbol.set(key, coin);
      continue;
    }
    const existingRank = existing.marketCapRank ?? Number.MAX_SAFE_INTEGER;
    const candidateRank = coin.marketCapRank ?? Number.MAX_SAFE_INTEGER;
    if (candidateRank < existingRank) bySymbol.set(key, coin);
  }
  return bySymbol;
}

/** Quote assets treated as USD-equivalent when pricing a pair. */
export const USD_QUOTES: readonly string[] = [
  'USDT',
  'USDC',
  'USD',
  'BUSD',
  'FDUSD',
  'DAI',
  'TUSD',
];

/**
 * Split an exchange symbol like `BTCUSDT` into base and quote.
 * Returns null when no known quote suffix matches — better to skip a pair than
 * to guess and attribute BTC volume to a coin called "BTCU".
 */
export function splitSymbol(
  symbol: string,
  quotes: readonly string[] = USD_QUOTES,
): { base: string; quote: string } | null {
  const upper = symbol.toUpperCase();
  // Longest quote first, so USDT is not matched as USD with a stray T.
  const ordered = [...quotes].sort((a, b) => b.length - a.length);
  for (const quote of ordered) {
    if (upper.endsWith(quote) && upper.length > quote.length) {
      return { base: upper.slice(0, -quote.length), quote };
    }
  }
  return null;
}

/** Numeric coercion for the strings exchange APIs return for every field. */
export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Non-null numeric coercion with a fallback, for required columns. */
export function numOr(value: unknown, fallback: number): number {
  return num(value) ?? fallback;
}

/**
 * Parse a timestamp that a provider might express as ISO text, seconds, or
 * milliseconds. Returns null for anything implausible rather than a 1970 date,
 * which would otherwise silently poison the timeline ordering.
 */
export function parseTimestamp(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;

  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    // Heuristic: 1e12 is the seconds/milliseconds boundary for any date after
    // 2001, and no provider sends seconds beyond that.
    const ms = numeric > 1e12 ? numeric : numeric * 1000;
    const date = new Date(ms);
    return isPlausible(date) ? date : null;
  }

  const date = new Date(String(value));
  return isPlausible(date) ? date : null;
}

/** Guards against epoch-zero and far-future timestamps from broken providers. */
function isPlausible(date: Date): boolean {
  if (Number.isNaN(date.getTime())) return false;
  const year = date.getUTCFullYear();
  return year >= 2009 && year <= new Date().getUTCFullYear() + 2;
}
