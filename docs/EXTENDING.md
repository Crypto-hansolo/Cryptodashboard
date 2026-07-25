# Extending the platform

Four extension points, in rough order of how often you will reach for them:

1. [A data source (connector)](#adding-a-connector)
2. [An alert rule type](#adding-an-alert-rule-type)
3. [A notification channel](#adding-a-notification-channel)
4. [An LLM backend](#adding-an-llm-backend)

Each is designed so the change is local: adding a connector touches the
connectors package and nothing else, and adding a rule type is one variant plus
one `case`, with the compiler finding everything you missed.

## Adding a connector

A connector is a **descriptor** (identity, cadence, rate limit, credential
requirements — all as data) plus a **`run` method**. Everything else — HTTP
retries, caching, rate limiting, circuit breaking, source registration,
scheduling, telemetry, deduplication, scoring — is provided.

### 1. Write it

`packages/connectors/src/social/mastodon.ts`:

```ts
import { z } from 'zod';
import type {
  CollectionRequest,
  ConnectorContext,
  ConnectorDescriptor,
  EventDraft,
} from '@cid/core';
import { classifyWithLexicon, computeEngagement, truncate } from '@cid/core';
import {
  BaseConnector,
  type CollectionBuilder,
  num,
  parseTimestamp,
} from '../sdk/base.js';

/**
 * Only the fields we consume are validated, and the object is `passthrough`:
 * a provider adding a field must not fail the parse, but a provider changing a
 * field we depend on should.
 */
const statusSchema = z
  .object({
    id: z.string(),
    content: z.string(),
    created_at: z.string(),
    url: z.string().nullish(),
    favourites_count: z.number().nullish(),
    reblogs_count: z.number().nullish(),
    account: z.object({
      acct: z.string(),
      followers_count: z.number().nullish(),
    }),
  })
  .passthrough();

export class MastodonConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    key: 'mastodon', // unique; becomes Source.key and the breaker key
    name: 'Mastodon',
    domain: 'social', // drives the cadence override that applies
    sourceKind: 'SOCIAL',
    homepageUrl: 'https://joinmastodon.org',
    credibility: 0.35, // editorial trust, [0,1] — feeds importance
    requirements: [
      {
        envKey: 'MASTODON_INSTANCE_URL',
        required: true, // false = degraded without it, not disabled
        description: 'Instance to search, e.g. https://mastodon.social',
      },
    ],
    defaultIntervalMs: 60_000, // a floor: config can raise it, never lower it
    rateLimit: { requestsPerMinute: 20, burst: 5 },
    batchesCoins: false, // true = one call covers every coin
  };

  protected async run(
    request: CollectionRequest,
    context: ConnectorContext,
    builder: CollectionBuilder,
  ): Promise<void> {
    const instance = this.requireConfig(context, 'MASTODON_INSTANCE_URL');

    for (const coin of request.coins.slice(0, 10)) {
      const response = await context.http.getJson<unknown>(
        `${instance}/api/v2/search`,
        {
          query: { q: `$${coin.symbol}`, type: 'statuses', limit: 40 },
          cacheTtlSeconds: 45,
        },
      );
      // One coin failing must not fail the run.
      if (!response.ok) continue;

      const parsed = z
        .object({ statuses: z.array(statusSchema) })
        .safeParse(response.value);
      if (!parsed.success) continue;

      builder.countFetched(parsed.data.statuses.length);

      const events: EventDraft[] = [];
      for (const status of parsed.data.statuses) {
        const postedAt = parseTimestamp(status.created_at);
        if (!postedAt) continue;
        // Respect the high-water mark, or every poll re-ingests the same page.
        if (request.since && postedAt <= request.since) continue;

        const text = status.content.replace(/<[^>]+>/g, ' ').trim();
        const engagement = computeEngagement({
          likes: num(status.favourites_count) ?? 0,
          reposts: num(status.reblogs_count) ?? 0,
          replies: 0,
          followers: num(status.account.followers_count),
          views: null,
        });
        const lexicon = classifyWithLexicon(text);

        // Only notable posts become timeline events; the rest are stored as
        // social posts and folded into the aggregate.
        if (engagement > 0.5) {
          events.push({
            occurredAt: postedAt,
            sourceKey: this.descriptor.key,
            coinId: coin.id,
            category: 'SOCIAL',
            subtype: 'MASTODON_POST',
            headline: truncate(text, 300),
            body: null,
            url: status.url ?? null,
            author: status.account.acct,
            sentimentHint: lexicon.confidence > 0 ? lexicon.score : null,
            payload: { externalId: status.id },
          });
        }

        builder.add('socialPosts', [
          {
            sourceKey: this.descriptor.key,
            platform: 'MASTODON',
            externalId: status.id,
            authorHandle: status.account.acct,
            postedAt,
            text: truncate(text, 4_000),
            url: status.url ?? null,
            likes: num(status.favourites_count) ?? 0,
            reposts: num(status.reblogs_count) ?? 0,
            replies: 0,
            views: null,
            engagementScore: engagement,
            hashtags: [],
            coinIds: [coin.id],
          },
        ]);
      }

      builder.addEvents(events);
    }
  }
}
```

### 2. Register it

`packages/connectors/src/index.ts`:

```ts
import { MastodonConnector } from './social/mastodon.js';

export { MastodonConnector } from './social/mastodon.js';

// inside buildConnectorRegistry:
const connectors: Connector[] = [
  // ...
  new MastodonConnector(),
];
```

That is the whole wiring. The registry decides whether it is enabled, the
scheduler gives it a timer and its own HTTP client, and `sources.ensure` creates
its `Source` row on boot.

### 3. Document the credentials

`.env.example`:

```env
# Mastodon instance to search for cashtag mentions. Public API, no key needed.
MASTODON_INSTANCE_URL=https://mastodon.social
```

If the variable is not in `envSchema` (`packages/platform/src/env.ts`), add it
there too — connectors read config through the validated `env`, not
`process.env`.

### 4. Test it

`packages/connectors/src/social/mastodon.test.ts`, using the shared fixtures:

```ts
import { describe, expect, it } from 'vitest';
import { makeCoin, makeContext, makeRequest } from '../connector-fixtures.js';
import { MastodonConnector } from './mastodon.js';

describe('MastodonConnector', () => {
  const connector = new MastodonConnector();

  it('is disabled without an instance URL, naming the variable', () => {
    const { context } = makeContext();
    expect(connector.isEnabled(context)).toBe(false);
    expect(connector.missingRequirements(context)).toEqual([
      'MASTODON_INSTANCE_URL',
    ]);
  });

  it('maps a status onto a social post', async () => {
    const { context } = makeContext(
      [
        {
          match: '/api/v2/search',
          body: { statuses: [/* a real recorded payload */] },
        },
      ],
      { MASTODON_INSTANCE_URL: 'https://mastodon.social' },
    );

    const result = await connector.collect(makeRequest([makeCoin()]), context);

    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.records.socialPosts).toHaveLength(1);
  });
});
```

Use a payload you actually recorded from the provider. A hand-written fixture
tests your idea of the API, which is the thing most likely to be wrong.

### What the platform does for you

| You do not write                          | Because                                               |
| ----------------------------------------- | ----------------------------------------------------- |
| Retries, backoff, timeouts                | `context.http` is the resilient client                |
| Rate limiting                             | Taken from `descriptor.rateLimit`, enforced in Redis  |
| Circuit breaking                          | Keyed on your connector's key, so failures stay local |
| Caching                                   | `cacheTtlSeconds` per request, single-flight          |
| Credential checks                         | Derived from `descriptor.requirements`                |
| Scheduling, retries, backoff between runs | The scheduler                                         |
| Source row creation                       | `ingestion.registerConnector` at boot                 |
| Deduplication and clustering              | The ingestion service                                 |
| Scoring, sentiment, embeddings            | Ingestion, then the enrichment loop                   |
| Realtime push, metrics, telemetry         | Ingestion and the scheduler                           |

### Rules worth knowing

- **Throw to fail the run.** A thrown error (or a returned `Err`) marks the run
  FAILED, which triggers backoff and shows up in connector health. Returning
  successfully with no data says "nothing happened", advances the high-water mark,
  and hides an outage.
- **Skip, do not guess.** If a payload is ambiguous — an unrecognised quote asset,
  a token amount you cannot scale — skip the row. A wrong record is worse than a
  missing one.
- **Emit records in the same order as their events.** The ingestion service zips
  event-linked buckets (`news`, `socialPosts`, `onchainEvents`, `githubActivity`,
  `proposals`) against the inserted event ids by position.
- **Respect `request.since`.** It is the difference between a cheap poll and a
  full re-download every minute.
- **Cap your fan-out.** `request.coins` can be 500 long. Slice it.
- **Prefer the provider's timestamp** for `occurredAt`, falling back to
  `context.clock.now()`. The clock is injected so tests can control it.

### Connector domains

`domain` decides which `INTERVAL_*_MS` override applies:

| Domain        | Default override          | Typical |
| ------------- | ------------------------- | ------- |
| `market`      | `INTERVAL_MARKET_MS`      | 10s     |
| `derivatives` | `INTERVAL_DERIVATIVES_MS` | 30s     |
| `dex`         | `INTERVAL_MARKET_MS`      | 10s     |
| `news`        | `INTERVAL_NEWS_MS`        | 60s     |
| `social`      | `INTERVAL_SOCIAL_MS`      | 60s     |
| `onchain`     | `INTERVAL_ONCHAIN_MS`     | 60s     |
| `github`      | `INTERVAL_GITHUB_MS`      | 60s     |
| `governance`  | `INTERVAL_GOVERNANCE_MS`  | 5m      |
| `tokenomics`  | `INTERVAL_TOKENOMICS_MS`  | 15m     |

## Adding an RSS feed

A new publication needs no code at all — add a definition to `NEWS_FEEDS` in
`packages/connectors/src/news/rss.ts`:

```ts
{
  key: 'newoutlet',
  name: 'New Outlet',
  url: 'https://newoutlet.com/feed',
  homepageUrl: 'https://newoutlet.com',
  credibility: 0.7,
  sourceKind: 'NEWS',
},
```

`createNewsConnectors` builds one connector per entry, so it gets its own
credibility, circuit breaker, telemetry and `Source` row. Set `credibility`
honestly: it feeds importance scoring, and inflating it makes a press-release mill
outrank The Block.

## Adding an alert rule type

Rules are declarative data, so a new type is a schema variant plus an evaluation
case. The compiler finds the rest.

### 1. The schema

`packages/core/src/domain/alert.ts`:

```ts
export const tvlChangeRuleSchema = z.object({
  type: z.literal('TVL_CHANGE'),
  coinIds: coinScope, // [] means "any coin"
  windowHours: z.number().int().positive().default(24),
  thresholdPct: z.number().positive(),
  direction: directionSchema.default('ANY'),
});

export const alertRuleSchema = z.discriminatedUnion('type', [
  // ...
  tvlChangeRuleSchema,
]);

export const ALERT_RULE_TYPES = [
  // ...
  'TVL_CHANGE',
] as const satisfies readonly AlertRuleType[];
```

The `satisfies` is load-bearing: forget the list entry and it fails to compile.

### 2. The signal it consumes

If no existing `AlertSignal` variant carries what the rule needs, add one in
`packages/core/src/services/alert-engine.ts`:

```ts
export type AlertSignal =
  // ...
  {
    kind: 'tokenomics';
    coinId: string;
    current: TokenomicsSnapshot;
    reference: TokenomicsSnapshot | null;
  };
```

and declare which kinds the rule can consume:

```ts
const RULE_SIGNAL_KINDS = {
  // ...
  TVL_CHANGE: ['tokenomics'],
} satisfies Record<AlertRuleType, readonly AlertSignal['kind'][]>;
```

### 3. Evaluation — a pure function

```ts
case 'TVL_CHANGE': {
  if (signal.kind !== 'tokenomics') return null;
  if (!inScope(rule.coinIds, signal.coinId)) return null;
  if (!signal.reference) return null;

  const change = pctChange(signal.reference.tvlUsd, signal.current.tvlUsd);
  if (change === null) return null;
  if (Math.abs(change) < rule.thresholdPct) return null;
  if (!matchesDirection(change, rule.direction)) return null;

  return {
    title: `TVL moved ${fmtPct(change)}`,
    message: `TVL changed ${fmtPct(change)} over ${rule.windowHours}h.`,
    observedValue: change,
    coinId: signal.coinId,
    eventId: null,
    payload: { from: signal.reference.tvlUsd, to: signal.current.tvlUsd },
  };
}
```

The switch is exhaustive with a `never` guard, so omitting this case is a compile
error rather than a rule that silently never fires.

### 4. Produce the signal

Signals are built where the data lands. Add a builder next to
`buildMarketSignals` in `packages/worker/src/alerts.ts` and call it from
`main.ts` — either on the loop that suits its cadence, or straight after the
relevant ingestion.

### 5. Test it

Rule evaluation is pure, so the test needs no infrastructure:

```ts
it('fires on a TVL drop beyond the threshold', () => {
  const match = evaluateRule(
    {
      type: 'TVL_CHANGE',
      coinIds: [],
      windowHours: 24,
      thresholdPct: 10,
      direction: 'DOWN',
    },
    {
      kind: 'tokenomics',
      coinId: 'coin-aave',
      current: snap(9e9),
      reference: snap(12e9),
    },
  );

  expect(match?.observedValue).toBeCloseTo(-25, 5);
});
```

Nothing in the UI needs changing: the alert form is generated from the schema.

## Adding a notification channel

Implement `Notifier` (three members) in `packages/worker/src/notifications.ts`:

```ts
export class SlackNotifier implements Notifier {
  readonly channel = 'SLACK';
  readonly #webhookUrl: string | undefined;
  readonly #http: HttpClient;

  constructor(options: { webhookUrl?: string; http: HttpClient }) {
    this.#webhookUrl = options.webhookUrl;
    this.#http = options.http;
  }

  /** Configured-off is not an error; the dispatcher reports it as SUPPRESSED. */
  isConfigured(): boolean {
    return Boolean(this.#webhookUrl);
  }

  async send(payload: NotificationPayload): Promise<Result<void, DomainError>> {
    if (!this.#webhookUrl)
      return err(new ConfigError('SLACK_WEBHOOK_URL is not set'));

    const response = await this.#http.request({
      url: this.#webhookUrl,
      method: 'POST',
      body: {
        text: `*${payload.title}*\n${payload.message}`,
        ...(payload.url
          ? { attachments: [{ title: 'Source', title_link: payload.url }] }
          : {}),
      },
    });
    return response.ok ? ok(undefined) : err(response.error);
  }
}
```

Then:

1. Add `SLACK` to `NOTIFICATION_CHANNELS` in `packages/core/src/domain/enums.ts`
   and to the Prisma enum, with a migration.
2. Register the notifier in the dispatcher in `packages/worker/src/main.ts`.
3. Add `SLACK_WEBHOOK_URL` to `envSchema` and `.env.example`.

Delivery outcomes are recorded per channel in `NotificationDelivery`, and one
channel failing never blocks the others.

## Adding an LLM backend

Most backends need no code: if it speaks the OpenAI protocol, set
`LLM_PROVIDER=openai-compatible` and point `LLM_BASE_URL` at its `/v1`.

A genuinely different protocol means implementing `LlmClient` — `isAvailable`,
`complete`, `stream` — in `packages/ai/src/providers/llm.ts` and adding a case to
`createLlmClient` (the switch is exhaustive, so the compiler will ask). Keep the
provider label distinct: metrics, `/api/health` and the status page key on it, so
"vllm is down" must not read as "openai".

If the backend supports constrained decoding, use it for enrichment. It is the
single biggest quality lever on a small local model — see
[ADR-016](DECISIONS.md#adr-016--ollamas-native-api-for-constrained-json).

## Adding an API endpoint

`apps/web/src/app/api/<name>/route.ts`:

```ts
import { z } from 'zod';
import { parseQuery, route } from '@/server/api';
import { getServices } from '@/server/container';

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  coinId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function GET(request: Request) {
  // Passing `request` also applies the per-client rate limit.
  return route(request, async () => {
    const query = parseQuery(request, querySchema);
    const { repositories } = getServices();
    return { items: await repositories.content.somethingUseful(query) };
  });
}
```

The wrapper maps `DomainError` codes to statuses, turns Zod failures into 400s
naming the field, and reduces anything unexpected to a 500 with a server-side log
— an unhandled throw can carry a connection string.

Query the database through a repository, never Prisma directly from a route. If
the query does not exist yet, add it to the repository and its port.

## What is not yet implemented

The connector SDK and registry were built for these; each needs roughly the
worked example above. They are listed in the README as declared-but-missing, and
their env vars already exist:

| Source             | Env                    | Notes                                                                                                                                      |
| ------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Arkham             | `ARKHAM_API_KEY`       | Entity-labelled wallets — would improve whale direction inference a lot                                                                    |
| Nansen             | `NANSEN_API_KEY`       | Smart-money flows                                                                                                                          |
| Dune               | `DUNE_API_KEY`         | Arbitrary SQL; needs a query-id-per-metric mapping                                                                                         |
| Glassnode          | `GLASSNODE_API_KEY`    | On-chain metrics (SOPR, MVRV, supply distribution)                                                                                         |
| Santiment          | `SANTIMENT_API_KEY`    | Social + on-chain, GraphQL                                                                                                                 |
| IntoTheBlock       | `INTOTHEBLOCK_API_KEY` | Holder composition                                                                                                                         |
| X / Twitter        | `X_BEARER_TOKEN`       | Search + accounts. Scraping deliberately not implemented (ToS, reliability)                                                                |
| Farcaster          | `NEYNAR_API_KEY`       | Casts and channels                                                                                                                         |
| Lens               | `LENS_API_BASE`        | GraphQL publications                                                                                                                       |
| YouTube            | `YOUTUBE_API_KEY`      | Channel uploads                                                                                                                            |
| Telegram           | `TELEGRAM_BOT_TOKEN`   | Channel ingestion (the token is currently used for _delivery_ only)                                                                        |
| Discord            | `DISCORD_BOT_TOKEN`    | Guild message ingestion                                                                                                                    |
| Solscan            | `SOLSCAN_API_KEY`      | Solana equivalent of the Etherscan connector                                                                                               |
| CEX beyond Binance | —                      | Bybit, OKX, Kraken, Coinbase, KuCoin, MEXC, Hyperliquid. `BinanceConnector` is the template; the shapes differ but the mapping is the same |

Start from the closest existing connector: `etherscan.ts` for on-chain,
`reddit.ts` for social, `binance.ts` for an exchange, `snapshot.ts` for GraphQL.
