import { describe, expect, it } from 'vitest';
import type { Alert, AlertSignal, NotificationPayload, RealtimeBus } from '@cid/core';
import { fakeRepositories } from '@cid/platform/testing';
import type { CidRepositories } from '@cid/db';
import { AlertEngine, buildMarketSignals, buildUnlockSignals } from './alerts.js';
import type { NotificationDispatcher } from './notifications.js';

/**
 * Rule evaluation itself is a pure function tested in `@cid/core`. What is tested
 * here is the impure half: claiming a firing exactly once, recording every
 * delivery attempt, and building signals that carry the reference values the
 * rules need.
 *
 * The claim is the important one. An alert that fires twice, or that fires again
 * every minute while a condition persists, is an alert the user turns off.
 */

const NOW = new Date('2026-07-25T12:00:00.000Z');

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'alert-1',
    userId: 'user-1',
    name: 'BTC 5% move',
    rule: {
      type: 'PRICE_CHANGE',
      coinIds: [],
      windowMinutes: 60,
      thresholdPct: 5,
      direction: 'ANY',
    },
    channels: ['DESKTOP', 'DISCORD'],
    isEnabled: true,
    cooldownSeconds: 300,
    lastTriggeredAt: null,
    triggerCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Alert;
}

/**
 * A market signal whose move is `changePct`.
 *
 * PRICE_CHANGE compares the current price against the reference quote rather
 * than trusting a provider's own percentage field, so the reference is what
 * makes the rule fire.
 */
function marketSignal(changePct: number): AlertSignal {
  const priceUsd = 90_000;
  const referencePrice = priceUsd / (1 + changePct / 100);
  const quote = (price: number) =>
    ({
      coinId: 'coin-btc',
      priceUsd: price,
      marketCapUsd: 1_780_000_000_000,
      volume24hUsd: 24_000_000_000,
      priceChange1hPct: changePct,
      priceChange24hPct: changePct,
      priceChange7dPct: null,
      observedAt: NOW,
    }) as never;

  return {
    kind: 'market',
    coinId: 'coin-btc',
    current: quote(priceUsd),
    reference: quote(referencePrice),
    baselineVolumeUsd: null,
  } as AlertSignal;
}

interface Harness {
  engine: AlertEngine;
  triggers: Array<{ alertId: string; draft: Record<string, unknown> }>;
  deliveries: Array<Record<string, unknown>>;
  dispatched: Array<{ channels: readonly string[]; payload: NotificationPayload }>;
  published: Array<{ channel: string; message: unknown }>;
}

function harness(
  options: {
    alerts?: Alert[];
    claimSucceeds?: boolean;
    dispatchOutcomes?: Array<{ channel: string; status: 'SENT' | 'FAILED'; error: string | null }>;
  } = {},
): Harness {
  const triggers: Array<{ alertId: string; draft: Record<string, unknown> }> = [];
  const deliveries: Array<Record<string, unknown>> = [];
  const dispatched: Array<{ channels: readonly string[]; payload: NotificationPayload }> = [];
  const published: Array<{ channel: string; message: unknown }> = [];

  const repositories = fakeRepositories({
    alerts: {
      listEnabled: async () => options.alerts ?? [alert()],
      recordTrigger: async (alertId: string, draft: Record<string, unknown>) => {
        triggers.push({ alertId, draft });
        return options.claimSucceeds === false ? null : { id: `trigger-${triggers.length}` };
      },
      recordDelivery: async (delivery: Record<string, unknown>) => {
        deliveries.push(delivery);
      },
    },
    coins: { findById: async () => ({ id: 'coin-btc', symbol: 'BTC', name: 'Bitcoin' }) },
    events: { findById: async () => null },
  }) as unknown as CidRepositories;

  const dispatcher = {
    dispatch: async (channels: readonly string[], payload: NotificationPayload) => {
      dispatched.push({ channels, payload });
      return (
        options.dispatchOutcomes ??
        channels.map((channel) => ({ channel, status: 'SENT' as const, error: null }))
      );
    },
  } as unknown as NotificationDispatcher;

  const realtime: RealtimeBus = {
    publish: async (channel, message) => {
      published.push({ channel, message });
    },
    subscribe: async () => async () => {},
  };

  return {
    engine: new AlertEngine({ repositories, dispatcher, realtime }),
    triggers,
    deliveries,
    dispatched,
    published,
  };
}

describe('AlertEngine.process', () => {
  it('fires a matching rule and claims the trigger', async () => {
    const { engine, triggers } = harness();

    const fired = await engine.process(marketSignal(-7.2), NOW);

    expect(fired).toBe(1);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.alertId).toBe('alert-1');
    expect(triggers[0]?.draft).toMatchObject({ coinId: 'coin-btc', triggeredAt: NOW });
    expect(triggers[0]?.draft.observedValue as number).toBeCloseTo(-7.2, 6);
  });

  it('does not fire when the rule does not match', async () => {
    const { engine, triggers, dispatched } = harness();

    expect(await engine.process(marketSignal(1.1), NOW)).toBe(0);
    expect(triggers).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it('does nothing at all when no alerts are configured', async () => {
    const { engine, triggers } = harness({ alerts: [] });

    expect(await engine.process(marketSignal(-20), NOW)).toBe(0);
    expect(triggers).toEqual([]);
  });

  it('sends no notification when the claim is lost', async () => {
    /*
     * The claim is atomic in the repository, so a cooldown or a second worker
     * replica returns null. Notifying anyway is exactly the duplicate-alert bug
     * the claim exists to prevent.
     */
    const { engine, dispatched, published } = harness({ claimSucceeds: false });

    const fired = await engine.process(marketSignal(-7.2), NOW);

    expect(fired).toBe(0);
    expect(dispatched).toEqual([]);
    expect(published).toEqual([]);
  });

  it('dispatches to the alert’s configured channels only', async () => {
    const { engine, dispatched } = harness({
      alerts: [alert({ channels: ['TELEGRAM'] })],
    });

    await engine.process(marketSignal(-7.2), NOW);

    expect(dispatched[0]?.channels).toEqual(['TELEGRAM']);
  });

  it('enriches the notification with the coin symbol', async () => {
    const { engine, dispatched } = harness();

    await engine.process(marketSignal(-7.2), NOW);

    expect(dispatched[0]?.payload).toMatchObject({ coinSymbol: 'BTC', triggeredAt: NOW });
    expect(dispatched[0]?.payload.title).toBeTruthy();
  });

  it('records every delivery attempt, successful or not', async () => {
    // Delivery history is how a user finds out their Discord webhook is stale.
    const { engine, deliveries } = harness({
      dispatchOutcomes: [
        { channel: 'DESKTOP', status: 'SENT', error: null },
        { channel: 'DISCORD', status: 'FAILED', error: '404 webhook not found' },
      ],
    });

    await engine.process(marketSignal(-7.2), NOW);

    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({
      triggerId: 'trigger-1',
      channel: 'DESKTOP',
      status: 'SENT',
      sentAt: NOW,
    });
    expect(deliveries[1]).toMatchObject({
      channel: 'DISCORD',
      status: 'FAILED',
      error: '404 webhook not found',
      // Nothing was sent, so there is no sent timestamp to record.
      sentAt: null,
    });
  });

  it('pushes the firing to open dashboards', async () => {
    const { engine, published } = harness();

    await engine.process(marketSignal(-7.2), NOW);

    expect(published).toHaveLength(1);
    expect(published[0]?.channel).toBe('cid:alerts');
    expect(published[0]?.message).toMatchObject({
      type: 'alert',
      payload: {
        id: 'trigger-1',
        alertId: 'alert-1',
        alertName: 'BTC 5% move',
        coinSymbol: 'BTC',
        triggeredAt: NOW.toISOString(),
      },
    });
  });

  it('evaluates every enabled alert against the same signal', async () => {
    // One price move can satisfy several rules; each fires independently.
    const { engine, triggers } = harness({
      alerts: [
        alert({
          id: 'alert-a',
          rule: {
            type: 'PRICE_CHANGE',
            coinIds: [],
            windowMinutes: 60,
            thresholdPct: 5,
            direction: 'ANY',
          },
        }),
        alert({
          id: 'alert-b',
          rule: {
            type: 'PRICE_CHANGE',
            coinIds: [],
            windowMinutes: 60,
            thresholdPct: 2,
            direction: 'DOWN',
          },
        }),
      ],
    });

    const fired = await engine.process(marketSignal(-7.2), NOW);

    expect(fired).toBe(2);
    expect(triggers.map((entry) => entry.alertId)).toEqual(['alert-a', 'alert-b']);
  });

  it('sums firings across a batch of signals', async () => {
    const { engine } = harness();

    const fired = await engine.processMany(
      [marketSignal(-7.2), marketSignal(0.5), marketSignal(9)],
      NOW,
    );

    // The middle signal is inside the threshold.
    expect(fired).toBe(2);
  });
});

describe('buildMarketSignals', () => {
  it('pairs the current quote with the reference from the window start', async () => {
    /*
     * PRICE_LEVEL rules need the earlier price to detect a *crossing* rather than
     * a condition that has been true for a day — without the reference they would
     * re-fire on every evaluation.
     */
    const asked: Array<{ coinId: string; at: Date }> = [];
    const repositories = fakeRepositories({
      market: {
        latestQuotes: async () => new Map([['coin-btc', { priceUsd: 90_000 }]]),
        quoteAt: async (coinId: string, at: Date) => {
          asked.push({ coinId, at });
          return { priceUsd: 84_000 };
        },
        baselineVolume: async () => 20_000_000_000,
      },
    }) as unknown as CidRepositories;

    const signals = await buildMarketSignals(repositories, {
      coinIds: ['coin-btc'],
      windowMinutes: 60,
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: 'market',
      coinId: 'coin-btc',
      current: { priceUsd: 90_000 },
      reference: { priceUsd: 84_000 },
      baselineVolumeUsd: 20_000_000_000,
    });
    // The reference is one window back, not "now".
    expect(asked[0]?.at.getTime()).toBeLessThan(Date.now());
  });

  it('skips a coin with no current quote', async () => {
    // A coin added seconds ago has no price yet; a signal without one is useless.
    const repositories = fakeRepositories({
      market: {
        latestQuotes: async () => new Map(),
        quoteAt: async () => null,
        baselineVolume: async () => null,
      },
    }) as unknown as CidRepositories;

    expect(await buildMarketSignals(repositories, { coinIds: ['coin-new'] })).toEqual([]);
  });
});

describe('buildUnlockSignals', () => {
  const unlock = {
    coinId: 'coin-cro',
    unlockAt: new Date(NOW.getTime() + 24 * 3_600_000),
    amount: 50_000_000,
    pctOfCirculating: null,
  };

  it('derives circulating supply from market cap and price', async () => {
    /*
     * TOKEN_UNLOCK thresholds are a share of circulating supply, and many
     * providers omit it. Market cap over price *is* circulating supply by
     * definition, so deriving it is what makes those unlocks alertable at all —
     * this path previously always produced null and the rule could never fire.
     */
    const repositories = fakeRepositories({
      content: { listUpcomingUnlocks: async () => [unlock] },
      market: {
        latestQuotes: async () =>
          new Map([['coin-cro', { priceUsd: 0.125, marketCapUsd: 4_000_000_000 }]]),
      },
    }) as unknown as CidRepositories;

    const signals = await buildUnlockSignals(repositories, { coinIds: ['coin-cro'] });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ kind: 'unlock', coinId: 'coin-cro' });
    // 4e9 / 0.125 = 3.2e10 tokens.
    expect((signals[0] as { circulatingSupply: number }).circulatingSupply).toBeCloseTo(3.2e10, 0);
  });

  it('leaves supply null when the quote cannot support the derivation', async () => {
    const repositories = fakeRepositories({
      content: { listUpcomingUnlocks: async () => [unlock] },
      market: {
        latestQuotes: async () => new Map([['coin-cro', { priceUsd: 0, marketCapUsd: null }]]),
      },
    }) as unknown as CidRepositories;

    const signals = await buildUnlockSignals(repositories, { coinIds: ['coin-cro'] });

    expect((signals[0] as { circulatingSupply: number | null }).circulatingSupply).toBeNull();
  });

  it('asks only for unlocks inside the lead time', async () => {
    const asked: Array<{ before: Date }> = [];
    const repositories = fakeRepositories({
      content: {
        listUpcomingUnlocks: async (input: { before: Date }) => {
          asked.push(input);
          return [];
        },
      },
    }) as unknown as CidRepositories;

    await buildUnlockSignals(repositories, { coinIds: ['coin-cro'], leadTimeHours: 12 });

    const window = (asked[0]?.before.getTime() ?? 0) - Date.now();
    expect(window).toBeGreaterThan(11 * 3_600_000);
    expect(window).toBeLessThanOrEqual(12 * 3_600_000);
  });

  it('returns nothing, and asks for no quotes, when no unlock is due', async () => {
    const repositories = fakeRepositories({
      content: { listUpcomingUnlocks: async () => [] },
    }) as unknown as CidRepositories;

    expect(await buildUnlockSignals(repositories, { coinIds: ['coin-cro'] })).toEqual([]);
  });
});
