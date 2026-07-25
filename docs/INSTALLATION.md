# Installation

Two paths: Docker (everything managed) or native (Node plus your own Postgres and
Redis). Both end with the dashboard on <http://localhost:3000>.

For production hardening, backups and monitoring, see
[DEPLOYMENT.md](DEPLOYMENT.md).

## Requirements

|          | Minimum                     | Comfortable             |
| -------- | --------------------------- | ----------------------- |
| CPU      | 2 cores                     | 4+ cores                |
| RAM      | 4 GB (no local model)       | 16 GB with an 8B model  |
| Disk     | 5 GB                        | 50 GB + ~5 GB per model |
| Node     | 22 LTS (`>=20.11` enforced) | 22 LTS                  |
| Postgres | 16 **with pgvector**        | 16 with pgvector        |
| Redis    | 7                           | 7                       |

Postgres **must** have the `pgvector` extension available. The first migration
creates it and will fail without it. `pg_trgm` ships with Postgres itself.

A local LLM is optional. Everything except generated prose works with
`LLM_PROVIDER=null`.

## Path A — Docker

```bash
git clone <this repo> && cd Cryptodashboard
cp .env.example .env
docker compose up -d
```

That starts five things in order: Postgres (pgvector image), Redis, a one-shot
migration container, then the web app and the worker. Both app services wait for
migrations to complete, so neither ever starts against an un-migrated schema.

```bash
docker compose ps                       # all healthy?
curl -s localhost:3000/api/health | jq  # dependency-by-dependency verdict
docker compose logs -f worker           # watch collection start
open http://localhost:3000
```

### Sample data

An empty install shows an empty timeline until the first collection cycle
completes (~1 minute). To see the UI populated immediately:

```bash
docker compose exec web npm run db:seed
```

The seed adds 15 sources, 6 coins, 7 days of 30-minute price history, 8 scored
events and 1 alert. It is idempotent and safe to re-run.

### Overriding ports

Compose reads these from `.env`: `WEB_PORT`, `POSTGRES_PORT`, `REDIS_PORT`,
`OLLAMA_PORT`, plus `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB`.

## Path B — Native

```bash
git clone <this repo> && cd Cryptodashboard
npm install
cp .env.example .env
```

Provide Postgres and Redis. Easiest is to borrow just the datastores from
compose:

```bash
docker compose up -d postgres redis
```

Or use your own — then create the database and enable the extensions:

```sql
CREATE DATABASE cid;
\c cid
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

Point `DATABASE_URL` and `REDIS_URL` at them, then:

```bash
npm run db:migrate     # apply migrations (creates the extensions too)
npm run db:seed        # optional sample data
npm run dev            # web on :3000 and the worker, concurrently
```

`npm run dev` runs both processes with labelled, colour-coded output. To run them
separately:

```bash
npm run dev:web
npm run dev:worker
```

### Installing pgvector on a self-managed Postgres

```bash
# Debian/Ubuntu
sudo apt-get install -y postgresql-16-pgvector

# macOS (Homebrew)
brew install pgvector

# From source
git clone --branch v0.8.0 https://github.com/pgvector/pgvector.git
cd pgvector && make && sudo make install
```

Managed Postgres: RDS, Cloud SQL, Azure Flexible Server, Supabase and Neon all
support pgvector — enable it in the parameter group or extension list.

## Adding a local model

The AI layer speaks to any OpenAI-compatible server, plus Ollama's native API.

### Ollama (recommended)

```bash
# Native install
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.1:8b-instruct-q4_K_M   # ~4.7 GB, the chat model
ollama pull nomic-embed-text              # ~275 MB, embeddings
```

```env
LLM_PROVIDER=ollama
LLM_BASE_URL=http://localhost:11434
LLM_MODEL=llama3.1:8b-instruct-q4_K_M
EMBEDDING_PROVIDER=ollama
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_DIMENSIONS=768
```

Ollama is the default because its native `/api/chat` supports
grammar-constrained JSON decoding via `format`, which raises structured-output
reliability from "usually" to "effectively always" on small models — see
[ADR-016](DECISIONS.md#adr-016--ollamas-native-api-for-constrained-json).

Under Docker, run it in the `ai` profile:

```bash
docker compose --profile ai up -d ollama
docker compose exec ollama ollama pull llama3.1:8b-instruct-q4_K_M
docker compose exec ollama ollama pull nomic-embed-text
docker compose restart worker web
```

Compose already points `LLM_BASE_URL` at `http://ollama:11434` inside the
network. If you run Ollama on the _host_ while the app runs in Docker, use
`http://host.docker.internal:11434` (Docker Desktop) or the host's bridge IP on
Linux.

### LM Studio

Start its server (default port 1234), then:

```env
LLM_PROVIDER=lmstudio
LLM_BASE_URL=http://localhost:1234/v1
LLM_MODEL=llama-3.1-8b-instruct
LLM_API_KEY=              # only if you enabled auth
```

### llama.cpp

```bash
llama-server -m ./models/llama-3.1-8b-instruct-Q4_K_M.gguf -c 8192 --port 8080
```

```env
LLM_PROVIDER=llamacpp
LLM_BASE_URL=http://localhost:8080/v1
LLM_MODEL=local
```

### vLLM

```bash
vllm serve meta-llama/Meta-Llama-3.1-8B-Instruct --port 8000
```

```env
LLM_PROVIDER=vllm
LLM_BASE_URL=http://localhost:8000/v1
LLM_MODEL=meta-llama/Meta-Llama-3.1-8B-Instruct
LLM_CONCURRENCY=8      # vLLM batches well; raise this
```

### Any other OpenAI-compatible server

`LLM_PROVIDER=openai-compatible` with `LLM_BASE_URL` pointing at the `/v1` root.
Works with LiteLLM proxies, text-generation-webui and similar.

### Choosing a model

| Model                         | Size   | Verdict                                              |
| ----------------------------- | ------ | ---------------------------------------------------- |
| `llama3.1:8b-instruct-q4_K_M` | 4.7 GB | The default. Good summaries, reliable JSON.          |
| `qwen2.5:14b-instruct-q4_K_M` | 9 GB   | Noticeably better explanations if you have the VRAM. |
| `mistral-nemo:12b-instruct`   | 7 GB   | Strong at concise summarisation.                     |
| `llama3.2:3b-instruct-q4_K_M` | 2 GB   | Works on a laptop; summaries get thin.               |
| `phi4:14b`                    | 9 GB   | Good reasoning, more verbose than the prompt asks.   |

Embeddings: `nomic-embed-text` (768 dims) is the default.
`mxbai-embed-large` (1024) is slightly better and needs
`EMBEDDING_DIMENSIONS=1024` **plus a migration** — the pgvector column is
dimension-typed. See
[DEVELOPMENT.md](DEVELOPMENT.md#changing-embedding-dimensions).

### Running without a model

```env
LLM_PROVIDER=null
EMBEDDING_PROVIDER=null
```

You keep ingestion, deterministic sentiment/importance/impact scoring, alerts,
charts, keyword search and the timeline. You lose generated summaries,
explanations, narrative detection, reports and semantic search. `/api/ask` still
returns cited evidence, with a note that no model is configured.

## API keys

Everything is optional; each one widens coverage. Key-gated connectors report
themselves disabled and name the exact missing variable rather than failing
silently.

| Variable                                                             | Cost           | What it unlocks                                                                                                  |
| -------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `COINGECKO_API_KEY`                                                  | Free demo tier | Raises the rate limit from ~30/min. Recommended above ~50 tracked coins. Set `COINGECKO_API_TIER=demo` or `pro`. |
| `GITHUB_TOKEN`                                                       | Free           | 60 → 5,000 req/h, so many more repos can be tracked. A classic PAT with `public_repo` is enough.                 |
| `ETHERSCAN_API_KEY`                                                  | Free           | Enables whale tracking, treasury monitoring and on-chain events. One V2 key covers 50+ EVM chains.               |
| `COINMARKETCAP_API_KEY`                                              | Free tier      | Cross-check for market data and CMC ids.                                                                         |
| `REDDIT_CLIENT_ID` / `_SECRET`                                       | Free           | Reddit works keyless but is aggressively throttled; an OAuth app raises limits substantially.                    |
| `X_BEARER_TOKEN`                                                     | Paid           | The X/Twitter connector. Scraping is deliberately not implemented.                                               |
| `SOLSCAN_API_KEY`                                                    | Free tier      | Solana on-chain data.                                                                                            |
| `ARKHAM`, `NANSEN`, `DUNE`, `GLASSNODE`, `SANTIMENT`, `INTOTHEBLOCK` | Mostly paid    | Reserved for connectors that are declared but not yet implemented. Setting them has no effect today.             |

CEX market data (Binance, Coinbase, Kraken, Bybit, OKX, KuCoin, MEXC,
Hyperliquid) needs no keys — the platform only calls public read endpoints and
never a private or trading one.

### Notification channels

| Channel  | Setup                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------- |
| Desktop  | Nothing — browser notifications, granted on first alert                                                 |
| Discord  | `DISCORD_WEBHOOK_URL` from Server Settings → Integrations → Webhooks                                    |
| Telegram | `TELEGRAM_BOT_TOKEN` from @BotFather, plus `TELEGRAM_CHAT_ID` (message the bot, then read `getUpdates`) |
| Email    | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`                                     |
| Webhook  | `GENERIC_WEBHOOK_URL` — receives a JSON POST per firing                                                 |

## First run

1. Open <http://localhost:3000>. The header shows `n/m sources` and a live badge.
2. Press `⌘K` (or `/`) and add a coin — by name, ticker, CoinGecko id, or a
   chain-qualified contract like `ethereum:0x514910771af9ca656af840dff83e8264ecf986ca`.
3. Wait one collection cycle. Prices land in ~10s, news and social within ~60s.
4. Check `/api/health` — `ingestion.lagP95Ms` is the number that says whether
   collection is keeping up.
5. Press `a` to open the research pane and ask something.

## Verifying the install

```bash
npm run verify              # format + lint + typecheck + 413 unit tests
npm run test:integration    # 101 tests; needs TEST_DATABASE_URL (see below)
npm run test:e2e            # 15 Playwright tests against a production build
```

Integration tests **truncate every table**. They refuse to run unless
`TEST_DATABASE_URL` is set, or `DATABASE_URL` names a database containing
`test`, `ci` or `e2e`; otherwise they skip with a warning. Create the test
database once:

```bash
createdb cid_test
psql cid_test -c 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;'
TEST_DATABASE_URL=postgresql://cid:cid@localhost:5432/cid_test?schema=public \
  npx prisma migrate deploy --schema packages/db/prisma/schema.prisma
```

## Troubleshooting

**`type "vector" does not exist`** — pgvector is not installed in that Postgres
instance. See above; the `pgvector/pgvector:pg16` image has it built in.

**Config validation fails at startup** — the error names every missing or
malformed variable. Only `DATABASE_URL` and `REDIS_URL` are required.

**`Environment variable not found: DATABASE_URL` from a workspace script** —
npm workspace scripts run with the _package_ as the working directory. The seed
and the app both load the root `.env` explicitly; a custom script may not.

**Timeline stays empty** — check `docker compose logs worker`. Likely
`INGESTION_ENABLED=false`, or every connector disabled for missing keys (the boot
log lists which), or no coins tracked yet.

**Prices update but nothing has a summary** — the model is unreachable.
`/api/health` reports the `llm` check with the provider and model it tried. A
backlog is normal at first: enrichment is intentionally asynchronous.

**`ECONNREFUSED 127.0.0.1:11434` from inside Docker** — the container's
localhost is not the host's. Use `http://ollama:11434` (compose) or
`http://host.docker.internal:11434`.

**Everything is slow with a model configured** — lower `LLM_CONCURRENCY` to 1.
A single-GPU box serialises anyway, and parallel requests only add queueing
latency.

**Rate-limit errors from a provider** — raise the relevant `INTERVAL_*_MS`, lower
`MAX_TRACKED_COINS`, or add the provider's API key. The circuit breaker will have
already backed off; this only removes the noise.
