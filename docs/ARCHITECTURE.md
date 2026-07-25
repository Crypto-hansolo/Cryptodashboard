# Architecture

How the platform is put together, and why. For the individual trade-offs and the
alternatives that were rejected, see [DECISIONS.md](DECISIONS.md).

## Contents

- [The shape of the problem](#the-shape-of-the-problem)
- [Layers](#layers)
- [Composition and dependency injection](#composition-and-dependency-injection)
- [The event pipeline](#the-event-pipeline)
- [Connectors](#connectors)
- [The scheduler](#the-scheduler)
- [Scoring and the AI layer](#scoring-and-the-ai-layer)
- [Data model](#data-model)
- [Search](#search)
- [Realtime](#realtime)
- [Alerts](#alerts)
- [Resilience](#resilience)
- [Observability](#observability)
- [Scaling](#scaling)
- [Security posture](#security-posture)

## The shape of the problem

The platform polls ~20 unrelated external providers on cadences from 10 seconds
to 15 minutes, normalises what comes back into one comparable stream, scores it,
and serves it to a browser within about a second of it landing. Three properties
follow from that and drive most of the design:

1. **Every provider will fail, and none of them may take the system with them.**
   Failure is the normal case, not the exception, so it is modelled as a return
   value rather than an exception, and isolated per provider.
2. **Data is append-only.** Analytics that answer "what did sentiment look like
   before the announcement?" need history, so nothing is overwritten in place.
3. **The expensive component is the slowest.** A local 8B model needs seconds per
   event. It therefore cannot sit anywhere on the ingestion path.

## Layers

Dependencies point strictly inward. `@cid/core` imports nothing from the other
packages — not even `node:crypto` — which is what keeps it testable without
infrastructure and bundlable into the browser.

```
                                  ┌───────────────┐
                                  │   apps/web    │  Next.js 15, React 19
                                  │  (composition │  server components + SSE
                                  │     root)     │
                                  └───────┬───────┘
   ┌──────────────┐                       │
   │ @cid/worker  │  (composition root)   │
   │  scheduler   ├───────────────┬───────┘
   └──────┬───────┘               │
          │                       │
   ┌──────▼───────┐   ┌───────────▼──┐   ┌──────────────┐
   │@cid/connectors│  │   @cid/db    │   │   @cid/ai    │   adapters:
   │  HTTP → domain│  │ Prisma → port│   │  LLM → port  │   implement core ports
   └──────┬───────┘   └───────┬──────┘   └───────┬──────┘
          │                   │                  │
          └───────────┬───────┴──────────────────┘
                      │
              ┌───────▼────────┐
              │ @cid/platform  │  config, logging, DI, HTTP, cache,
              │                │  rate limits, circuit breaker, metrics
              └───────┬────────┘
                      │
              ┌───────▼────────┐
              │   @cid/core    │  domain types, ports, pure services
              │  (no I/O)      │  sentiment, scoring, dedupe, alert rules
              └────────────────┘
```

| Package           | Contains                                                                                                                                                              | Must not contain                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `@cid/core`       | Zod-validated domain types, port interfaces, pure services (`sentiment`, `scoring`, `dedupe`, `coin-matcher`, `alert-engine`, `identifiers`), `Result`, `DomainError` | Any I/O, any framework, any `node:` import                 |
| `@cid/platform`   | `env` validation, logger, DI container, resilient HTTP client, cache, rate limiter, circuit breaker, metrics, Redis                                                   | Domain rules                                               |
| `@cid/db`         | Prisma schema, migrations, seed, mappers, nine repositories implementing core ports                                                                                   | Business logic beyond mapping                              |
| `@cid/connectors` | Connector SDK, registry, one connector per source                                                                                                                     | Direct database access                                     |
| `@cid/ai`         | LLM/embedding providers, enricher, research agent, report generator                                                                                                   | Ownership of numeric scores                                |
| `@cid/worker`     | Scheduler, ingestion service, enrichment loop, alert runtime, notification fan-out, cron                                                                              | Provider-specific HTTP                                     |
| `apps/web`        | App Router pages, 12 API routes, components                                                                                                                           | Anything the worker also needs — that belongs in a package |

The two composition roots are `packages/worker/src/main.ts` and
`apps/web/src/server/container.ts`. They are the only places that know which
concrete implementation satisfies which port.

### Ports

`@cid/core/ports` declares what the domain needs, in domain vocabulary:

- `repositories.ts` — `CoinRepository`, `EventRepository`, `MarketRepository`,
  `ContentRepository`, `WatchlistRepository`, `AlertRepository`,
  `SourceRepository`, `SearchRepository`, `AnalyticsRepository`,
  `TelemetryRepository`
- `services.ts` — `LlmClient`, `EmbeddingClient`, `Enricher`, `Cache`,
  `RateLimiter`, `RealtimeBus`, `Logger`, `Clock`, `HttpClient`, `Notifier`
- `connector.ts` — `Connector`, `ConnectorDescriptor`, `ConnectorRegistry`

Adapters implement them. `MarketRepository` says `latestQuotes(coinIds)`, not
`SELECT DISTINCT ON`; `LlmClient` says `complete(messages)`, not
`POST /api/chat`. That is what makes the domain unit-testable with fakes and 413
of the tests hermetic — no network, no database, no model.

## Composition and dependency injection

A small typed container (`packages/platform/src/container.ts`) with tokens in
`tokens.ts`:

```ts
const container = new Container();
container.registerValue(TOKENS.env, env);
container.registerFactory(TOKENS.repositories, (c) =>
  createRepositories(c.resolve(TOKENS.prisma)),
);
const repositories = container.resolve(TOKENS.repositories); // fully typed
```

Tokens carry a phantom type, so `resolve` returns the right type without casts.
Factories are memoised (one Prisma client, not one per resolution) and disposal
runs in reverse registration order, so Redis closes before the logger that
reports it closing. No decorators and no `reflect-metadata`: that would force
`experimentalDecorators` on every consumer and make `@cid/core` unbundlable for
the browser.

## The event pipeline

Everything the platform learns becomes an `Event` on one timeline, whatever the
source. A price move, a Cointelegraph article, a whale transfer and a Snapshot
proposal are the same shape, which is what lets one query, one filter set, one
scoring model and one alert engine serve all of them.

```
 connector.collect()
        │  EventDraft[] + typed records (quotes, candles, trades, posts, …)
        ▼
 IngestionService
        │  1. resolve source + coin           (coin-matcher, ambiguity guard)
        │  2. canonicalise URL, compute dedupeHash
        │  3. deterministic first-pass scoring (lexicon sentiment, importance)
        │  4. cluster against recent events   (stemmed shingle Jaccard ≥ 0.62)
        ▼
 EventRepository.insertMany()   ← append-only, unique (sourceId, dedupeHash)
        │  returns created: true only for genuinely new rows
        ├──────────────▶ RealtimeBus.publish(events)  → SSE → browser
        └──────────────▶ AlertEngine.processMany(event signals)
        │
        ▼  (asynchronously, bounded by LLM_CONCURRENCY)
 EnrichmentWorker
        │  LLM: summary, explanation, narratives, FUD flag, model sentiment
        │  reconcile model verdict against lexicon (lexicon wins when confident)
        │  recompute importance / confidence / impact
        │  embed for semantic search
        ▼
 Event updated in place for intelligence fields only; history preserved elsewhere
```

Two properties worth calling out:

**`created` is exact.** `insertMany` reports which rows were genuinely inserted,
including in-batch duplicates — two copies of the same article in one feed poll
produce one alert, not two. Getting this wrong is how alerting systems earn
distrust.

**Deduplication is clustering, not discarding.** A story covered by six outlets
keeps six rows with a shared `clusterId`; the timeline collapses them and shows
`duplicateCount`, and `?collapse=false` shows every one. Discarding would lose
the fact that six outlets covered it, which is itself a signal.

## Connectors

A connector is a descriptor plus a `collect` method. The descriptor is _data_, so
the registry can decide whether to enable it and the scheduler can decide how to
run it, without either knowing anything about the source:

```ts
readonly descriptor: ConnectorDescriptor = {
  key: 'coingecko',                    // also the Source.key and the breaker key
  name: 'CoinGecko',
  domain: 'market',
  sourceKind: 'AGGREGATOR',
  credibility: 0.9,
  requirements: [
    { envKey: 'COINGECKO_API_KEY', required: false, description: 'Raises the rate limit' },
  ],
  defaultIntervalMs: 10_000,
  rateLimit: { requestsPerMinute: 25 },
  batchesCoins: true,
  maxCoinsPerRun: 250,
};
```

Consequences of `requirements` being declared rather than checked ad hoc:

- The platform runs with **zero API keys**. A key-gated connector reports itself
  disabled and names the exact missing variable, instead of failing every 60s.
- `required: false` means degraded, not off — CoinGecko and GitHub both work
  keyless, just slower.
- The status view can say "8 sources disabled, here is which variable each
  needs", which is the difference between self-service and a support ticket.

`BaseConnector` turns a thrown exception into an `Err`, so a connector bug
degrades one source instead of killing a scheduler tick.

Implemented: CoinGecko, Binance (ticker + candles), DexScreener, DefiLlama, 12
RSS/Atom feeds, GitHub, Reddit, Etherscan V2, Snapshot. Declared but not
implemented: see the limitations section in the README and the worked example in
[EXTENDING.md](EXTENDING.md).

## The scheduler

Each connector gets its own independent timer at its own cadence. A 10-second
price poll and a 15-minute tokenomics poll have nothing to do with each other,
and a slow connector must not delay a fast one.

Per connector:

- **Overlap prevention** — a run still in flight skips its next tick.
- **Failure backoff** — consecutive failures push the next attempt out
  exponentially, complementing the HTTP circuit breaker.
- **High-water marks** — `since` comes from `ConnectorState`, so a poll fetches
  only what is new. This is the difference between a cheap 60s poll and a full
  re-download every minute.
- **Its own HTTP client**, keyed by `descriptor.key`. This matters more than it
  looks: the circuit breaker and rate limiter are both keyed on the client's
  provider string, so a shared client means one dead RSS feed opens the circuit
  for CoinGecko and Binance too, and the per-connector rate limits declared in
  each descriptor are never applied. Both were real bugs.
- **Cadence floor** — the per-domain env override cannot go below the
  connector's declared `defaultIntervalMs`. Configuration must not be able to
  violate what a provider physically permits.

Every run writes a `CollectorRun` row: status, duration, items fetched, events
created, error. That table is what `/api/health` and the metrics endpoint read.

Reports and maintenance run on `croner` (`0 * * * *` hourly, `0 7 * * *`
morning, `0 0 * * 1` weekly, `0 1 1 * *` monthly, `30 3 * * *` retention) with
`protect: true` so a slow report cannot overlap itself.

## Scoring and the AI layer

**The LLM is an input, not the author.** Deterministic code in `@cid/core` owns
every number:

- `sentiment.ts` — a crypto-specific lexicon with magnitudes, negation handling
  and magnitude-aware confidence. Confidence is
  `max(matchCount / 4, maxMagnitude)`, not a term count: a single "exploited"
  (−0.9) is decisive on its own, and counting terms made it look uncertain.
- `scoring.ts` — `computeImportance` blends a per-category prior, source
  credibility, engagement, whale magnitude, sentiment strength and time decay
  via `weightedScore`, which renormalises around missing inputs rather than
  treating them as zero. `importanceToImpact` maps 1–100 onto
  low/medium/high/critical.
- `reconcileSentiment` overrides a model verdict that contradicts a confident
  lexicon. A model that calls an exploit disclosure "bullish" is overruled.

Why: the same headline must score the same twice, scores must be explainable
without asking a model what it was thinking, and the platform must still work
with `LLM_PROVIDER=null`. The model contributes prose (summary, explanation,
narratives, FUD flag) and one weighted sentiment opinion.

Provider support is behind one `LlmClient` port: Ollama's native `/api/chat`
(using `format` for constrained JSON decoding, which is far more reliable than
prompting for JSON) and any OpenAI-compatible `/v1/chat/completions` — LM
Studio, llama.cpp's server, vLLM, LiteLLM. Every model response is parsed
through Zod; a malformed response degrades that one event.

The research agent (`packages/ai/src/agent.ts`) is retrieval-augmented over the
platform's own data: hybrid search → up to 20 events with timestamps, sources
and importance → a system prompt that forbids answering beyond the evidence →
inline `[n]` citations mapped back to event ids. A local 8B model knows nothing
about today, but it reads twenty retrieved events perfectly well.

## Data model

33 models, 96 indexes, in `packages/db/prisma/schema.prisma`.

| Group                   | Models                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity                | `Source`, `Coin`, `CoinIdentifier`, `CoinContract`                                                                                                   |
| User-owned              | `User`, `Watchlist`, `WatchlistItem`, `Portfolio`, `PortfolioHolding`, `Tag`, `CoinTag`                                                              |
| Timeline                | `Event`, `EventEmbedding`                                                                                                                            |
| Market                  | `MarketSnapshot`, `OhlcvCandle`, `DerivativesSnapshot`, `OptionsSnapshot`, `Liquidation`, `Trade`, `TradingPair`, `ExchangeListing`, `LiquidityPool` |
| Content                 | `NewsArticle`, `SocialAuthor`, `SocialPost`, `SocialMetric`                                                                                          |
| On-chain                | `Wallet`, `OnchainEvent`, `OnchainMetric`                                                                                                            |
| Development             | `GithubActivity`, `GithubRepoSnapshot`                                                                                                               |
| Governance / tokenomics | `GovernanceProposal`, `TokenUnlock`, `TokenomicsSnapshot`                                                                                            |
| Alerting                | `Alert`, `AlertTrigger`, `NotificationDelivery`                                                                                                      |
| Output / telemetry      | `Report`, `CollectorRun`, `ConnectorState`                                                                                                           |

Principles:

- **Append-only.** Observations carry `observedAt` and are inserted, never
  updated. `MarketSnapshot` is the one thing pruned (`MARKET_SNAPSHOT_RETENTION_DAYS`,
  default 90, `0` disables) because 10-second ticks for 500 coins are the only
  series with a genuine volume problem, and `OhlcvCandle` rollups preserve the
  shape. Events, news, social, on-chain and governance history are never pruned.
- **Coins have many identities.** `CoinIdentifier` (CoinGecko, CMC, symbol,
  slug) and `CoinContract` (chain + address) are separate tables, so one asset
  can be found by ticker, by CoinGecko id or by any of its contract addresses
  across chains.
- **Timestamps are threefold.** `occurredAt` (when it happened upstream),
  `ingestedAt` (when we saw it) and `enrichedAt` (when the model finished). The
  gap between the first two is the ingestion lag on the health endpoint.
- **Every user-owned table carries `userId`** even though the app is
  single-tenant. Adding auth later becomes an auth change, not a migration.
- **Keyset pagination throughout.** Cursors encode `(occurredAt, id)`, base64'd
  into an opaque string. `OFFSET` on a table that grows at the head both slows
  down and skips rows as new events arrive between pages — a correctness bug, not
  just a performance one.

## Search

Three retrieval modes over `Event`, all in `PrismaSearchRepository`:

1. **Keyword** — a `STORED` generated `tsvector` column weighting headline above
   body, GIN-indexed. Two query modes: `websearch_to_tsquery` when the user
   typed operators (quotes, `-exclusions`, `or`), and an OR of significant terms
   otherwise. That second path exists because the agent passes whole questions:
   ANDing every word in "What happened with Binance?" requires `happen &
binanc`, which no headline contains, and the agent returned no evidence for
   exactly this reason. Stopwords are stripped and `ts_rank` does the ordering —
   retrieval, not filtering.
2. **Semantic** — `EventEmbedding.vector` as pgvector with an **HNSW** index,
   cosine distance via `<=>`, similarity reported as `1 - distance`.
3. **Hybrid** (the default the API uses) — both, over-fetched and merged with
   semantic weighted 0.6 / keyword 0.4. Embeddings miss exact tokens (a ticker, a
   contract address, a version number); full-text misses paraphrase.

Coin search additionally uses `pg_trgm` for fuzzy name matching, and resolves
locally before falling through to CoinGecko so typing in the command palette
does not spend the provider's rate limit per keystroke.

## Realtime

The worker publishes to Redis pub/sub (`events`, `quotes`, `alerts`,
`connectors`); the web process subscribes and forwards over SSE at
`/api/stream`. The Redis hop is required because worker and web are separate
processes.

SSE rather than WebSockets: the traffic is strictly server-to-client, SSE
reconnects on its own with a server-controlled `retry:`, and it survives proxies
that mangle upgrade requests. A 20-second heartbeat keeps intermediaries from
closing an idle connection and lets the client detect a dead stream during quiet
periods. `x-accel-buffering: no` stops nginx from holding frames until its buffer
fills, which otherwise makes a "realtime" stream arrive in bursts.

## Alerts

Rule evaluation is pure (`packages/core/src/services/alert-engine.ts`): an
`AlertSignal` union in, a `AlertTrigger` draft or `null` out. 14 rule types, each
a Zod schema in a discriminated union, so the UI cannot persist a rule the worker
would reject — the API validates with the same schema the engine uses.

`RULE_SIGNAL_KINDS` maps each rule type to the signal kinds that can satisfy it,
so evaluation never even looks at irrelevant signals, and an exhaustive `never`
check makes adding a rule type without handling it a compile error.

Firing is guarded by a per-alert cooldown (default 300s) claimed atomically, so a
volatile minute produces one notification rather than forty. Delivery fans out to
desktop, Discord, Telegram, email and webhooks; each attempt is recorded in
`NotificationDelivery` with status and attempt count, and a channel failing does
not block the others.

## Resilience

The HTTP client composes, in order:

```
request → cache → circuit breaker → rate limiter → retry(jittered backoff) → fetch(timeout)
```

Order matters. Cache first, so a cached response costs no tokens and no breaker
state. Breaker before the limiter, so a dead provider does not consume tokens
other calls could use. Retry inside the breaker, so retries count toward opening
it. Everything keyed per provider, so failures stay local.

`DomainError.retryable` is the contract between connectors and the scheduler: a
429 or a 503 is retryable, a 400 or a missing key is not, and the scheduler backs
off accordingly instead of hammering a provider that will never succeed.

The rate limiter is a token bucket in Redis implemented as a Lua script, so the
check-and-decrement is atomic across processes. Cache `remember()` is
single-flight: a hundred concurrent misses on the same key produce one upstream
request.

## Observability

- **Structured logs** — pino, `pretty` in dev and `json` in production, with
  child loggers per component so every line carries its connector key.
- **Metrics** — `/api/metrics` in Prometheus text format: counters for events
  ingested, connector runs, LLM calls, cache hits/misses, breaker state
  transitions; histograms for provider latency; process gauges sampled per
  scrape so a fresh process is never an empty body. This is the _web_ process's
  registry — the worker records into its own in-process registry and exposes no
  HTTP endpoint, so its telemetry is read from `CollectorRun` and surfaced by
  `/api/health`.
- **Health** — `/api/health` reports each dependency separately and always
  returns 200 with a `status` verdict, because "app responding, model down" and
  "app dead" are different operational situations that a single boolean cannot
  express. It also reports ingestion lag p50/p95 and which connectors are
  failing, which is the number that actually says whether the platform is doing
  its job.

## Scaling

Tested shape: 500 tracked coins, millions of events, thousands of articles.

- **Coin count** — `MAX_TRACKED_COINS` bounds the scheduler's working set;
  watchlist coins take priority. Batched connectors (`batchesCoins: true`) cover
  250 coins per request, so coin count mostly costs database writes, not
  requests.
- **Event volume** — every timeline filter maps to an index, and pagination is
  keyset, so page 500 costs what page 1 costs. Partial indexes serve the
  enrichment and embedding backlogs, so "find work to do" stays a small scan
  regardless of table size.
- **Read path** — the dashboard's first paint is a server component reading
  directly through the repositories; only deltas travel over SSE.
- **Horizontal** — the web app is stateless and scales freely. The worker is
  safe to run at >1 replica (alert claims are atomic, rate limits live in Redis)
  but there is no reason to: more replicas multiply provider requests without
  adding coverage. Scale the worker by adding connectors, not copies.
- **The model is the bottleneck.** `LLM_CONCURRENCY` bounds in-flight requests
  because a single-GPU box serialises anyway and twenty parallel requests only
  add queueing latency. Enrichment backlog is visible in `/api/health`; if it
  grows, use a smaller model or raise the importance floor for enrichment.

## Security posture

- Config is validated once at startup by Zod; the process refuses to run on an
  invalid combination rather than failing later in a connector.
- `redactEnv` iterates the schema shape (not the parsed object, which omits
  absent optionals) so a secret can never be logged, present or not.
- Every API route runs through one wrapper that maps `DomainError` codes to
  statuses and turns anything unexpected into a 500 with a generic message plus a
  server-side log — an unhandled throw can carry a connection string.
- Rate limiting per IP on the public API surface (`RATE_LIMIT_RPM`).
- Internal routes fail closed: with `INTERNAL_API_TOKEN` unset the guard denies
  rather than allows.
- **Read-only against exchanges.** No API key with trading permission is used,
  and no private endpoint is called. Exchange keys are not even in
  `.env.example`.
- Raw SQL is parameterised. The two exceptions are pgvector literals (which the
  extension requires as a cast, and which are validated finite-numeric first) and
  `to_tsquery` terms (which are alphanumeric by construction).
