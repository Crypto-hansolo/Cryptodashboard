import {
  evaluateAlerts,
  type AlertSignal,
  type Logger,
  type NotificationChannel,
  type RealtimeBus,
  type SentimentLabel,
} from '@cid/core';
import { noopLogger } from '@cid/core';
import type { CidRepositories } from '@cid/db';
import { CHANNELS, metrics } from '@cid/platform';
import { buildNotificationPayload, type NotificationDispatcher } from './notifications.js';

/**
 * The alert runtime.
 *
 * Rule *evaluation* is a pure function in `@cid/core`; this owns the impure
 * parts: building signals from the database, claiming a firing atomically, and
 * fanning out notifications.
 *
 * Signals are evaluated the moment they are produced rather than on a polling
 * loop, which is what keeps alert latency inside the ~1 minute target. The
 * atomic claim in `recordTrigger` is what makes running several worker replicas
 * safe — only one can win a given firing.
 */

export interface AlertEngineOptions {
  repositories: CidRepositories;
  dispatcher: NotificationDispatcher;
  realtime: RealtimeBus;
  logger?: Logger;
  whaleThresholdUsd?: number;
}

export class AlertEngine {
  readonly #repositories: CidRepositories;
  readonly #dispatcher: NotificationDispatcher;
  readonly #realtime: RealtimeBus;
  readonly #logger: Logger;

  constructor(options: AlertEngineOptions) {
    this.#repositories = options.repositories;
    this.#dispatcher = options.dispatcher;
    this.#realtime = options.realtime;
    this.#logger = (options.logger ?? noopLogger).child({ component: 'alerts' });
  }

  /**
   * Evaluate every enabled alert against one signal and fire the matches.
   * Returns the number of alerts that actually fired (post-claim).
   */
  async process(signal: AlertSignal, now = new Date()): Promise<number> {
    const alerts = await this.#repositories.alerts.listEnabled();
    if (alerts.length === 0) return 0;

    const outcomes = evaluateAlerts(alerts, signal, now);
    if (outcomes.length === 0) return 0;

    let fired = 0;

    for (const { alert, match } of outcomes) {
      // Atomic claim: loses harmlessly if another replica got there first.
      const trigger = await this.#repositories.alerts.recordTrigger(alert.id, {
        eventId: match.eventId,
        coinId: match.coinId,
        triggeredAt: now,
        title: match.title,
        message: match.message,
        observedValue: match.observedValue,
        payload: match.payload,
      });

      if (!trigger) {
        this.#logger.debug({ alertId: alert.id }, 'alert claim lost (cooldown or concurrent fire)');
        continue;
      }

      fired++;
      metrics.increment('alerts_triggered', { rule: alert.rule.type });

      const context = await this.#loadContext(match.coinId, match.eventId);

      const payload = buildNotificationPayload({
        title: match.title,
        message: match.message,
        url: context.url ?? (typeof match.payload.url === 'string' ? match.payload.url : null),
        coinSymbol: context.coinSymbol,
        importance: context.importance,
        sentiment: context.sentiment,
        triggeredAt: now,
        observedValue: match.observedValue,
        valueKind: valueKindFor(alert.rule.type),
      });

      const deliveries = await this.#dispatcher.dispatch(
        alert.channels as NotificationChannel[],
        payload,
      );

      for (const delivery of deliveries) {
        await this.#repositories.alerts.recordDelivery({
          triggerId: trigger.id,
          channel: delivery.channel,
          status: delivery.status,
          attempts: 1,
          error: delivery.error,
          sentAt: delivery.status === 'SENT' ? now : null,
        });
      }

      // Push to the UI so an open dashboard shows the alert without a refresh.
      await this.#realtime.publish(CHANNELS.alerts, {
        type: 'alert',
        payload: {
          id: trigger.id,
          alertId: alert.id,
          alertName: alert.name,
          title: match.title,
          message: match.message,
          coinId: match.coinId,
          coinSymbol: context.coinSymbol,
          importance: context.importance,
          triggeredAt: now.toISOString(),
          url: payload.url,
        },
      });

      this.#logger.info(
        { alertId: alert.id, rule: alert.rule.type, title: match.title },
        'alert fired',
      );
    }

    return fired;
  }

  /** Evaluate several signals, e.g. one market signal per tracked coin. */
  async processMany(signals: readonly AlertSignal[], now = new Date()): Promise<number> {
    let fired = 0;
    for (const signal of signals) fired += await this.process(signal, now);
    return fired;
  }

  /** Enrich the notification with the coin symbol and the event's AI verdict. */
  async #loadContext(
    coinId: string | null,
    eventId: string | null,
  ): Promise<{
    coinSymbol: string | null;
    importance: number | null;
    sentiment: SentimentLabel | null;
    url: string | null;
  }> {
    const [coin, event] = await Promise.all([
      coinId ? this.#repositories.coins.findById(coinId) : Promise.resolve(null),
      eventId ? this.#repositories.events.findById(eventId) : Promise.resolve(null),
    ]);

    return {
      coinSymbol: coin?.symbol ?? null,
      importance: event?.intelligence.importance ?? null,
      sentiment: event?.intelligence.sentiment ?? null,
      url: event?.url ?? null,
    };
  }
}

/** How to format a rule's observed value in the notification body. */
function valueKindFor(ruleType: string): 'usd' | 'percent' | 'raw' {
  switch (ruleType) {
    case 'PRICE_CHANGE':
    case 'SENTIMENT_SHIFT':
    case 'TOKEN_UNLOCK':
      return 'percent';
    case 'PRICE_LEVEL':
    case 'WHALE_TRANSFER':
      return 'usd';
    default:
      return 'raw';
  }
}

/**
 * Build market signals for the tracked coins.
 *
 * The reference quote is the price `windowMinutes` ago, which PRICE_CHANGE rules
 * compare against and PRICE_LEVEL rules use to detect an actual crossing rather
 * than a persisting condition.
 */
export async function buildMarketSignals(
  repositories: CidRepositories,
  options: { coinIds: readonly string[]; windowMinutes?: number; baselineDays?: number },
): Promise<AlertSignal[]> {
  const windowMinutes = options.windowMinutes ?? 60;
  const referenceAt = new Date(Date.now() - windowMinutes * 60_000);

  const quotes = await repositories.market.latestQuotes(options.coinIds);
  const signals: AlertSignal[] = [];

  for (const coinId of options.coinIds) {
    const current = quotes.get(coinId);
    if (!current) continue;

    const [reference, baselineVolumeUsd] = await Promise.all([
      repositories.market.quoteAt(coinId, referenceAt),
      repositories.market.baselineVolume(coinId, options.baselineDays ?? 7),
    ]);

    signals.push({ kind: 'market', coinId, current, reference, baselineVolumeUsd });
  }

  return signals;
}

/** Build unlock signals for unlocks inside the alert lead time. */
export async function buildUnlockSignals(
  repositories: CidRepositories,
  options: { coinIds: readonly string[]; leadTimeHours?: number },
): Promise<AlertSignal[]> {
  const before = new Date(Date.now() + (options.leadTimeHours ?? 48) * 3_600_000);
  const unlocks = await repositories.content.listUpcomingUnlocks({
    coinIds: options.coinIds,
    before,
  });
  if (unlocks.length === 0) return [];

  const quotes = await repositories.market.latestQuotes(unlocks.map((unlock) => unlock.coinId));

  return unlocks.map((unlock) => {
    const quote = quotes.get(unlock.coinId);

    // The TOKEN_UNLOCK rule needs the share of circulating supply. When the
    // provider did not supply `pctOfCirculating`, derive the supply from
    // marketCap / price — both are on the quote, and the quotient is exactly
    // circulating supply by definition. Without this, unlocks from providers
    // that omit the percentage would never fire an alert.
    const circulatingSupply =
      quote && quote.marketCapUsd !== null && quote.priceUsd > 0
        ? quote.marketCapUsd / quote.priceUsd
        : null;

    return { kind: 'unlock' as const, coinId: unlock.coinId, unlock, circulatingSupply };
  });
}
