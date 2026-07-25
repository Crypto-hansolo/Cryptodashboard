import { describe, expect, it } from 'vitest';
import { UpstreamError } from '@cid/core';
import { FIXED_NOW, makeCoin, makeContext, makeRequest } from '../connector-fixtures.js';
import { SnapshotConnector } from './snapshot.js';

/**
 * The substantive logic here is outcome resolution. Snapshot reports a proposal
 * as "closed" and leaves the verdict to the reader: quorum has to be checked
 * against the total, and "passed" has to be derived from the score split. Getting
 * that wrong would report failed proposals as passed, which is worse than
 * reporting nothing.
 */

const SPACE = 'aave.eth';
const coin = makeCoin({ id: 'coin-aave', symbol: 'AAVE', snapshotSpaces: [SPACE] });

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proposal-1',
    title: 'Onboard wstETH as collateral',
    body: 'Full proposal text.',
    choices: ['For', 'Against', 'Abstain'],
    scores: [420_000, 12_000, 500],
    scores_total: 432_500,
    start: Math.floor((FIXED_NOW.getTime() - 3 * 86_400_000) / 1000),
    end: Math.floor((FIXED_NOW.getTime() + 86_400_000) / 1000),
    created: Math.floor((FIXED_NOW.getTime() - 4 * 86_400_000) / 1000),
    state: 'active',
    author: '0xauthor',
    link: `https://snapshot.org/#/${SPACE}/proposal/proposal-1`,
    quorum: 320_000,
    votes: 812,
    space: { id: SPACE, name: 'Aave' },
    ...overrides,
  };
}

const route = (proposals: unknown[], errors?: unknown[]) => [
  {
    match: 'hub.snapshot.org/graphql',
    body: { data: { proposals }, ...(errors ? { errors } : {}) },
  },
];

describe('SnapshotConnector', () => {
  const connector = new SnapshotConnector();

  it('needs no credentials', () => {
    const { context } = makeContext();
    expect(connector.descriptor.requirements).toEqual([]);
    expect(connector.isEnabled(context)).toBe(true);
  });

  it('queries only the spaces of tracked coins, in one GraphQL call', async () => {
    const { context, http } = makeContext(route([]));
    const second = makeCoin({ id: 'coin-uni', snapshotSpaces: ['uniswapgovernance.eth'] });

    await connector.collect(makeRequest([coin, second, makeCoin({ id: 'coin-x' })]), context);

    expect(http.requests).toHaveLength(1);
    expect(http.lastRequest?.method).toBe('POST');
    expect(
      (http.lastRequest?.body as { variables: { spaces: string[] } }).variables.spaces,
    ).toEqual([SPACE, 'uniswapgovernance.eth']);
  });

  it('maps an active proposal onto an event and a record', async () => {
    const { context } = makeContext(route([proposal()]));

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.events[0]).toMatchObject({
      sourceKey: 'snapshot',
      coinId: 'coin-aave',
      category: 'GOVERNANCE',
      subtype: 'PROPOSAL_ACTIVE',
      headline: 'AAVE governance: Onboard wstETH as collateral',
      author: '0xauthor',
      // An open vote is actionable; a closed one is a matter of record.
      importanceHint: 58,
    });
    expect(result.value.records.proposals?.[0]).toMatchObject({
      space: SPACE,
      externalId: 'proposal-1',
      state: 'ACTIVE',
      choices: ['For', 'Against', 'Abstain'],
      scores: [420_000, 12_000, 500],
      totalVotes: 812,
      quorum: 320_000,
      startsAt: new Date(Math.floor(FIXED_NOW.getTime() - 3 * 86_400_000)),
      endsAt: new Date(Math.floor(FIXED_NOW.getTime() + 86_400_000)),
    });
  });

  it('scores a closed proposal lower than an open one', async () => {
    const { context } = makeContext(route([proposal({ state: 'closed' })]));

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.events[0]?.importanceHint).toBe(45);
  });

  it('resolves a closed proposal with a winning first choice as passed', async () => {
    // Snapshot convention: choices[0] is "For".
    const { context } = makeContext(route([proposal({ state: 'closed' })]));

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.proposals?.[0]?.state).toBe('PASSED');
  });

  it('resolves a closed proposal that lost as failed', async () => {
    const { context } = makeContext(
      route([proposal({ state: 'closed', scores: [12_000, 420_000, 500] })]),
    );

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.proposals?.[0]?.state).toBe('FAILED');
  });

  it('fails a proposal that missed quorum regardless of the split', async () => {
    /*
     * This is the case a naive "did For win?" check gets wrong: unanimous
     * approval by too few voters is still a failed proposal.
     */
    const { context } = makeContext(
      route([
        proposal({
          state: 'closed',
          scores: [1_000, 0, 0],
          scores_total: 1_000,
          quorum: 320_000,
        }),
      ]),
    );

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.proposals?.[0]?.state).toBe('FAILED');
  });

  it('treats a closed proposal with no scores as expired', async () => {
    const { context } = makeContext(
      route([proposal({ state: 'closed', scores: [], scores_total: 0, quorum: 0 })]),
    );

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.proposals?.[0]?.state).toBe('EXPIRED');
  });

  it('maps pending and unknown states to PENDING', async () => {
    const { context } = makeContext(
      route([proposal({ state: 'pending' }), proposal({ id: 'p2', state: 'something-new' })]),
    );

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.proposals?.map((row) => row.state)).toEqual(['PENDING', 'PENDING']);
  });

  it('attributes proposals to a coin case-insensitively by space id', async () => {
    const { context } = makeContext(route([proposal({ space: { id: 'AAVE.ETH', name: 'Aave' } })]));

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.proposals).toHaveLength(1);
  });

  it('ignores a proposal from an unrequested space', async () => {
    const { context } = makeContext(
      route([proposal({ space: { id: 'other.eth', name: 'Other' } })]),
    );

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.records.proposals ?? []).toEqual([]);
  });

  it('builds a link when the proposal has none', async () => {
    const { context } = makeContext(route([proposal({ link: null })]));

    const result = await connector.collect(makeRequest([coin]), context);

    if (!result.ok) throw new Error('expected success');
    expect(result.value.events[0]?.url).toBe(`https://snapshot.org/#/${SPACE}/proposal/proposal-1`);
  });

  it('makes no request when no coin has a governance space', async () => {
    const { context, http } = makeContext(route([]));

    const result = await connector.collect(makeRequest([makeCoin()]), context);

    expect(result.ok).toBe(true);
    expect(http.requests).toHaveLength(0);
  });

  it('fails the run on a transport error', async () => {
    const { context } = makeContext([
      { match: 'graphql', error: new UpstreamError('snapshot', 'gateway', 502) },
    ]);

    expect((await connector.collect(makeRequest([coin]), context)).ok).toBe(false);
  });

  it('fails the run when GraphQL reports errors, rather than reporting no proposals', async () => {
    /*
     * GraphQL answers 200 with an `errors` array. Treating that as "no proposals"
     * would advance the high-water mark and silently skip a governance cycle.
     */
    const { context } = makeContext(route([], [{ message: 'query complexity exceeded' }]));

    const result = await connector.collect(makeRequest([coin]), context);

    if (result.ok) throw new Error('expected failure');
    expect(result.error.message).toContain('query complexity exceeded');
  });

  it('fails the run on a malformed payload', async () => {
    const { context } = makeContext([{ match: 'graphql', body: { data: { proposals: 'nope' } } }]);

    expect((await connector.collect(makeRequest([coin]), context)).ok).toBe(false);
  });
});
