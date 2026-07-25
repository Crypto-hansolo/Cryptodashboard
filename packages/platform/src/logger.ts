import pino from 'pino';
import type { Logger } from '@cid/core';
import { isSecretKey, type Env } from './env.js';

/**
 * Structured logging on pino.
 *
 * `pretty` in development, newline-delimited JSON in production so logs can be
 * shipped without a parsing step. Redaction is configured centrally rather than
 * left to call sites: 40 connectors each carrying an API key is 40 chances to
 * log one by accident.
 */

/** Field names that get redacted wherever they appear in a log object. */
const REDACT_PATHS = [
  'apiKey',
  'api_key',
  'token',
  'bearer',
  'password',
  'secret',
  'authorization',
  'Authorization',
  '*.apiKey',
  '*.token',
  '*.password',
  '*.secret',
  '*.authorization',
  'headers.authorization',
  'headers.Authorization',
  'headers["x-api-key"]',
  'config.LLM_API_KEY',
  'config.GITHUB_TOKEN',
  'config.X_BEARER_TOKEN',
];

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'LOG_FORMAT' | 'NODE_ENV'>): Logger {
  const options: pino.LoggerOptions = {
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // ISO timestamps: log correlation across the web and worker processes
    // matters more here than the marginal cost of formatting.
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { service: 'cid' },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };

  if (env.LOG_FORMAT === 'pretty') {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname,service',
          messageFormat: '{if connector}[{connector}] {end}{msg}',
        },
      },
    }) as unknown as Logger;
  }

  return pino(options) as unknown as Logger;
}

/**
 * Strip secret-looking values out of an arbitrary object before logging it.
 * Complements pino's path-based redaction for dynamically-keyed config maps.
 */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => sanitizeForLog(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key) || /key|token|secret|password|auth/i.test(key)) {
      out[key] = item === undefined || item === null || item === '' ? 'unset' : '[redacted]';
    } else {
      out[key] = sanitizeForLog(item, depth + 1);
    }
  }
  return out;
}
