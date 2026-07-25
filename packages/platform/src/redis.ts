import { Redis } from 'ioredis';
import type { Logger, RealtimeBus, RealtimeMessage } from '@cid/core';
import { noopLogger } from '@cid/core';

/**
 * Redis connections and the realtime fan-out.
 *
 * Redis serves three distinct jobs here — cache, BullMQ queues, and pub/sub —
 * and they cannot all share one connection: a client in subscriber mode may only
 * issue subscribe commands, and BullMQ requires `maxRetriesPerRequest: null` on
 * its blocking connections. Hence explicit factories per role rather than one
 * shared singleton.
 */

export interface RedisOptions {
  url: string;
  logger?: Logger;
  /** Label used in logs to identify which pool a connection belongs to. */
  role?: string;
}

function attachLogging(client: Redis, logger: Logger, role: string): Redis {
  client.on('error', (error: Error) => {
    // ioredis reconnects on its own; log at warn so a blip is not treated as
    // fatal, but a persistent failure is still visible.
    logger.warn({ role, err: error.message }, 'redis connection error');
  });
  client.on('reconnecting', () => logger.debug({ role }, 'redis reconnecting'));
  client.on('ready', () => logger.debug({ role }, 'redis ready'));
  return client;
}

/** General-purpose client for cache and ad-hoc commands. */
export function createRedis(options: RedisOptions): Redis {
  const logger = options.logger ?? noopLogger;
  const client = new Redis(options.url, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  return attachLogging(client, logger, options.role ?? 'general');
}

/**
 * Connection for BullMQ. `maxRetriesPerRequest: null` is required by BullMQ —
 * its blocking `BRPOPLPUSH` calls must not be aborted by the retry counter.
 */
export function createQueueRedis(options: RedisOptions): Redis {
  const logger = options.logger ?? noopLogger;
  const client = new Redis(options.url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  return attachLogging(client, logger, options.role ?? 'queue');
}

/**
 * Redis pub/sub realtime bus.
 *
 * The worker process produces events; the web process holds the open SSE
 * connections. They are separate containers, so the hand-off has to go through
 * Redis — an in-process EventEmitter would silently deliver nothing in the real
 * deployment while appearing to work in `npm run dev`.
 */
export class RedisRealtimeBus implements RealtimeBus {
  readonly #publisher: Redis;
  readonly #subscriberFactory: () => Redis;
  readonly #logger: Logger;
  /** One subscriber connection per channel, with its handler set. */
  readonly #subscribers = new Map<
    string,
    { client: Redis; handlers: Set<(m: RealtimeMessage) => void> }
  >();

  constructor(options: { url: string; logger?: Logger }) {
    this.#logger = options.logger ?? noopLogger;
    this.#publisher = createRedis({ url: options.url, logger: this.#logger, role: 'pubsub-pub' });
    this.#subscriberFactory = () =>
      createRedis({ url: options.url, logger: this.#logger, role: 'pubsub-sub' });
  }

  async publish(channel: string, message: RealtimeMessage): Promise<void> {
    try {
      await this.#publisher.publish(channel, JSON.stringify(message));
    } catch (error) {
      // Realtime is a nicety; losing a frame must never fail an ingestion run.
      this.#logger.warn({ channel, err: error }, 'realtime publish failed');
    }
  }

  async subscribe(
    channel: string,
    handler: (message: RealtimeMessage) => void,
  ): Promise<() => Promise<void>> {
    let entry = this.#subscribers.get(channel);

    if (!entry) {
      const client = this.#subscriberFactory();
      const handlers = new Set<(m: RealtimeMessage) => void>();
      entry = { client, handlers };
      this.#subscribers.set(channel, entry);

      client.on('message', (receivedChannel: string, payload: string) => {
        if (receivedChannel !== channel) return;
        let parsed: RealtimeMessage;
        try {
          parsed = JSON.parse(payload) as RealtimeMessage;
        } catch {
          this.#logger.warn({ channel }, 'discarding malformed realtime frame');
          return;
        }
        for (const fn of handlers) {
          try {
            fn(parsed);
          } catch (error) {
            // One misbehaving subscriber must not stop the others.
            this.#logger.warn({ channel, err: error }, 'realtime handler threw');
          }
        }
      });

      await client.subscribe(channel);
    }

    entry.handlers.add(handler);

    return async () => {
      const current = this.#subscribers.get(channel);
      if (!current) return;
      current.handlers.delete(handler);
      // Tear the connection down once nobody is listening.
      if (current.handlers.size === 0) {
        this.#subscribers.delete(channel);
        try {
          await current.client.unsubscribe(channel);
        } catch {
          /* connection may already be gone */
        }
        current.client.disconnect();
      }
    };
  }

  async close(): Promise<void> {
    for (const { client } of this.#subscribers.values()) client.disconnect();
    this.#subscribers.clear();
    this.#publisher.disconnect();
  }
}

/**
 * In-process bus for tests and single-process development. Same contract,
 * no Redis.
 */
export class InMemoryRealtimeBus implements RealtimeBus {
  readonly #handlers = new Map<string, Set<(m: RealtimeMessage) => void>>();

  async publish(channel: string, message: RealtimeMessage): Promise<void> {
    for (const handler of this.#handlers.get(channel) ?? []) handler(message);
  }

  async subscribe(
    channel: string,
    handler: (message: RealtimeMessage) => void,
  ): Promise<() => Promise<void>> {
    let set = this.#handlers.get(channel);
    if (!set) {
      set = new Set();
      this.#handlers.set(channel, set);
    }
    set.add(handler);
    return async () => {
      set?.delete(handler);
    };
  }
}

/** Channel names, centralised so publisher and subscriber cannot disagree. */
export const CHANNELS = {
  events: 'cid:events',
  quotes: 'cid:quotes',
  alerts: 'cid:alerts',
  connectors: 'cid:connectors',
} as const;
