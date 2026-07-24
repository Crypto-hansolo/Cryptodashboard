import type { Result } from '../result.js';
import type { DomainError } from '../errors.js';
import type { EventCategory, ImpactLevel, RunStatus, SentimentLabel } from '../domain/enums.js';
import type { EventDraft } from '../domain/event.js';

/**
 * Infrastructure service ports.
 *
 * Same principle as the repositories: the domain and the connectors depend on
 * these interfaces, and `@cid/platform` / `@cid/ai` supply implementations.
 * It is what makes "swap Ollama for vLLM" and "run the enrichment pipeline
 * against a scripted fake model" the same amount of work.
 */

// ─── Time ────────────────────────────────────────────────────────────────────

/**
 * Injectable clock. Every scheduler, cooldown and decay computation reads time
 * through this, so tests can advance it instead of sleeping.
 */
export interface Clock {
  now(): Date;
  /** Milliseconds since an arbitrary epoch — for durations, not timestamps. */
  monotonicMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  monotonicMs: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
};

// ─── Logging ─────────────────────────────────────────────────────────────────

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface Logger {
  trace(context: Record<string, unknown> | string, message?: string): void;
  debug(context: Record<string, unknown> | string, message?: string): void;
  info(context: Record<string, unknown> | string, message?: string): void;
  warn(context: Record<string, unknown> | string, message?: string): void;
  error(context: Record<string, unknown> | string, message?: string): void;
  fatal(context: Record<string, unknown> | string, message?: string): void;
  /** Derive a logger that always includes `bindings`. */
  child(bindings: Record<string, unknown>): Logger;
}

/** No-op logger for tests and for libraries with no logger configured. */
export const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

// ─── Cache ───────────────────────────────────────────────────────────────────

export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /**
   * Get-or-compute with a single-flight guarantee: concurrent callers for the
   * same key await one upstream call rather than stampeding a rate-limited API.
   */
  remember<T>(key: string, ttlSeconds: number, factory: () => Promise<T>): Promise<T>;
  /** Best-effort pattern delete. */
  invalidate(pattern: string): Promise<number>;
}

// ─── Rate limiting ───────────────────────────────────────────────────────────

export interface RateLimiter {
  /** Resolves when the caller may proceed; rejects if `signal` aborts first. */
  acquire(key: string, signal?: AbortSignal): Promise<void>;
  /** Non-blocking check. */
  tryAcquire(key: string): Promise<boolean>;
  /** Remaining tokens, for diagnostics and the status UI. */
  remaining(key: string): Promise<number>;
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  timeoutMs?: number;
  /** Cache TTL for this response. 0 or omitted disables caching. */
  cacheTtlSeconds?: number;
  signal?: AbortSignal;
}

export interface HttpResponse<T> {
  status: number;
  headers: Record<string, string>;
  data: T;
  /** True when served from cache rather than the network. */
  fromCache: boolean;
  durationMs: number;
}

/**
 * Resilient HTTP client. Returns `Result` rather than throwing, because a failed
 * third-party call is an expected outcome in this system, not an exception.
 */
export interface HttpClient {
  request<T>(request: HttpRequest): Promise<Result<HttpResponse<T>, DomainError>>;
  /** Convenience wrapper that returns just the body. */
  getJson<T>(
    url: string,
    options?: Omit<HttpRequest, 'url' | 'method'>,
  ): Promise<Result<T, DomainError>>;
  /** Raw text, for RSS/Atom feeds. */
  getText(
    url: string,
    options?: Omit<HttpRequest, 'url' | 'method'>,
  ): Promise<Result<string, DomainError>>;
}

// ─── LLM ─────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  /**
   * Ask the provider to constrain output to this JSON Schema. Providers that
   * support it (Ollama `format`, vLLM guided decoding, llama.cpp grammars) get
   * real constrained generation; others fall back to prompt instructions plus
   * tolerant parsing.
   */
  jsonSchema?: Record<string, unknown>;
  stop?: string[];
  signal?: AbortSignal;
}

export interface CompletionUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalMs: number;
}

export interface CompletionResult {
  text: string;
  model: string;
  usage: CompletionUsage;
}

export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  /** True when the backend answered a health probe. */
  isAvailable(): Promise<boolean>;
  complete(
    messages: readonly ChatMessage[],
    options?: CompletionOptions,
  ): Promise<Result<CompletionResult, DomainError>>;
  /** Token-by-token streaming, for the interactive research console. */
  stream(
    messages: readonly ChatMessage[],
    options?: CompletionOptions,
  ): AsyncIterable<Result<string, DomainError>>;
}

export interface EmbeddingClient {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  isAvailable(): Promise<boolean>;
  embed(texts: readonly string[]): Promise<Result<number[][], DomainError>>;
}

// ─── AI enrichment ───────────────────────────────────────────────────────────

/** What the model is asked to produce for a single event. */
export interface EnrichmentVerdict {
  summary: string;
  explanation: string;
  sentiment: SentimentLabel;
  sentimentScore: number;
  importance: number;
  confidence: number;
  impact: ImpactLevel;
  category: EventCategory;
  narratives: string[];
  isFud: boolean;
}

export interface Enricher {
  enrich(input: {
    headline: string;
    body: string | null;
    sourceName: string;
    sourceCredibility: number;
    coinSymbol: string | null;
    category: EventCategory;
    occurredAt: Date;
  }): Promise<Result<EnrichmentVerdict, DomainError>>;
}

// ─── Notifications ───────────────────────────────────────────────────────────

export interface NotificationPayload {
  title: string;
  message: string;
  url: string | null;
  coinSymbol: string | null;
  importance: number | null;
  sentiment: SentimentLabel | null;
  triggeredAt: Date;
}

export interface Notifier {
  readonly channel: string;
  /** True when the channel is configured well enough to attempt delivery. */
  isConfigured(): boolean;
  send(payload: NotificationPayload): Promise<Result<void, DomainError>>;
}

// ─── Realtime ────────────────────────────────────────────────────────────────

export type RealtimeMessage =
  | { type: 'event'; payload: unknown }
  | { type: 'quote'; payload: { coinId: string; priceUsd: number; change24hPct: number | null } }
  | { type: 'alert'; payload: unknown }
  | { type: 'connector'; payload: { key: string; status: RunStatus; at: string } }
  | { type: 'heartbeat'; payload: { at: string } };

/**
 * Fan-out for live updates. Redis pub/sub in production so that the worker
 * process can push to SSE clients held open by the web process.
 */
export interface RealtimeBus {
  publish(channel: string, message: RealtimeMessage): Promise<void>;
  subscribe(
    channel: string,
    handler: (message: RealtimeMessage) => void,
  ): Promise<() => Promise<void>>;
}

// ─── Connectors ──────────────────────────────────────────────────────────────

/** Everything a connector needs, injected rather than imported. */
export interface ConnectorContext {
  http: HttpClient;
  cache: Cache;
  logger: Logger;
  clock: Clock;
  rateLimiter: RateLimiter;
  /** Resolved provider credentials and base URLs. */
  config: Readonly<Record<string, string | number | boolean | undefined>>;
}

/** A batch of normalised output from one connector run. */
export interface CollectionResult {
  events: EventDraft[];
  /** Domain-specific records the connector also produced, applied by the ingestion service. */
  records: CollectedRecords;
  itemsFetched: number;
}

/**
 * Typed side-channel for records that are not themselves timeline events
 * (a price tick is data; it only becomes an event when something notable
 * happens). Kept as a plain object so connectors can populate only what they know.
 */
export interface CollectedRecords {
  marketSnapshots?: unknown[];
  candles?: unknown[];
  derivatives?: unknown[];
  options?: unknown[];
  liquidations?: unknown[];
  trades?: unknown[];
  tradingPairs?: unknown[];
  liquidityPools?: unknown[];
  news?: unknown[];
  socialPosts?: unknown[];
  socialMetrics?: unknown[];
  onchainEvents?: unknown[];
  onchainMetrics?: unknown[];
  githubActivity?: unknown[];
  githubSnapshots?: unknown[];
  proposals?: unknown[];
  unlocks?: unknown[];
  tokenomics?: unknown[];
  wallets?: unknown[];
  socialAuthors?: unknown[];
}

export interface ConnectorRunSummary {
  connectorKey: string;
  status: RunStatus;
  itemsFetched: number;
  itemsIngested: number;
  durationMs: number;
  error: string | null;
}
