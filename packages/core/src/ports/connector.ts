import type { Result } from '../result.js';
import type { DomainError } from '../errors.js';
import type { Coin } from '../domain/coin.js';
import type { SourceKind } from '../domain/enums.js';
import type { CollectionResult, ConnectorContext } from './services.js';

/**
 * The connector contract — the platform's main extension point.
 *
 * A connector is a self-describing unit that turns one external source into
 * normalised domain records. It declares its own credential requirements, its
 * polling cadence and its rate limits as *data*, so the registry can decide
 * whether to enable it and the scheduler can decide how to run it, without
 * either of them knowing anything about the specific source.
 *
 * See docs/EXTENDING.md for a worked example of adding one.
 */

/** What a connector needs from the environment to function. */
export interface ConnectorRequirement {
  /** Env var name, e.g. `ETHERSCAN_API_KEY`. */
  envKey: string;
  /**
   * When false, the connector runs without this value but in a degraded mode
   * (lower rate limits, fewer fields). CoinGecko and GitHub are the canonical
   * examples: keyless works, keyed works much better.
   */
  required: boolean;
  description: string;
}

export type ConnectorDomain =
  | 'market'
  | 'derivatives'
  | 'dex'
  | 'news'
  | 'social'
  | 'onchain'
  | 'github'
  | 'governance'
  | 'tokenomics';

export interface ConnectorDescriptor {
  /** Stable unique key, also used as the `Source.key`. */
  key: string;
  name: string;
  domain: ConnectorDomain;
  sourceKind: SourceKind;
  homepageUrl: string | null;
  /** Editorial trust on [0,1], seeded into the Source row. */
  credibility: number;
  requirements: ConnectorRequirement[];
  /**
   * Default poll interval. The scheduler may override per-domain via env, but a
   * connector that physically cannot be polled faster than 60s says so here.
   */
  defaultIntervalMs: number;
  /** Upstream limit the rate limiter should honour. */
  rateLimit: { requestsPerMinute: number; burst?: number };
  /**
   * True when one run handles all coins at once (e.g. CoinGecko markets returns
   * 250 coins per call). False means the scheduler fans out per coin.
   */
  batchesCoins: boolean;
  /** Max coins per batched call. Ignored when `batchesCoins` is false. */
  maxCoinsPerRun?: number;
}

/** Input for a single collector run. */
export interface CollectionRequest {
  /** Coins to collect for. Empty for connectors that are not coin-scoped. */
  coins: readonly Coin[];
  /**
   * High-water mark from the previous successful run. Connectors use it to fetch
   * only what is new — the difference between a 60s poll being cheap and being
   * a full re-download every minute.
   */
  since: Date | null;
  signal?: AbortSignal;
}

export interface Connector {
  readonly descriptor: ConnectorDescriptor;
  /**
   * True when the connector has what it needs to run. The registry calls this at
   * boot and disables the connector rather than letting it fail every 60s.
   */
  isEnabled(context: ConnectorContext): boolean;
  /** Cheap liveness probe against the upstream, used by /health. */
  healthCheck?(context: ConnectorContext): Promise<Result<void, DomainError>>;
  collect(
    request: CollectionRequest,
    context: ConnectorContext,
  ): Promise<Result<CollectionResult, DomainError>>;
}

/**
 * Registry of available connectors.
 *
 * Implementations live in `@cid/connectors`. The registry is what makes the
 * plugin system real: connectors self-register, the worker asks for "all enabled
 * connectors in the `news` domain", and nothing needs a hard-coded list.
 */
export interface ConnectorRegistry {
  register(connector: Connector): void;
  get(key: string): Connector | null;
  list(): Connector[];
  listByDomain(domain: ConnectorDomain): Connector[];
  /** Only those whose requirements are satisfied. */
  listEnabled(context: ConnectorContext): Connector[];
  /** Diagnostic view for the status UI: what is on, what is off, and why. */
  describe(context: ConnectorContext): Array<{
    descriptor: ConnectorDescriptor;
    enabled: boolean;
    missingRequirements: string[];
    degraded: boolean;
  }>;
}
