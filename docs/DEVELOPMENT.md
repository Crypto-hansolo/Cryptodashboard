# Development

Working on the codebase itself. For adding a source, an alert rule or a notifier,
see [EXTENDING.md](EXTENDING.md); for why things are the way they are, see
[DECISIONS.md](DECISIONS.md).

## Getting set up

```bash
npm install
cp .env.example .env
docker compose up -d postgres redis   # or your own
npm run db:migrate
npm run db:seed                       # sample data, so the UI is not empty
npm run dev                           # web :3000 + worker, side by side
```

`npm run dev` runs both processes with labelled output. Editing a shared package
is picked up by both without a build step — packages point `main` at
`src/index.ts` and are consumed as TypeScript source.

## Layout

```
packages/
  core/          domain types, ports, pure services      no I/O, no node:
  platform/      config, logging, DI, HTTP, cache, limits, metrics
  db/            Prisma schema, migrations, repositories
  connectors/    one connector per source + the SDK
  ai/            LLM providers, enrichment, agent, reports
  worker/        scheduler, ingestion, alerts, cron
apps/web/        Next.js dashboard and API
e2e/             Playwright specs
docs/            this
```

The dependency rule: **inward only**. `@cid/core` imports nothing from the other
packages. If you find yourself wanting `@cid/db` inside `@cid/core`, what you
actually want is a port in `core/src/ports` and an implementation in `db`.

## Commands

| Command                     | What it does                                                     |
| --------------------------- | ---------------------------------------------------------------- |
| `npm run verify`            | format check + lint + typecheck + unit tests. Run before pushing |
| `npm test`                  | 765 unit tests. Hermetic: no network, no database, no model      |
| `npm run test:integration`  | 101 tests against real Postgres + pgvector                       |
| `npm run test:e2e`          | 16 Playwright tests against a production build                   |
| `npm run test:coverage`     | unit tests with thresholds enforced                              |
| `npm run typecheck`         | `tsc --noEmit` in every workspace                                |
| `npm run lint` / `lint:fix` | ESLint across the monorepo                                       |
| `npm run format`            | Prettier write                                                   |
| `npm run db:migrate`        | create a migration and apply it (dev)                            |
| `npm run db:migrate:deploy` | apply pending migrations (production)                            |
| `npm run db:studio`         | Prisma Studio                                                    |
| `npm run db:seed`           | idempotent sample data                                           |

## Testing

Three suites, three different contracts. Which one a change belongs in is
usually obvious from what it would take to make it fail.

### Unit — `packages/*/src/**/*.test.ts`

Hermetic and fast (~6s for 765 tests). No network, no database, no model, no
sleeping. Anything that needs one of those is not a unit test.

Doubles live in the shared test kit, `@cid/platform/testing`:

| Double             | Use                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `FakeClock`        | Advance time instead of sleeping. Every backoff, cooldown, TTL and decay reads the injected clock                               |
| `createFetchStub`  | Scripted `fetch`, including hangs that honour the abort signal                                                                  |
| `FakeHttpClient`   | Scripted `HttpClient` with route matching and request recording — what connector tests use                                      |
| `fakeRepositories` | Partial `Repositories`; anything unstubbed throws naming the method, so a test cannot silently pass because a call went nowhere |

Plus `@cid/ai/testing`: `FakeLlmClient` (scripted responses, including
pathological ones), `FakeEmbeddingClient` (deterministic vectors) and
`fakeVerdictJson`.

Prefer a fake over a mock. `vi.fn()` assertions on call counts describe the
implementation; a fake that records what it received describes the contract.

```ts
const http = new FakeHttpClient([
  { match: '/coins/markets', body: [marketRow] },
]);
const result = await connector.collect(request, contextWith(http));

expect(result.value.records.marketSnapshots?.[0]).toMatchObject({
  priceUsd: 89948.29,
});
expect(http.lastRequest?.query).toMatchObject({ ids: 'bitcoin' });
```

### Integration — `packages/db/tests/integration/`

Real Postgres with pgvector. These exist because the repository layer's contract
_is_ SQL behaviour: a generated `tsvector` column, HNSW ordering, `DISTINCT ON`,
cursor stability under concurrent inserts. Mocking Prisma here would test the
mock.

> **They truncate every table.** The harness refuses to run unless
> `TEST_DATABASE_URL` is set, or `DATABASE_URL` names a database matching
> `test`/`ci`/`e2e`; otherwise it skips with a warning. That guard exists because
> the harness once wiped a working development database. Do not remove it.

```bash
createdb cid_test
psql cid_test -c 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;'
TEST_DATABASE_URL=postgresql://cid:cid@localhost:5432/cid_test?schema=public \
  npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
npm run test:integration
```

Files run **serially** (`pool: 'forks'` + `singleFork`) because they share one
database. A project-level `fileParallelism: false` is silently ignored by the
runner — `singleFork` is what actually enforces it.

### E2E — `e2e/`

Playwright against a production build with seeded data, `INGESTION_ENABLED=false`
and `LLM_PROVIDER=null`. Deliberate: live connectors would make assertions
network- and time-dependent, and the point is the UI and API contract, not
whether CoinDesk's feed is up.

```bash
npm run db:seed
npx playwright install chromium   # once
npm run test:e2e
```

Assert on behaviour a user depends on — the timeline renders, filters narrow it,
the palette finds a coin — not on copy or pixel positions, which break on every
design tweak. Keyboard tests must wait for hydration first (`waitForHydration`);
shortcuts register in a `useEffect`, so pressing a key right after `goto()` is a
race in the test, not a bug in the app.

If a container ships a Chromium built for a different Playwright revision, point
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` at it rather than downloading another.

### Coverage

`npm run test:coverage` enforces 62% statements / 80% branches / 80% functions on
the **unit** suite. Read the per-package numbers with that scope in mind:
`@cid/db` shows 0% there while being the most thoroughly tested package in the
repo, because its tests are the integration suite, which runs without coverage.

## Conventions

**Comments say why.** The code already says what. A comment that restates the
line below it is noise; a comment explaining that confidence is
`max(count/4, maxMagnitude)` because a lone "exploited" is decisive on its own is
the reason the next person does not "simplify" it back into a bug.

**`Result`, not exceptions, across third-party boundaries.** A failing provider is
an expected outcome. Exceptions are for programmer error.

```ts
const response = await http.getJson<Payload>(url);
if (!response.ok) throw response.error; // inside a connector: BaseConnector converts it
```

**Zod schema and type together.** One definition serves compile-time types,
runtime validation of untrusted payloads, and enum parity with Prisma.

```ts
export const sentimentLabelSchema = z.enum(SENTIMENT_LABELS);
export type SentimentLabel = z.infer<typeof sentimentLabelSchema>;
```

**Explicit return types on exported functions.** Inference is fine locally;
across a package boundary an accidental widening becomes someone else's bug.

**`#private`, not `private`.** Real encapsulation rather than a compile-time
suggestion.

**Named exports only.** A default export makes a symbol harder to grep and lets
two call sites give it different names.

**`noUncheckedIndexedAccess` is on.** `array[0]` is `T | undefined`. Handle it;
do not `!` it away without a reason worth writing down.

**Never validate with a cast.** `as Foo` on an API payload is a lie the type
system will believe. Parse it.

## Database changes

```bash
# 1. Edit packages/db/prisma/schema.prisma
# 2. Create and apply the migration
npm run db:migrate -- --name add_something_useful
# 3. The Prisma client regenerates automatically; typecheck to see the fallout
npm run typecheck
```

Rules that come from the data model (see
[ARCHITECTURE.md](ARCHITECTURE.md#data-model)):

- **Append-only.** New observations are inserted with an `observedAt`, never
  updated in place. The only pruned table is `MarketSnapshot`.
- **Index every filter.** If the UI can filter on a column, the column is
  indexed. Partial indexes for queue-shaped queries (`WHERE enrichedAt IS NULL`)
  keep "find work to do" cheap regardless of table size.
- **Raw SQL for what Prisma cannot express** — `vector` columns, the `<=>`
  operator, `ts_rank`, `date_bin`, `percentile_cont` — parameterised, in a
  repository, never in a route.
- **Cursor pagination.** Keyset, not `OFFSET`.

### Changing embedding dimensions

The pgvector column is dimension-typed, so `EMBEDDING_DIMENSIONS` cannot change
on its own. To move from 768 to 1024:

```sql
-- 1. Widen the column and drop the index built for the old width
DROP INDEX IF EXISTS "EventEmbedding_vector_hnsw_idx";
ALTER TABLE "EventEmbedding" ALTER COLUMN "vector" TYPE vector(1024);

-- 2. Existing vectors are the wrong width and cannot be converted — discard them
TRUNCATE "EventEmbedding";

-- 3. Rebuild the index
CREATE INDEX "EventEmbedding_vector_hnsw_idx" ON "EventEmbedding"
  USING hnsw ("vector" vector_cosine_ops);
```

Then set `EMBEDDING_DIMENSIONS=1024` and let the embedding worker re-embed;
`listMissingEmbeddings` will pick everything up, most important first. Semantic
search degrades to keyword-only until it catches up.

## Adding a configuration option

1. Add it to `envSchema` in `packages/platform/src/env.ts` with a default that
   keeps existing installs working.
2. Document it in `.env.example` — including _why_ someone would change it.
3. Read it from `env`, never from `process.env`, so the validated value is the
   only value.
4. If it is a secret, confirm `redactEnv` covers it (it iterates the schema, so
   it should automatically).

## Debugging

```bash
LOG_LEVEL=debug npm run dev:worker          # every connector run, hit/miss, backoff
curl -s localhost:3000/api/health | jq      # per-dependency verdict + ingestion lag
curl -s localhost:3000/api/metrics          # counters, histograms, breaker state
npm run db:studio                           # browse the data
```

Useful queries when something looks wrong:

```sql
-- Which connectors are failing, and why?
SELECT "connectorKey", status, count(*), max(error) AS last_error
FROM "CollectorRun" WHERE "startedAt" > now() - interval '1 hour'
GROUP BY 1, 2 ORDER BY 3 DESC;

-- Is enrichment keeping up?
SELECT count(*) FILTER (WHERE "enrichedAt" IS NULL) AS pending, count(*) AS total
FROM "Event" WHERE "occurredAt" > now() - interval '1 day';

-- Ingestion lag, by source
SELECT s.name, percentile_cont(0.95) WITHIN GROUP (
         ORDER BY extract(epoch FROM e."ingestedAt" - e."occurredAt")) AS p95_seconds
FROM "Event" e JOIN "Source" s ON s.id = e."sourceId"
WHERE e."occurredAt" > now() - interval '1 hour'
GROUP BY 1 ORDER BY 2 DESC;
```

## Pitfalls

**Workspace scripts run with the package as cwd.** A script that reads the root
`.env` must resolve it explicitly — the seed and both app entrypoints do. Adding
a new entrypoint means doing the same.

**Next.js hot-reloads modules.** Anything holding a connection pool must be
stashed on `globalThis`, or you exhaust Postgres' connection limit within minutes
of editing. See `apps/web/src/server/container.ts`.

**Shared packages use `.js` specifiers.** That is correct for Node ESM and
required by the worker. Webpack needs `resolve.extensionAlias` to follow them;
do not "fix" it by stripping the extensions.

**One HTTP client per connector.** The circuit breaker and rate limiter are keyed
on the client's provider string. A shared client means one dead feed opens the
circuit for everything.

**Do not let the LLM own a number.** Scores are computed by tested functions in
`@cid/core`. The model contributes prose and one weighted opinion. See
[ADR-008](DECISIONS.md#adr-008--deterministic-code-owns-the-scores-the-llm-is-one-input).

## Pull requests

- `npm run verify` passes, and any new behaviour has a test that would fail
  without it.
- Comments explain the non-obvious decisions, not the syntax.
- New config is documented in `.env.example`.
- A departure from a documented decision updates `docs/DECISIONS.md` rather than
  leaving the record wrong.
