# Crypto Intelligence Dashboard

A real-time cryptocurrency intelligence platform. It continuously monitors the
coins you choose across market, news, social, on-chain, development and
governance sources, normalises everything into one timeline, scores it, and lets
you ask questions about it in plain English.

Think Bloomberg Terminal for individual crypto assets, running entirely on your
own machine against your own API keys and your own local LLM.

```
┌─ CID ── Crypto Intelligence Terminal ──────────────────── 20/21 sources ● LIVE ─┐
│ WATCHLIST · 6      $2.54T │ Filter…            [All] [40+] [65+] [85+]         │
│ ★ BTC  $89,948.29  -0.11% │ 2026-07-25                                          │
│ ★ ETH   $2,930.88  +3.22% │ ▍2h  CRO  Binance lists Cronos (CRO) for spot…      │
│   SOL     $180.15  +1.94% │      [Listing] [Very bullish] [High]  CoinDesk      │
│   CRO      $0.1279 +2.96% │ ▍6h  ETH  Ethereum devs delay the Pectra upgrade    │
│   LINK     $22.22  +3.26% │      [Dev] [Bearish] [Medium]  The Block           │
└───────────────────────────┴─────────────────────────────────────────────────────┘
```

## What it does

- **Tracks any coin.** Search by name, ticker, contract address, CoinGecko id or
  chain-qualified address (`ethereum:0x514910…`). EVM, Solana, Cosmos and
  Bitcoin-ecosystem assets. Watchlists, pinning, portfolios and tags.
- **Ingests from ~20 sources** on independent cadences — prices every 10s, news
  and social every 60s — through a modular connector system. **Runs with zero
  API keys**; key-gated sources report themselves as disabled with the exact
  missing variable named.
- **Scores every event** for sentiment (5 levels), importance (1–100),
  confidence (1–100) and market impact (low → critical), using deterministic
  tested code with a local LLM as one weighted input.
- **Explains what happened.** Ask "Why is CRO pumping today?" and get an answer
  built from your own database, with citations back to the source events.
- **Alerts** on 14 rule types — price moves, new exchange listings, whale
  transfers, token unlocks, GitHub releases, governance proposals, sentiment
  shifts, breaking news — to desktop, Discord, Telegram, email or a webhook.
- **Charts** price, volume, market cap, news frequency, sentiment, whale flows,
  developer activity, funding rates and open interest.
- **Generates briefings** hourly, each morning, weekly and monthly.

Everything degrades gracefully: with `LLM_PROVIDER=null` you still get ingestion,
deterministic scoring, alerts, charts, search and reports — you lose only the
generated prose.

## Quick start

Requires Docker, or Node 22 + Postgres 16 with pgvector + Redis 7.

```bash
git clone <this repo> && cd Cryptodashboard
cp .env.example .env          # works as-is; add keys later

docker compose up -d          # postgres, redis, migrations, web, worker
open http://localhost:3000
```

Add a local model (optional, ~5 GB):

```bash
docker compose --profile ai up -d ollama
docker compose exec ollama ollama pull llama3.1:8b-instruct-q4_K_M
docker compose exec ollama ollama pull nomic-embed-text
docker compose restart worker web
```

### Without Docker

```bash
npm install
docker compose up -d postgres redis    # or your own Postgres/Redis

npm run db:migrate                     # create the schema
npm run db:seed                        # sample coins + events, optional
npm run dev                            # web on :3000, worker alongside
```

Postgres **must** have the `pgvector` extension available; semantic search
depends on it and the first migration will fail without it. The
`pgvector/pgvector:pg16` image used by compose has it built in.

## How it fits together

```
                  ┌──────────────┐
   ~20 providers ─▶│ @cid/        │  self-describing connectors: cadence,
                  │ connectors   │  rate limit, credential requirements
                  └──────┬───────┘
                         │ EventDraft + typed records
                  ┌──────▼───────┐
                  │ @cid/worker  │  independent per-connector schedules,
                  │              │  ingestion, enrichment, alerts, reports
                  └──────┬───────┘
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
  ┌───────────┐   ┌─────────────┐   ┌──────────┐
  │ Postgres  │   │  @cid/ai    │   │  Redis   │
  │ +pgvector │   │ local LLM   │   │ cache /  │
  └─────┬─────┘   └─────────────┘   │ pub-sub  │
        │                            └────┬─────┘
        │         ┌──────────────┐        │
        └────────▶│  apps/web    │◀───────┘  SSE to the browser
                  │  Next.js 15  │
                  └──────────────┘
```

Six packages, layered so dependencies only point inward:

| Package           | Role                                                                               |
| ----------------- | ---------------------------------------------------------------------------------- |
| `@cid/core`       | Domain model, ports, pure scoring. No I/O, no framework, no `node:` imports.       |
| `@cid/platform`   | Config, logging, DI, resilient HTTP, cache, rate limits, circuit breaker, metrics. |
| `@cid/db`         | Prisma schema and repository implementations of the core ports.                    |
| `@cid/connectors` | One pluggable connector per source.                                                |
| `@cid/ai`         | LLM providers, enrichment, embeddings, RAG agent, reports.                         |
| `@cid/worker`     | Scheduler, ingestion, alert runtime, cron reports.                                 |
| `apps/web`        | Next.js dashboard and typed API.                                                   |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the reasoning, and
[docs/DECISIONS.md](docs/DECISIONS.md) for the notable trade-offs (why not
BullMQ for polling, why HNSW over IVFFlat, why the LLM does not own the scores).

## Documentation

| Document                                | Contents                                       |
| --------------------------------------- | ---------------------------------------------- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layers, data model, event pipeline, scaling    |
| [INSTALLATION.md](docs/INSTALLATION.md) | Detailed setup, local models, API keys         |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md)     | Docker, production config, backups, monitoring |
| [API.md](docs/API.md)                   | Every endpoint, with examples                  |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md)   | Workflow, testing, migrations, conventions     |
| [EXTENDING.md](docs/EXTENDING.md)       | Adding a connector, an alert rule, a notifier  |
| [DECISIONS.md](docs/DECISIONS.md)       | Architecture decision records                  |

## Testing

```bash
npm test                  # 765 unit tests, hermetic — no network, no database
npm run test:integration  # 101 tests against real Postgres + pgvector
npm run test:e2e          # 16 Playwright tests against a production build
npm run verify            # format + lint + typecheck + unit
```

Integration tests **truncate every table**, so they refuse to run unless
`TEST_DATABASE_URL` is set or `DATABASE_URL` names a database containing
`test`/`ci`/`e2e`. That guard exists because the harness once wiped a working
database.

## Configuration

Every option is documented in [`.env.example`](.env.example). The only required
values are `DATABASE_URL` and `REDIS_URL`; config is validated once at startup
and the process refuses to run with an invalid combination.

Keys are all optional. Adding them widens coverage:

| Variable                                                 | Effect                                                   |
| -------------------------------------------------------- | -------------------------------------------------------- |
| `COINGECKO_API_KEY`                                      | Raises the price rate limit; recommended above ~50 coins |
| `GITHUB_TOKEN`                                           | 60 → 5,000 req/h, so more repos can be tracked           |
| `ETHERSCAN_API_KEY`                                      | Enables whale/on-chain tracking across 50+ EVM chains    |
| `X_BEARER_TOKEN`                                         | Enables the X/Twitter connector                          |
| `DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`, `SMTP_HOST` | Alert delivery                                           |

## Keyboard shortcuts

| Key                   | Action                                    |
| --------------------- | ----------------------------------------- |
| `⌘K` / `Ctrl+K` / `/` | Command palette — search and add any coin |
| `a`                   | Toggle the AI research pane               |
| `r`                   | Refresh the timeline                      |
| `Esc`                 | Close overlays, clear selection           |

## Status and limitations

Built and verified end to end: the worker boots and schedules 20 connectors, the
web app builds and serves live data, and 882 tests pass across three suites.

Things to know before relying on it:

- **Single-tenant.** It assumes one local user. The `userId` column exists on
  every user-owned table, so adding auth is an auth change, not a migration.
- **Read-only against exchanges.** No API key with trading permission is ever
  used, and no private endpoint is ever called.
- **Connector coverage is uneven.** The keyless sources (CoinGecko, Binance
  public, DexScreener, DefiLlama, 12 RSS feeds, Reddit, Snapshot, GitHub) are
  implemented and tested. Arkham, Nansen, Dune, Glassnode, Santiment,
  IntoTheBlock, X, Farcaster, Lens, YouTube and Telegram/Discord ingestion are
  **declared but not implemented** — the connector SDK and registry are built for
  them, and [EXTENDING.md](docs/EXTENDING.md) shows the ~100 lines each needs.
- **Not financial advice.** It aggregates and scores public information.

## License

MIT
