# API reference

Twelve endpoints under `/api`, served by the Next.js App Router. Everything is
JSON except `/api/metrics` (Prometheus text) and the two SSE streams.

Base URL: `http://localhost:3000` by default.

## Conventions

**Timestamps** are ISO-8601 UTC strings on the wire.

**Errors** always take one shape:

```json
{
  "error": {
    "code": "VALIDATION",
    "message": "minImportance: Number must be less than or equal to 100"
  }
}
```

| Code           | Status | Meaning                                                           |
| -------------- | ------ | ----------------------------------------------------------------- |
| `VALIDATION`   | 400    | Query or body failed schema validation; `message` names the field |
| `UNSUPPORTED`  | 400    | Requested something the configuration does not support            |
| `UNAUTHORIZED` | 401    | Missing or wrong internal token                                   |
| `NOT_FOUND`    | 404    | No such resource                                                  |
| `CONFLICT`     | 409    | Uniqueness violation                                              |
| `RATE_LIMITED` | 429    | Per-IP limit exceeded (`RATE_LIMIT_RPM`)                          |
| `INTERNAL`     | 500    | Unexpected; details are logged, not returned                      |
| `CONFIG`       | 500    | Misconfiguration                                                  |
| `UPSTREAM`     | 502    | A provider failed                                                 |
| `CIRCUIT_OPEN` | 503    | A provider's breaker is open                                      |
| `TIMEOUT`      | 504    | Upstream exceeded its deadline                                    |

Unexpected throws never leak their message — an unhandled error can carry a
connection string, so the response is generic and the detail goes to the log.

**List parameters** are comma-separated _or_ repeated:
`?coinIds=btc,eth` and `?coinIds=btc&coinIds=eth` are equivalent.

**Pagination** is keyset, not offset. Pass the `nextCursor` from the previous
response as `cursor`; `null` means the end. Cursors are opaque — do not parse
them.

**Authentication** — none. The app is single-tenant and resolves a local user
server-side. Internal routes require `Authorization: Bearer $INTERNAL_API_TOKEN`
and **deny when the token is unset** rather than allowing.

---

## GET /api/timeline

The continuously-updating event feed. This is the endpoint the dashboard lives
on.

| Parameter       | Type           | Default | Notes                                                                                                                                            |
| --------------- | -------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `coinIds`       | list           | —       | Restrict to these coins                                                                                                                          |
| `categories`    | list           | —       | `MARKET`, `NEWS`, `SOCIAL`, `ONCHAIN`, `DEV`, `GOVERNANCE`, `TOKENOMICS`, `LISTING`, `SECURITY`, `REGULATORY`, `PARTNERSHIP`, `PRODUCT`, `OTHER` |
| `sourceKeys`    | list           | —       | Connector keys, e.g. `coindesk`, `github`                                                                                                        |
| `sentiments`    | list           | —       | `VERY_BULLISH`, `BULLISH`, `NEUTRAL`, `BEARISH`, `VERY_BEARISH`                                                                                  |
| `impacts`       | list           | —       | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`                                                                                                              |
| `minImportance` | int 1–100      | —       | Importance floor                                                                                                                                 |
| `from`, `to`    | ISO date       | —       | Occurrence window                                                                                                                                |
| `q`             | string 1–200   | —       | Full-text filter on headline and body                                                                                                            |
| `collapse`      | `true`/`false` | `true`  | Collapse duplicate clusters                                                                                                                      |
| `limit`         | int 1–200      | `50`    |                                                                                                                                                  |
| `cursor`        | string         | —       | From `nextCursor`                                                                                                                                |

Unknown enum members are a 400, not a silently empty result — a hand-edited URL
should tell you it is wrong.

```bash
curl -s 'localhost:3000/api/timeline?minImportance=70&categories=LISTING,SECURITY&limit=2' | jq
```

```json
{
  "items": [
    {
      "id": "clx8f2k1p0001",
      "occurredAt": "2026-07-25T09:14:00.000Z",
      "ingestedAt": "2026-07-25T09:14:38.412Z",
      "category": "LISTING",
      "subtype": "spot_listing",
      "headline": "Binance lists Cronos (CRO) for spot trading",
      "summary": "Binance will open CRO/USDT and CRO/BTC spot markets on 26 July…",
      "explanation": "Major-exchange listings expand accessible liquidity…",
      "url": "https://www.coindesk.com/markets/2026/07/25/binance-lists-cro",
      "author": "CoinDesk Staff",
      "importance": 88,
      "confidence": 82,
      "sentiment": "VERY_BULLISH",
      "sentimentScore": 0.78,
      "impact": "HIGH",
      "narratives": ["exchange-listings", "cro-ecosystem"],
      "isFud": false,
      "enriched": true,
      "source": { "key": "coindesk", "name": "CoinDesk", "credibility": 0.9 },
      "coin": { "id": "clx…", "symbol": "CRO", "name": "Cronos" },
      "duplicateCount": 4
    }
  ],
  "nextCursor": "eyJvIjoiMjAyNi0wNy0yNVQwOToxNDowMFoiLCJpIjoiY2x4OGYyazFwMDAwMSJ9"
}
```

`duplicateCount: 4` means four other outlets covered the same story; they are
clustered, not discarded. `?collapse=false` returns each one.

`summary`, `explanation` and `narratives` are `null`/`[]` until enrichment runs
(`enriched: false`). `importance`, `sentiment`, `confidence` and `impact` are
present from insertion, because deterministic code produces them — see
[ADR-008](DECISIONS.md#adr-008--deterministic-code-owns-the-scores-the-llm-is-one-input).

## GET /api/coins

The watchlist with live quotes.

| Parameter     | Type   | Notes                                    |
| ------------- | ------ | ---------------------------------------- |
| `watchlistId` | string | Defaults to the user's default watchlist |

```json
{
  "watchlistId": "clx…",
  "items": [
    {
      "id": "clx…",
      "slug": "bitcoin",
      "symbol": "BTC",
      "name": "Bitcoin",
      "imageUrl": "https://…",
      "chain": "bitcoin",
      "marketCapRank": 1,
      "isPinned": true,
      "position": 0,
      "tags": ["core"],
      "quote": {
        "priceUsd": 89948.29,
        "marketCapUsd": 1783000000000,
        "volume24hUsd": 24100000000,
        "change1hPct": 0.12,
        "change24hPct": -0.11,
        "change7dPct": 3.4,
        "observedAt": "2026-07-25T09:20:10.000Z"
      }
    }
  ]
}
```

`quote` is `null` for a coin added seconds ago, before the first price poll.

## POST /api/coins

Add a coin. Accepts anything the identifier parser understands: a name, a ticker,
a CoinGecko id, a bare contract address, or a chain-qualified address.

```bash
curl -sX POST localhost:3000/api/coins \
  -H 'content-type: application/json' \
  -d '{"query":"ethereum:0x514910771af9ca656af840dff83e8264ecf986ca"}'
```

```json
{
  "added": true,
  "coin": {
    "id": "clx…",
    "slug": "chainlink",
    "symbol": "LINK",
    "name": "Chainlink"
  }
}
```

Resolution order: the local database first (no network call for a coin already
known), then CoinGecko for discovery and metadata import. Not found:

```json
{ "added": false, "reason": "not_found" }
```

## DELETE /api/coins

`?coinId=<id>` — removes from the watchlist. It does **not** delete the coin or
its history: re-adding it later shows the full record, and portfolios or other
watchlists may still reference it.

## PATCH /api/coins

```json
{ "action": "pin", "coinId": "clx…", "pinned": true }
{ "action": "reorder", "coinIds": ["clx…", "clx…", "clx…"] }
```

## GET /api/coins/search

Powers the command palette.

| Parameter | Type           | Default | Notes                         |
| --------- | -------------- | ------- | ----------------------------- |
| `q`       | string 1–100   | —       | Name, symbol, slug or address |
| `remote`  | `true`/`false` | `true`  | Allow the upstream fallback   |

```json
{
  "results": [
    {
      "id": "clx…",
      "symbol": "BTC",
      "name": "Bitcoin",
      "score": 1,
      "matchedOn": "symbol",
      "tracked": true
    },
    {
      "id": "coingecko:bitcoin-cash",
      "symbol": "BCH",
      "name": "Bitcoin Cash",
      "score": 0.4,
      "matchedOn": "external-id",
      "tracked": false
    }
  ]
}
```

`tracked: false` entries are discovery results — the UI offers "add" rather than
"open". The upstream call only happens when fewer than 5 local hits are found and
`q` is at least 2 characters, so typing does not spend the provider's rate limit
per keystroke.

## GET /api/quotes

Latest prices. `?coinIds=` optional; defaults to all tracked coins.

```json
{
  "quotes": [
    {
      "coinId": "clx…",
      "priceUsd": 2930.88,
      "change24hPct": 3.22,
      "observedAt": "…"
    }
  ]
}
```

This exists alongside the SSE stream because a freshly-loaded page needs current
state immediately, while the stream only carries deltas from the moment it
connects.

## GET /api/chart/{coinId}

Every series the coin view plots, in one round trip so they stay time-aligned.

| Parameter | Type                            | Default | Notes                                             |
| --------- | ------------------------------- | ------- | ------------------------------------------------- |
| `range`   | `1h`\|`24h`\|`7d`\|`30d`\|`90d` | `24h`   |                                                   |
| `series`  | list                            | all     | `price`, `events`, `whales`, `dev`, `derivatives` |

```bash
curl -s 'localhost:3000/api/chart/clx…?range=7d&series=price,events' | jq
```

```json
{
  "range": "7d",
  "from": "2026-07-18T09:00:00.000Z",
  "to": "2026-07-25T09:00:00.000Z",
  "price": [
    {
      "t": "…",
      "price": 2871.4,
      "marketCap": 345e9,
      "volume": 12e9,
      "liquidity": 8.1e8
    }
  ],
  "events": [{ "t": "…", "count": 3, "sentiment": 0.42 }],
  "whales": [
    {
      "t": "…",
      "inflow": 4200000,
      "outflow": 9100000,
      "net": 4900000,
      "count": 6
    }
  ],
  "dev": [{ "t": "…", "commits": 41, "releases": 1, "pullRequests": 7 }],
  "derivatives": [
    {
      "t": "…",
      "instrument": "ETHUSDT",
      "fundingRate": 0.00012,
      "openInterestUsd": 1.4e9
    }
  ]
}
```

Bucket width scales with the range so each series returns ~200 points — more than
a 1440px chart can resolve. `events` and `whales` share the same bucket grid, so
they overlay cleanly on a price chart. `net` is outflow minus inflow: positive
means coins leaving tracked exchange wallets.

## GET /api/search

Hybrid semantic + keyword search over events.

| Parameter    | Type         | Default  |
| ------------ | ------------ | -------- |
| `q`          | string 2–300 | required |
| `coinIds`    | list         | —        |
| `from`, `to` | ISO date     | —        |
| `limit`      | int 1–50     | `20`     |

```bash
curl -s 'localhost:3000/api/search?q=whale%20transfers%20above%20a%20million' | jq
```

```json
{
  "results": [
    {
      "eventId": "clx…",
      "headline": "1,240 BTC moved from Binance to an unknown wallet",
      "sourceName": "Etherscan",
      "occurredAt": "…",
      "url": "https://…",
      "importance": 74
    }
  ]
}
```

Semantic and keyword scores are merged (semantic 0.6 / keyword 0.4). Without an
embedding model it silently degrades to keyword-only, which is why search works
with `LLM_PROVIDER=null`.

## POST /api/ask

The research console. Retrieval-augmented over the platform's own database — the
model is told to answer only from the retrieved events.

```json
{ "question": "Why is CRO pumping today?", "coinIds": ["clx…"], "stream": true }
```

`question` is 3–500 characters. `stream` defaults to `true`.

### Non-streaming (`stream: false`)

```bash
curl -sX POST localhost:3000/api/ask \
  -H 'content-type: application/json' \
  -d '{"question":"What happened with Binance?","stream":false}' | jq
```

```json
{
  "answer": "CRO is up 3% on a Binance spot listing announced this morning [1]…",
  "citations": [
    {
      "eventId": "clx…",
      "headline": "Binance lists Cronos (CRO) for spot trading",
      "sourceName": "CoinDesk",
      "occurredAt": "…",
      "url": "https://…"
    }
  ],
  "noEvidence": false,
  "model": "llama3.1:8b-instruct-q4_K_M"
}
```

Inline `[1]`, `[2]` markers index into `citations`, so every claim links back to
the event it came from. `noEvidence: true` means retrieval found nothing and the
model was never consulted — the answer says so rather than inventing one. With no
model configured you still get real citations plus a note that prose is
unavailable.

### Streaming (default)

`text/event-stream`. Citations arrive first so evidence renders while the prose is
still generating:

```
event: citations
data: {"citations":[…]}

event: token
data: {"token":"CRO"}

event: token
data: {"token":" is up"}

event: done
data: {}
```

An `error` event carries `{ "message": "…" }`.

## GET /api/stream

Server-Sent Events for live updates. No parameters.

```js
const stream = new EventSource('/api/stream');
stream.addEventListener('event', (e) => console.log(JSON.parse(e.data)));
stream.addEventListener('quote', (e) => console.log(JSON.parse(e.data)));
```

| Event       | Payload                                                     |
| ----------- | ----------------------------------------------------------- |
| `ready`     | `{ at }` — the stream is live; the UI turns the badge green |
| `event`     | New timeline events, same shape as `/api/timeline` items    |
| `quote`     | Price updates                                               |
| `alert`     | A fired alert                                               |
| `connector` | Connector status changes                                    |
| `heartbeat` | `{ at }` every 20s                                          |

The heartbeat exists so intermediary proxies do not close an idle connection and
so the client can distinguish "quiet" from "dead". The server sends
`retry: 3000`, so reconnection backoff is server-controlled. See
[ADR-012](DECISIONS.md#adr-012--sse-not-websockets) for why this is not a
WebSocket.

## GET /api/alerts

```json
{
  "alerts": [
    { "id": "clx…", "name": "BTC 5% move", "rule": { "type": "PRICE_CHANGE", … },
      "channels": ["DESKTOP","DISCORD"], "isEnabled": true, "cooldownSeconds": 300,
      "lastTriggeredAt": "…", "triggerCount": 12 }
  ],
  "triggers": [
    { "id": "clx…", "alertId": "clx…", "eventId": null, "coinId": "clx…",
      "triggeredAt": "…", "title": "BTC -5.4% in 1h", "message": "…",
      "observedValue": -5.4 }
  ],
  "availableChannels": ["DESKTOP","DISCORD","TELEGRAM","EMAIL","WEBHOOK"]
}
```

## POST /api/alerts

```json
{
  "name": "Whale moves on ETH",
  "rule": { "type": "WHALE_TRANSFER", "coinIds": ["clx…"], "minUsd": 5000000 },
  "channels": ["DISCORD", "DESKTOP"],
  "cooldownSeconds": 900,
  "isEnabled": true
}
```

Rules are validated with the same Zod schema the worker's engine uses, so the API
cannot persist a rule the worker would reject.

### Rule types

| `type`                | Key fields                                           |
| --------------------- | ---------------------------------------------------- |
| `PRICE_CHANGE`        | `windowMinutes`, `minChangePct`, `direction`         |
| `PRICE_LEVEL`         | `comparator`, `priceUsd`                             |
| `VOLUME_SPIKE`        | `minMultiple` versus trailing baseline               |
| `EVENT_MATCH`         | `categories`, `minImportance`, `keywords`            |
| `EXCHANGE_LISTING`    | `exchanges`, `venueKinds`                            |
| `GITHUB_RELEASE`      | `repos`                                              |
| `WHALE_TRANSFER`      | `minUsd`, `direction`                                |
| `TOKEN_UNLOCK`        | `withinHours`, `minPctOfSupply`                      |
| `GOVERNANCE_PROPOSAL` | `states`                                             |
| `SENTIMENT_SHIFT`     | `minDelta` on [-1,1], `direction`                    |
| `FUNDING_RATE`        | `comparator`, `threshold` (fraction, `0.001` = 10bp) |
| `SOCIAL_VELOCITY`     | `platforms`, `minVelocity` (`5` = a 5× spike)        |
| `AUTHOR_POST`         | `handles`, `verifiedOnly`                            |
| `BREAKING_NEWS`       | `minImportance`                                      |

All accept `coinIds` to scope them; omit it to match every tracked coin.
`cooldownSeconds` (default 300) is claimed atomically, so a volatile minute
produces one notification rather than forty.

## PATCH /api/alerts

`{ "id": "clx…", … }` with any subset of `name`, `rule`, `channels`,
`cooldownSeconds`, `isEnabled`.

## DELETE /api/alerts

`?id=<id>`. Past `AlertTrigger` rows are retained.

## GET /api/reports

| Parameter | Type                                                               | Default | Notes                              |
| --------- | ------------------------------------------------------------------ | ------- | ---------------------------------- |
| `kind`    | `HOURLY`\|`MORNING`\|`WEEKLY`\|`MONTHLY`\|`PORTFOLIO`\|`NARRATIVE` | —       |                                    |
| `id`      | string                                                             | —       | Fetch one report **with** its body |
| `limit`   | int 1–50                                                           | `20`    |                                    |

The list view omits bodies — they are multi-kilobyte Markdown and a list only
needs headers. Pass `?id=` for the full text.

## GET /api/health

Always returns 200. Read `status`.

```json
{
  "status": "degraded",
  "version": "1.0.0",
  "environment": "production",
  "checks": {
    "database": { "ok": true, "latencyMs": 3 },
    "llm": {
      "ok": false,
      "detail": "ollama/llama3.1:8b-instruct-q4_K_M",
      "latencyMs": 2001
    },
    "embeddings": { "ok": true, "detail": "ollama/nomic-embed-text" }
  },
  "ingestion": {
    "connectors": 20,
    "failing": ["theblock"],
    "lagP50Ms": 8400,
    "lagP95Ms": 41200
  },
  "tookMs": 2011
}
```

`status` is `ok`, `degraded` (database fine, something else is not) or
`unhealthy` (database unreachable). Always-200 is deliberate: a monitor must be
able to distinguish "app responding, dependency degraded" from "app dead", which
a status code alone cannot express. A disabled model reports `ok: true` with
`detail: "disabled (LLM_PROVIDER=null)"` — configured-off is not a failure.

`ingestion.lagP95Ms` is the number that actually says whether the platform is
doing its job.

## GET /api/metrics

Prometheus text (`text/plain; version=0.0.4`). Counters for events ingested,
connector runs, LLM calls, cache hits/misses and breaker transitions; histograms
for provider latency; process gauges sampled on each scrape.

This is the **web** process's registry. The worker's collection telemetry lives in
`CollectorRun` and is summarised by `/api/health` — see
[DEPLOYMENT.md](DEPLOYMENT.md#monitoring).

---

## Typed client

`apps/web/src/lib/api.ts` wraps every endpoint with the response types inferred
from the route modules, so a shape change in a route surfaces as a compile error
in the component that reads it. Reuse it rather than calling `fetch` directly from
a component.

## Rate limiting

`RATE_LIMIT_RPM` (default 300) per IP across the public surface, enforced by a
Redis token bucket shared across web replicas. Exceeding it returns 429 with
`RATE_LIMITED`. Behind a proxy, forward `X-Forwarded-For` or every client shares
one bucket.
