# Architecture decision records

Each record states the decision, what it was chosen over, and what it costs. The
brief asked for a better library or architecture choice to be used where one
exists and explained here — several of these depart from the stack as originally
specified, and those are marked **[departure]**.

Format: context → decision → alternatives → consequences.

---

## ADR-001 — npm workspaces, not pnpm/Turborepo

**Context.** Seven packages sharing types, three of which are consumed by both a
Next.js build and a plain Node process.

**Decision.** npm workspaces, TypeScript sources consumed directly (each package
points `main` at `src/index.ts`, no build step between packages).

**Alternatives.** pnpm + Turborepo is faster and has better caching. Nx offers
more. Both add a required global tool and a build graph to keep in sync.

**Consequences.** `npm install` works with the Node the user already has, and
editing `@cid/core` is immediately visible in the web app with no watch step or
stale `dist/`. The costs are real: no remote build cache, and Next.js needs
`transpilePackages` plus `resolve.extensionAlias` to handle `.js` specifiers in
TypeScript sources (see ADR-013). At this size that trade is worth it; past ~15
packages it would not be.

---

## ADR-002 — Pinned exact versions for the toolchain

**Context.** A caret range on TypeScript or Prisma means a fresh clone six months
from now installs a different compiler than the one this was verified against.

**Decision.** Exact pins for `typescript` and `prisma`; carets for libraries whose
patch releases are genuinely safe.

**Consequences.** Reproducible builds; deliberate upgrades. Dependabot noise is
the price.

---

## ADR-003 — Clean architecture with ports in the domain package

**Context.** The requirement that every connector and data source be
independently extendable, plus the intent to keep this maintainable rather than
demo-shaped.

**Decision.** `@cid/core` holds domain types, port interfaces and pure services
and imports nothing else — not even `node:crypto`, which is why SHA-256 is
implemented by hand (ADR-004). Adapters live in `@cid/db`, `@cid/platform`,
`@cid/connectors` and `@cid/ai`. Dependencies point inward only.

**Alternatives.** A conventional Next.js app with `lib/` and Prisma calls in
route handlers. Less code, and fine until the worker needs the same logic — at
which point either the logic is duplicated or the worker imports the Next app.

**Consequences.** 765 of 882 tests need no infrastructure at all: they run
against fakes because the domain only knows ports. Swapping Postgres, or adding a
second LLM backend, touches one adapter. The cost is indirection — a new
persisted field means editing a domain type, a port, a mapper, a repository and a
migration.

---

## ADR-004 — Hand-written SHA-256 in `@cid/core`

**Context.** Dedupe hashing lives in the domain layer, but the domain layer must
stay free of `node:` imports so it can be bundled for the browser and tested
without a runtime.

**Decision.** A pure-TypeScript SHA-256 (`packages/core/src/utils/sha256.ts`),
verified byte-identical to `crypto.createHash('sha256')` against the standard
vectors and 500 randomised inputs.

**Alternatives.** `node:crypto` (breaks the constraint), `js-sha256` (a
dependency for 80 lines), or injecting a `Hasher` port (ceremony for a pure
function).

**Consequences.** Slower than the native implementation, irrelevant at these
volumes. One subtlety the fuzz test caught: unpaired surrogates must encode as
U+FFFD, not CESU-8, or hashes diverge from Node's for a headline containing a
broken emoji.

---

## ADR-005 — `Result<T, E>` for I/O, exceptions for bugs

**Context.** Twenty providers, all of which fail routinely. A failing feed is an
expected state, not an exceptional one.

**Decision.** Anything crossing a third-party boundary returns
`Result<T, DomainError>`. Exceptions are reserved for programmer error.
`DomainError.retryable` is the contract between connectors and the scheduler.

**Alternatives.** Exceptions throughout, with typed error classes. Ergonomic, but
the type system stops telling you a call can fail, and one uncaught rejection in
a 10-second tick loop takes the worker down.

**Consequences.** Explicit failure handling at every call site, which is the
point. `BaseConnector` catches throws and converts them, so a connector bug
degrades one source rather than a tick.

---

## ADR-006 — No job queue for polling **[departure]**

**Context.** The brief listed background workers. The obvious reading is BullMQ.

**Decision.** No queue for collection. Each connector gets an independent timer
with overlap prevention and exponential failure backoff. Enrichment keeps its
backlog in Postgres — the pending rows _are_ the queue, served by a partial
index.

**Alternatives.** BullMQ with repeatable jobs. It is a good library, aimed at
durable, distributable work.

**Rationale.** Polling a price feed every 10 seconds is not durable work: a
missed tick should be **skipped**, not queued and replayed later against stale
timestamps. A queue would accumulate backlog during a provider outage and then
stampede every provider at once on recovery — precisely the wrong behaviour
against a rate limit. Meanwhile the work that genuinely must not be lost
(enrichment, embeddings) is already durable in the database, and a Redis queue
would add a second source of truth that can disagree with it.

**Consequences.** No queue dashboard, and no distributing collection across
machines. Both acceptable: telemetry lives in `CollectorRun`, and one worker
saturates provider limits long before it saturates a CPU. `croner` handles the
cron-shaped work with correct DST behaviour and `protect: true` for
non-overlapping runs.

---

## ADR-007 — HNSW over IVFFlat for vector search

**Context.** pgvector offers both index types for the embedding column.

**Decision.** HNSW.

**Rationale.** IVFFlat must be built against existing data to pick sensible
centroids, and an index built on an empty table stays bad until it is rebuilt —
awful for a system whose corpus starts empty and grows continuously. HNSW is
incrementally maintainable, needs no training pass, and gives better
recall-per-query at this scale. Its slower build and larger memory footprint do
not bite at hundreds of thousands of vectors.

**Consequences.** Semantic search is good from the first insert. If the corpus
reached tens of millions of vectors, IVFFlat with a periodic rebuild would
deserve another look.

---

## ADR-008 — Deterministic code owns the scores; the LLM is one input

**Context.** Every event needs sentiment, importance 1–100, confidence 1–100 and
an impact level. The straightforward implementation asks the model for all four.

**Decision.** `@cid/core` computes all four with pure, tested functions. The
model contributes prose plus one weighted sentiment opinion, and
`reconcileSentiment` overrides it when a confident lexicon disagrees.

**Rationale.** Three reasons, in order of importance. Reproducibility: the same
headline must score the same twice, and a temperature-0.2 model does not
guarantee that. Explainability: "82 because the category prior is high, the
source is credible and it is 20 minutes old" beats "82 because the model said
so". Availability: with `LLM_PROVIDER=null` the platform must still rank, filter
and alert — which it does, losing only the prose.

The reconciliation step earns its place. A model that reads an exploit disclosure
and returns "bullish" is not a hypothetical; it is overruled because the lexicon
scores "exploited" at −0.9 with high confidence.

**Consequences.** The scoring lexicon needs occasional curation as market
vocabulary shifts. That is a visible, testable, reviewable file — which a prompt
is not.

---

## ADR-009 — Magnitude-aware lexicon confidence

**Context.** Confidence was originally `matchedTerms / 4`, so a headline whose
only sentiment term was "exploited" scored 0.25 — low enough that a bullish model
verdict survived reconciliation on a security incident.

**Decision.** `confidence = clamp(max(matchCount / 4, maxMagnitude), 0, 1)`.

**Consequences.** One decisive term is treated as decisive; many mild ones still
accumulate. This was a real bug caught by a test written against a real headline,
and it is the single most consequential line in the scoring code.

---

## ADR-010 — Cluster duplicates, never discard them

**Context.** One story appears across six outlets within minutes.

**Decision.** Store all six with a shared `clusterId`, computed from URL
canonicalisation plus stemmed word-shingle Jaccard similarity (threshold 0.62).
The timeline collapses clusters and reports `duplicateCount`;
`?collapse=false` returns every row.

**Rationale.** Six outlets covering a story _is_ the signal — it is what
distinguishes a press release from news. Discarding would destroy it. Stemming is
applied inside `textSimilarity` only, because reworded headlines scored 0.46 on
raw shingles and failed to cluster, while the public `tokenize`/`shingles`
helpers still need to be lossless.

**Consequences.** More rows and a similarity comparison against recent events per
insert, bounded by a time window and an index.

---

## ADR-011 — Keyset pagination, not OFFSET

**Context.** The timeline grows at the head, continuously.

**Decision.** Opaque base64 cursors encoding `(occurredAt, id)`.

**Rationale.** `OFFSET` is not merely slower here, it is wrong: events arriving
between page 1 and page 2 shift the window, so page 2 re-shows or skips rows.
There is an E2E test asserting no overlap between pages for exactly this.

**Consequences.** No "jump to page 7", which a live feed does not want anyway.

---

## ADR-012 — SSE, not WebSockets **[departure]**

**Context.** The brief listed WebSockets and SSE "where appropriate".

**Decision.** SSE for all server→client traffic. No WebSocket.

**Rationale.** Every realtime payload here flows one way: events, quotes, alerts,
connector status. Client→server actions are ordinary mutations that want HTTP
semantics, status codes and caching. SSE reconnects on its own with a
server-controlled `retry:`, survives proxies that mangle upgrades, and needs no
client library. A WebSocket would add a second protocol, its own reconnect and
heartbeat logic, and sticky-session constraints, for no capability used.

**Consequences.** A 20-second heartbeat is needed so idle connections are not
reaped and the client can detect a dead stream. Browsers cap SSE connections per
origin over HTTP/1.1 — irrelevant single-tenant, and HTTP/2 removes it.

---

## ADR-013 — `extensionAlias`, not stripped extensions

**Context.** Shared packages are Node ESM and must use `.js` specifiers in
TypeScript sources. Webpack could not resolve them.

**Decision.** `resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] }` in
`next.config.mjs`.

**Alternatives.** Dropping the extensions would fix the Next build and break the
worker, which runs the same files under Node's ESM resolver where extensions are
mandatory.

**Consequences.** Both consumers resolve the same source. Also required:
`serverExternalPackages` for Prisma and pino (renamed from
`experimental.serverComponentsExternalPackages` in Next 15).

---

## ADR-014 — `fast-xml-parser`, not an RSS library

**Context.** 12 feeds mixing RSS 2.0, Atom and RDF, with inconsistent date
formats, namespaced extensions and images hidden in three different places.

**Decision.** Parse XML with `fast-xml-parser` and normalise in our own code
(`packages/connectors/src/news/feed-parser.ts`).

**Alternatives.** `rss-parser` handles the common cases and hides the rest, and
its normalisation is not extensible where these feeds actually differ.

**Consequences.** More code, fully under test, and quirks are fixable. One
example: an article image may live in `media:content`, in an `enclosure`, or only
as an `<img>` inside `content:encoded` — and for some feeds only inside
`description`. Both bodies are checked, in that order.

---

## ADR-015 — A hand-rolled DI container

**Context.** Two composition roots need the same object graph, typed.

**Decision.** ~120 lines: tokens carrying a phantom type, memoised factories,
reverse-order disposal.

**Alternatives.** tsyringe/InversifyJS need decorators and `reflect-metadata`,
which would force `experimentalDecorators` on every consumer and pull a runtime
dependency into `@cid/core`, making it unbundlable for the browser. Manual wiring
without a container was the other option; it duplicates the graph across two
roots and gets disposal order wrong.

**Consequences.** No auto-wiring; each registration is explicit, which is
readable at this size.

---

## ADR-016 — Ollama's native API for constrained JSON

**Context.** Enrichment needs structured output from a local model. Small models
prompted for JSON emit prose preambles, trailing commentary and markdown fences.

**Decision.** Use Ollama's `/api/chat` with `format` (its grammar-constrained
decoding) when the provider is Ollama; fall back to prompt-and-parse for generic
OpenAI-compatible servers. Every response is validated with Zod either way.

**Consequences.** Ollama users get near-100% parse rates; other backends rely on
the repair-and-retry path. A malformed response degrades one event, never the
loop.

---

## ADR-017 — OR semantics for natural-language retrieval

**Context.** `/api/ask` returned `noEvidence: true` for "What happened with
Binance?" against a database that clearly contained Binance events.

**Decision.** `buildTsQuery` chooses between two modes: `websearch_to_tsquery`
when the input contains operators (quotes, `-exclusions`, an explicit `or`), and
an OR of significant terms with question stopwords stripped otherwise.

**Rationale.** `websearch_to_tsquery` ANDs everything, so the question above
requires `happen & binanc` — and no headline contains "happened". A search box
wants AND; a retrieval step wants OR with `ts_rank` doing the ordering. The two
callers need different semantics, and the distinguishing signal is whether the
user typed operators.

**Consequences.** Five integration tests cover the split. Retrieval recall
improved from zero to useful on the exact question the brief gives as an example.

---

## ADR-018 — Integration tests refuse to run without a disposable database

**Context.** The integration harness truncates every table between files. It
defaulted to `DATABASE_URL`, and destroyed a working development database with
its seed data.

**Decision.** `resolveTestDatabaseUrl()` requires `TEST_DATABASE_URL`, or a
`DATABASE_URL` whose database name matches `/(^|[_-])(test|ci|e2e)(_|-|$)/i`.
Otherwise the suite **skips** with a console warning instead of running.

**Rationale.** A test suite must never be able to destroy real data by default.
Skipping loudly is strictly better than a fast, destructive default.

**Consequences.** One extra env var, documented in `.env.example` and CI. Worth
it.

---

## ADR-019 — `singleFork` for integration tests

**Context.** Integration files passed individually and failed together: they were
truncating each other's fixtures in parallel.

**Decision.** `pool: 'forks'` with `poolOptions.forks.singleFork: true` for the
integration project.

**Note.** A project-level `fileParallelism: false` is _ignored_ by the runner —
verified. `singleFork` is what actually serialises the files. Also note
`vitest.workspace.ts` with `defineWorkspace` rather than `test.projects`, which
is a Vitest 3 feature and silently matches no tests on Vitest 2.

**Consequences.** Slower integration runs (~30s), correct results. Per-file
schemas would restore parallelism if that ever matters.

---

## ADR-020 — Per-connector HTTP clients

**Context.** All connectors initially shared one client with
`provider: 'connectors'`.

**Decision.** The scheduler builds a memoised client per connector, keyed by
`descriptor.key`.

**Rationale.** The circuit breaker and rate limiter are both keyed on the
provider string. Sharing meant a single dead RSS feed opened the circuit for
CoinGecko, Binance and everything else, and the per-connector rate limits each
descriptor declares were never applied. After the fix, observed `CIRCUIT_OPEN`
errors during a run went from several to zero.

**Consequences.** One client object per connector — trivial — and correct
isolation.

---

## ADR-021 — Recharts for charting

**Context.** Nine series types across price, sentiment, whale flows, dev activity
and derivatives.

**Decision.** Recharts.

**Alternatives.** TradingView's Lightweight Charts is better at candlesticks but
awkward for the non-price series and needs imperative lifecycle management inside
React. `visx` is more flexible and much more code. Chart.js is not
React-declarative.

**Consequences.** Consistent declarative composition for all nine series.
Recharts is not the fastest at tens of thousands of points, so series are
downsampled server-side to ~200 buckets per range, which is more than a 1440px
chart can resolve anyway.

---

## ADR-022 — Radix primitives with local styling, not a shipped component library

**Context.** The brief specified shadcn/ui.

**Decision.** Radix primitives plus `cva` and Tailwind, with components written
into the repo — which is what shadcn/ui is, so this follows the brief rather than
departing from it. `cmdk` provides the command palette.

**Rationale.** A dense terminal UI overrides most of a component library's
opinions anyway. Owning the components means the dark-first, monospace,
information-dense styling is the default rather than a fight, while Radix still
handles focus traps, ARIA and keyboard interaction — the parts that are genuinely
hard.

**Consequences.** No upstream design updates; full control of the visual
language.

---

## ADR-023 — Prune only raw market snapshots

**Context.** "Never overwrite, keep full history" versus 10-second ticks for 500
coins, which is ~4.3M rows a day.

**Decision.** `MarketSnapshot` is pruned after `MARKET_SNAPSHOT_RETENTION_DAYS`
(default 90; `0` disables). `OhlcvCandle` rollups, events, news, social,
on-chain, governance and tokenomics history are never pruned.

**Rationale.** High-frequency ticks are the only series with a real volume
problem, and their long-term information content is preserved by the candle
rollups. Everything the brief actually asks to analyse historically is kept
forever.

**Consequences.** Tick-level replay is unavailable beyond the window. Setting the
variable to `0` keeps everything, at roughly 1 GB per fortnight at 500 coins.

---

## ADR-024 — Both timestamps on every event

**Context.** Sources report their own times, sometimes wrongly, sometimes in a
local timezone.

**Decision.** Keep `occurredAt` (upstream) and `ingestedAt` (ours) separately;
add `enrichedAt` when the model finishes.

**Consequences.** The timeline orders by `occurredAt` so a story appears where it
belongs, while `ingestedAt - occurredAt` gives the ingestion-lag percentiles on
the health endpoint. One column could not do both.
