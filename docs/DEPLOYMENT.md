# Deployment

Running this beyond a laptop. It is a single-tenant application by design — see
[the note on multi-tenancy](#multi-tenancy) before exposing it to more than
yourself.

## Topology

Four processes, plus an optional model server:

```
              ┌──────────────────┐
   browser ──▶│  reverse proxy   │  TLS, SSE-friendly buffering off
              └────────┬─────────┘
                       │
              ┌────────▼─────────┐        ┌──────────────────┐
              │  web (Next.js)   │        │  worker (Node)   │
              │  stateless, N≥1  │        │  singleton, N=1  │
              └───┬──────────┬───┘        └───┬──────────┬───┘
                  │          │                │          │
         ┌────────▼──┐   ┌───▼────────────────▼───┐  ┌───▼──────────┐
         │ Postgres  │   │        Redis           │  │ model server │
         │ +pgvector │   │ cache / limits / pubsub│  │  (optional)  │
         └───────────┘   └────────────────────────┘  └──────────────┘
```

- **web** is stateless. Scale horizontally behind any load balancer; no sticky
  sessions are needed (SSE reconnects carry no server-side state).
- **worker** should stay at one replica. It is _safe_ to scale — alert claims are
  atomic and rate limits live in Redis — but more replicas multiply provider
  requests without adding coverage. Scale it by adding connectors, not copies.
- **Redis is disposable.** It holds only cache entries, rate-limit buckets and
  pub/sub. Losing it costs a cold cache. Persistence is disabled in the shipped
  compose file for exactly that reason.
- **Postgres is the only stateful component.** Back it up.

## Docker Compose (single host)

The shipped `docker-compose.yml` is production-usable on one host.

```bash
git clone <repo> && cd Cryptodashboard
cp .env.example .env
$EDITOR .env
docker compose up -d --build
docker compose logs -f
```

Before exposing it, change from the development defaults:

```env
NODE_ENV=production
LOG_FORMAT=json                       # structured, for log shipping
POSTGRES_PASSWORD=<long random>
DATABASE_URL=postgresql://cid:<same>@postgres:5432/cid?schema=public
INTERNAL_API_TOKEN=<openssl rand -hex 32>
CORS_ALLOWED_ORIGINS=https://cid.example.com
NEXT_PUBLIC_APP_URL=https://cid.example.com
RATE_LIMIT_RPM=120
```

Then stop publishing the datastore ports on the host. Add an override file:

```yaml
# docker-compose.override.yml
services:
  postgres:
    ports: !reset []
  redis:
    ports: !reset []
  web:
    ports:
      - '127.0.0.1:3000:3000' # only the reverse proxy reaches it
```

### Image layout

`docker/Dockerfile` has four targets:

| Target    | Purpose                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------ |
| `deps`    | `npm ci --ignore-scripts` over the manifests only, so the install layer caches until a dependency actually changes |
| `runtime` | `deps` + source + a generated Prisma client. Used by the one-shot `migrate` service                                |
| `web`     | `runtime` + `next build`, runs as `node`                                                                           |
| `worker`  | `runtime`, runs the worker via `tsx`, as `node`                                                                    |

Both app targets share `runtime` deliberately: they import the same five
workspace packages, so splitting them would duplicate ~90% of the image for no
isolation benefit. The worker has no bundling step — it is a long-lived process
where start-up time is irrelevant, and running the real source keeps stack traces
pointing at files you can open.

The `web` target sets a dummy build-time `DATABASE_URL` because `next build`
evaluates route modules, which construct the Prisma client. It is never connected
to; the real value arrives from the environment at run time.

## Migrations

Compose runs a one-shot `migrate` service that both app services wait on
(`condition: service_completed_successfully`), so neither can start against an
un-migrated schema.

Elsewhere, run before rolling out new code:

```bash
npm run db:migrate:deploy   # prisma migrate deploy — never `dev` in production
```

`migrate deploy` applies pending migrations and nothing else. It never resets,
never generates, and never prompts. Migrations so far are additive, so a rolling
deploy is safe; if you ever add a destructive one, expand-then-contract across two
releases.

## Reverse proxy

The one requirement that is easy to get wrong: **do not buffer SSE**. The app
sets `x-accel-buffering: no`, which nginx honours, but check your proxy.

### nginx

```nginx
server {
  listen 443 ssl http2;
  server_name cid.example.com;

  ssl_certificate     /etc/letsencrypt/live/cid.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/cid.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # The event stream: no buffering, no timeout.
  location /api/stream {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 24h;
    chunked_transfer_encoding off;
  }
}
```

`X-Forwarded-For` matters: per-IP rate limiting reads it, and without it every
request appears to come from the proxy and shares one bucket.

### Caddy

```
cid.example.com {
  reverse_proxy 127.0.0.1:3000 {
    flush_interval -1        # disable buffering, required for SSE
  }
}
```

### Cloudflare

Proxied SSE works, but the 100-second inactivity timeout applies. The 20-second
heartbeat keeps the connection alive, so this is fine — do not disable it.

## Kubernetes sketch

No manifests are shipped (they would encode opinions about your cluster), but the
shape is:

- `Deployment` web, `replicas: 2+`, readiness probe `GET /api/health`, liveness on
  the same path with a longer period. The endpoint always returns 200 — read
  `status` if you want a strict readiness gate, or accept "degraded" as ready,
  which is usually right since a model outage should not pull the app from
  rotation.
- `Deployment` worker, `replicas: 1`, `strategy: Recreate`. No probe path (it
  serves no HTTP); use a `livenessProbe` exec on process presence or rely on
  restart-on-crash.
- `Job` per release running `npm run db:migrate:deploy`, as a Helm pre-install /
  pre-upgrade hook.
- `Secret` for `DATABASE_URL`, `REDIS_URL`, `INTERNAL_API_TOKEN` and provider
  keys; `ConfigMap` for cadences and limits.
- Postgres: a managed instance with pgvector enabled, or an operator (CNPG) with
  the extension available.

Give the worker a real memory limit — 1 GB is comfortable — and remember the model
server, if colocated, wants a GPU node and far more.

## Resource sizing

At 500 tracked coins with an 8B model:

| Component     | CPU        | RAM                    | Notes                          |
| ------------- | ---------- | ---------------------- | ------------------------------ |
| web           | 0.5–1 core | 512 MB–1 GB            | Spikes on chart queries        |
| worker        | 1–2 cores  | 512 MB–1 GB            | Mostly waiting on I/O          |
| Postgres      | 2 cores    | 4 GB                   | `shared_buffers` 25% of RAM    |
| Redis         | 0.2 core   | 256 MB                 | `maxmemory-policy allkeys-lru` |
| Model (8B q4) | —          | 8 GB VRAM or 12 GB RAM | The real cost                  |

Disk growth, dominated by `MarketSnapshot` at 10-second ticks:

| Coins | Per day | 90-day window |
| ----- | ------- | ------------- |
| 50    | ~120 MB | ~11 GB        |
| 200   | ~480 MB | ~43 GB        |
| 500   | ~1.2 GB | ~105 GB       |

`MARKET_SNAPSHOT_RETENTION_DAYS` (default 90) bounds it; the nightly retention
cron prunes raw snapshots and telemetry only. Candle rollups, events, news,
on-chain and governance history are never pruned — raise `INTERVAL_MARKET_MS` if
that growth is too fast for your disk.

## Tuning Postgres

```conf
shared_buffers = 4GB               # ~25% of RAM
effective_cache_size = 12GB        # ~75%
work_mem = 32MB                    # bumps sort-heavy analytics queries
maintenance_work_mem = 1GB         # HNSW index builds
max_connections = 100
random_page_cost = 1.1             # SSD
```

For HNSW specifically, `maintenance_work_mem` is what makes index builds finish in
minutes rather than hours. Autovacuum defaults are fine for append-only tables,
but consider a more aggressive `autovacuum_vacuum_scale_factor` on
`MarketSnapshot` since retention deletes create bloat there.

## Backups

Postgres is the only thing worth backing up.

```bash
# Nightly logical dump
docker compose exec -T postgres pg_dump -U cid -Fc cid > "cid-$(date +%F).dump"

# Restore
docker compose exec -T postgres pg_restore -U cid -d cid --clean --if-exists < cid-2026-07-25.dump
```

For anything you would be upset to lose, use continuous archiving (WAL-G,
pgBackRest) rather than nightly dumps — logical dumps of a 100 GB append-only
database get slow and lose everything since the last run.

Test restores. An untested backup is a hypothesis.

You do **not** need to back up Redis, and you do not need to back up the model
weights (they are re-pullable).

## Monitoring

### Prometheus

```yaml
scrape_configs:
  - job_name: cid-web
    metrics_path: /api/metrics
    static_configs:
      - targets: ['web:3000']
```

`/api/metrics` reports the **web** process's registry. The worker keeps its own
in-process counters but exposes no HTTP endpoint, so its collection telemetry is
read from the database instead: `CollectorRun` holds per-run status, duration,
items fetched and errors, and `/api/health` summarises it as connector health
plus ingestion-lag percentiles. Alert on the health endpoint for anything
ingestion-related, and on `/api/metrics` for request-path behaviour.

### Alerts worth having

| Condition                                           | Why                                           |
| --------------------------------------------------- | --------------------------------------------- |
| `/api/health` `status != "ok"` for 5 min            | Something is degraded                         |
| `ingestion.lagP95Ms > 300000`                       | Collection is falling behind                  |
| Any connector in `ingestion.failing` for 30 min     | A provider changed or a key expired           |
| `cid_circuit_breaker_state{state="open"}` sustained | A provider is down or you are being throttled |
| Enrichment backlog growing over hours               | The model cannot keep up — use a smaller one  |
| Postgres disk >80%                                  | Retention is not keeping pace                 |

### Logs

Set `LOG_FORMAT=json` in production. Every line carries a `component` and, in the
worker, the connector key — so `component=scheduler connector=coindesk` isolates
one source's history. Logs are pino JSON, ready for Loki, CloudWatch or anything
else that reads NDJSON.

`redactEnv` guarantees no secret reaches a log line, present or absent, because it
iterates the config _schema_ rather than the parsed object.

## Security checklist

- [ ] TLS terminated at the proxy; HTTP redirects to HTTPS
- [ ] Postgres and Redis not published on a public interface
- [ ] Strong `POSTGRES_PASSWORD`; Redis reachable only on the internal network
      (`requirepass` if it is not)
- [ ] `INTERNAL_API_TOKEN` set to 32 random bytes — internal routes fail closed
      when it is unset, so leaving it blank denies rather than allows
- [ ] `CORS_ALLOWED_ORIGINS` set to your real origin, not `*`
- [ ] `RATE_LIMIT_RPM` tuned, and `X-Forwarded-For` reaching the app
- [ ] Provider keys read-only. Never issue an exchange key with trading or
      withdrawal permission: the platform calls no private endpoint and cannot
      use one
- [ ] Authentication in front of the app if it is reachable from the internet —
      see below
- [ ] `NODE_ENV=production`, so error responses stay generic

## Multi-tenancy

There is none. The app assumes one local user and has no login. Every user-owned
table already carries `userId`, so adding authentication is an auth change rather
than a migration — but until you do it, anyone who can reach the port sees and
edits your watchlists and alerts.

If you expose it, put an authenticating proxy in front (oauth2-proxy,
Authelia, Cloudflare Access, or basic auth at the proxy). That is the intended
deployment for a single-tenant tool and takes minutes.

## Upgrading

```bash
git pull
docker compose build
docker compose run --rm migrate      # apply migrations first
docker compose up -d web worker
```

Rolling deploys are safe with additive migrations. Check `docs/DECISIONS.md` for
anything marked as requiring a data migration —
`EMBEDDING_DIMENSIONS` is the notable one: changing it needs a column change and
a re-embed, covered in
[DEVELOPMENT.md](DEVELOPMENT.md#changing-embedding-dimensions).

## Disaster recovery

What survives what:

| Lost         | Impact                                        | Recovery                                                                                                                                  |
| ------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Redis        | Cold cache, rate-limit buckets reset          | Restart it; nothing to restore                                                                                                            |
| Worker       | Collection stops; the UI still serves history | Restart. High-water marks in `ConnectorState` mean it resumes without gaps or duplicates                                                  |
| Web          | No UI or API; collection continues            | Restart                                                                                                                                   |
| Postgres     | Everything                                    | Restore from backup. Coverage between the backup and now is lost — providers mostly do not offer deep history, so the timeline has a hole |
| Model server | No new prose or embeddings                    | Restart. The enrichment backlog drains on its own; nothing is lost                                                                        |

The worker resuming cleanly is the property worth noting: because `since` comes
from `ConnectorState` rather than from wall-clock time, a restart after an hour of
downtime fetches the hour it missed rather than starting from now.
