/**
 * `@cid/core` — the domain layer.
 *
 * Contains only: types, schemas, ports (interfaces) and pure functions.
 * No I/O, no framework imports, no `node:` builtins — which is what allows this
 * package to be imported from the worker, the Next.js server *and* React client
 * components without a bundler workaround.
 *
 * Dependency rule: core depends on nothing internal. Everything else depends on
 * core. If you find yourself wanting to import `@cid/db` here, the logic
 * belongs in a service, not in the domain.
 */

// Result & errors
export * from './result.js';
export * from './errors.js';

// Domain model
export * from './domain/enums.js';
export * from './domain/coin.js';
export * from './domain/event.js';
export * from './domain/market.js';
export * from './domain/content.js';
export * from './domain/alert.js';
export * from './domain/report.js';

// Ports
export * from './ports/repositories.js';
export * from './ports/services.js';
export * from './ports/connector.js';

// Pure services
export * from './services/sentiment.js';
export * from './services/scoring.js';
export * from './services/dedupe.js';
export * from './services/identifiers.js';
export * from './services/coin-matcher.js';
export * from './services/alert-engine.js';

// Utilities
export * from './utils/math.js';
export * from './utils/sha256.js';
export * from './utils/format.js';
