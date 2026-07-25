import type {
  Connector,
  ConnectorContext,
  ConnectorDescriptor,
  ConnectorDomain,
  ConnectorRegistry,
} from '@cid/core';
import { BaseConnector } from './base.js';

/**
 * The connector registry — the plugin system in practice.
 *
 * Connectors self-register; the worker asks for "all enabled connectors in the
 * `news` domain" and never holds a hard-coded list. Adding a source is one
 * `register()` call, and removing one cannot break an unrelated import.
 */
export class DefaultConnectorRegistry implements ConnectorRegistry {
  readonly #connectors = new Map<string, Connector>();

  register(connector: Connector): void {
    const key = connector.descriptor.key;
    if (this.#connectors.has(key)) {
      // Duplicate keys would collide on the `Source.key` unique constraint and
      // silently merge two sources' credibility and telemetry.
      throw new Error(`Duplicate connector key "${key}"`);
    }
    this.#connectors.set(key, connector);
  }

  registerAll(connectors: readonly Connector[]): void {
    for (const connector of connectors) this.register(connector);
  }

  get(key: string): Connector | null {
    return this.#connectors.get(key) ?? null;
  }

  list(): Connector[] {
    return [...this.#connectors.values()];
  }

  listByDomain(domain: ConnectorDomain): Connector[] {
    return this.list().filter((connector) => connector.descriptor.domain === domain);
  }

  listEnabled(context: ConnectorContext): Connector[] {
    return this.list().filter((connector) => connector.isEnabled(context));
  }

  /**
   * Diagnostic view: what is on, what is off, and precisely which env var is
   * missing. This is what the status page renders, and it is the difference
   * between "8 sources disabled" and a support ticket.
   */
  describe(context: ConnectorContext): Array<{
    descriptor: ConnectorDescriptor;
    enabled: boolean;
    missingRequirements: string[];
    degraded: boolean;
  }> {
    return this.list()
      .map((connector) => {
        const base = connector instanceof BaseConnector ? connector : null;
        return {
          descriptor: connector.descriptor,
          enabled: connector.isEnabled(context),
          missingRequirements: base?.missingRequirements(context) ?? [],
          degraded: base?.isDegraded(context) ?? false,
        };
      })
      .sort((a, b) => a.descriptor.key.localeCompare(b.descriptor.key));
  }

  /** Apply each connector's declared rate limit to the shared limiter. */
  configureRateLimits(context: ConnectorContext): void {
    const limiter = context.rateLimiter as {
      configure?: (key: string, config: { requestsPerMinute: number; burst?: number }) => void;
    };
    if (typeof limiter.configure !== 'function') return;

    for (const connector of this.list()) {
      const { key, rateLimit } = connector.descriptor;
      limiter.configure(key, {
        requestsPerMinute: rateLimit.requestsPerMinute,
        ...(rateLimit.burst !== undefined ? { burst: rateLimit.burst } : {}),
      });
    }
  }

  clear(): void {
    this.#connectors.clear();
  }
}
