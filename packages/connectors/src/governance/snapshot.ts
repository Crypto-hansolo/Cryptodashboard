import { z } from 'zod';
import type {
  CollectionRequest,
  ConnectorContext,
  ConnectorDescriptor,
  EventDraft,
  ProposalState,
} from '@cid/core';
import { truncate } from '@cid/core';
import { BaseConnector, type CollectionBuilder, num, parseTimestamp } from '../sdk/base.js';

/**
 * Snapshot governance connector.
 *
 * Snapshot hosts off-chain governance for most DAOs and exposes a keyless
 * GraphQL API. One query covers every space we track, so this stays a single
 * request regardless of watchlist size.
 *
 * Proposals are upserted rather than appended, because a proposal's *state
 * transition* (pending -> active -> passed) is the alertable moment, and the
 * repository reports those transitions back.
 */

const proposalSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    body: z.string().nullish(),
    choices: z.array(z.string()).nullish(),
    scores: z.array(z.number()).nullish(),
    scores_total: z.number().nullish(),
    start: z.number().nullish(),
    end: z.number().nullish(),
    created: z.number().nullish(),
    state: z.string().nullish(),
    author: z.string().nullish(),
    link: z.string().nullish(),
    quorum: z.number().nullish(),
    votes: z.number().nullish(),
    space: z.object({ id: z.string(), name: z.string().nullish() }).nullish(),
  })
  .passthrough();

const graphqlSchema = z.object({
  data: z.object({ proposals: z.array(proposalSchema).nullable().default([]) }).nullish(),
  errors: z.array(z.object({ message: z.string() })).nullish(),
});

/**
 * Snapshot reports `active`/`closed`/`pending`. `closed` alone does not say
 * whether a proposal passed, so the outcome is derived from the vote tallies.
 */
function resolveState(
  raw: string | null | undefined,
  scores: readonly number[] | null | undefined,
  quorum: number | null,
  total: number | null,
): ProposalState {
  const state = (raw ?? '').toLowerCase();
  if (state === 'pending') return 'PENDING';
  if (state === 'active') return 'ACTIVE';

  if (state === 'closed') {
    // Quorum not met means it failed regardless of the split.
    if (quorum !== null && quorum > 0 && (total ?? 0) < quorum) return 'FAILED';
    if (!scores || scores.length === 0) return 'EXPIRED';

    const highest = Math.max(...scores);
    const first = scores[0] ?? 0;
    // Convention on Snapshot is choice[0] = "For".
    return highest > 0 && first === highest ? 'PASSED' : 'FAILED';
  }

  return 'PENDING';
}

export class SnapshotConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    key: 'snapshot',
    name: 'Snapshot',
    domain: 'governance',
    sourceKind: 'GOVERNANCE',
    homepageUrl: 'https://snapshot.org',
    credibility: 0.9,
    requirements: [],
    defaultIntervalMs: 300_000,
    rateLimit: { requestsPerMinute: 10, burst: 3 },
    batchesCoins: true,
  };

  protected async run(
    request: CollectionRequest,
    context: ConnectorContext,
    builder: CollectionBuilder,
  ): Promise<void> {
    // Map space -> coin so responses can be attributed back.
    const spaceToCoin = new Map<string, (typeof request.coins)[number]>();
    for (const coin of request.coins) {
      for (const space of coin.snapshotSpaces) spaceToCoin.set(space.toLowerCase(), coin);
    }
    if (spaceToCoin.size === 0) return;

    const query = `
      query Proposals($spaces: [String!], $first: Int!) {
        proposals(
          first: $first,
          skip: 0,
          where: { space_in: $spaces },
          orderBy: "created",
          orderDirection: desc
        ) {
          id title body choices scores scores_total start end created state author link quorum votes
          space { id name }
        }
      }
    `;

    const response = await context.http.request<unknown>({
      url: 'https://hub.snapshot.org/graphql',
      method: 'POST',
      body: { query, variables: { spaces: [...spaceToCoin.keys()], first: 50 } },
      cacheTtlSeconds: 120,
    });
    if (!response.ok) throw response.error;

    const parsed = graphqlSchema.safeParse(response.value.data);
    if (!parsed.success) throw new Error('snapshot: unexpected GraphQL payload');
    if (parsed.data.errors && parsed.data.errors.length > 0) {
      throw new Error(`snapshot: ${parsed.data.errors.map((e) => e.message).join('; ')}`);
    }

    const proposals = parsed.data.data?.proposals ?? [];
    builder.countFetched(proposals.length);

    const events: EventDraft[] = [];
    const records: Array<Record<string, unknown>> = [];

    for (const proposal of proposals) {
      const spaceId = proposal.space?.id?.toLowerCase();
      const coin = spaceId ? spaceToCoin.get(spaceId) : undefined;
      if (!coin || !spaceId) continue;

      const createdAt = parseTimestamp(proposal.created) ?? context.clock.now();
      const total = num(proposal.scores_total);
      const quorum = num(proposal.quorum);
      const state = resolveState(proposal.state, proposal.scores, quorum, total);

      const url = proposal.link ?? `https://snapshot.org/#/${spaceId}/proposal/${proposal.id}`;

      events.push({
        occurredAt: createdAt,
        sourceKey: this.descriptor.key,
        coinId: coin.id,
        category: 'GOVERNANCE',
        subtype: `PROPOSAL_${state}`,
        headline: truncate(`${coin.symbol} governance: ${proposal.title}`, 300),
        body: proposal.body ? truncate(proposal.body, 4_000) : null,
        url,
        author: proposal.author ?? null,
        // Active votes are actionable; closed ones are a matter of record.
        importanceHint: state === 'ACTIVE' ? 58 : 45,
        payload: { externalId: proposal.id, space: spaceId, state },
      });

      records.push({
        sourceKey: this.descriptor.key,
        coinId: coin.id,
        space: spaceId,
        externalId: proposal.id,
        title: truncate(proposal.title, 300),
        body: proposal.body ? truncate(proposal.body, 8_000) : null,
        author: proposal.author ?? null,
        state,
        createdAt,
        startsAt: parseTimestamp(proposal.start),
        endsAt: parseTimestamp(proposal.end),
        url,
        choices: proposal.choices ?? [],
        scores: proposal.scores ?? [],
        totalVotes: num(proposal.votes),
        quorum,
      });
    }

    builder.addEvents(events);
    builder.add('proposals', records);
  }
}
