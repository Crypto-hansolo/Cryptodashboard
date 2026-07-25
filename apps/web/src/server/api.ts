import { NextResponse } from 'next/server';
import { z } from 'zod';
import { DomainError } from '@cid/core';
import { getServices } from './container.js';

/**
 * Shared API-route plumbing.
 *
 * One place that turns a handler's return value or throw into a response, so
 * every route reports errors the same way and none of them leak a stack trace or
 * a connection string to the browser.
 */

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** HTTP status for each domain error code. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNAUTHORIZED: 401,
  RATE_LIMITED: 429,
  TIMEOUT: 504,
  UPSTREAM: 502,
  CIRCUIT_OPEN: 503,
  UNSUPPORTED: 400,
  CONFIG: 500,
  INTERNAL: 500,
};

export function jsonError(
  code: string,
  message: string,
  status?: number,
): NextResponse<ApiErrorBody> {
  return NextResponse.json(
    { error: { code, message } },
    { status: status ?? STATUS_BY_CODE[code] ?? 500 },
  );
}

/**
 * Identify the caller for rate-limiting purposes.
 *
 * Behind a proxy the socket address is the proxy's, so the forwarded headers are
 * the only usable signal — which also means they are spoofable by anyone talking
 * to the app directly. That is acceptable here: this limit protects the database
 * and the model from accidental hammering by the app's own client, it is not an
 * anti-abuse control for a hostile internet. Anything internet-facing belongs
 * behind an authenticating proxy anyway (docs/DEPLOYMENT.md#multi-tenancy).
 */
function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  // Left-most entry is the original client; the rest are proxies.
  const first = forwarded?.split(',')[0]?.trim();
  const ip = first || request.headers.get('x-real-ip')?.trim() || 'local';
  return `ip:${ip}`;
}

/**
 * Consume one token for this caller, throwing `RATE_LIMITED` when the bucket is
 * empty.
 *
 * Fails *open* on a limiter error: if Redis is unreachable the dashboard should
 * keep working, and a limiter that turns an infrastructure blip into a total
 * outage is worse than no limiter.
 */
async function enforceRateLimit(request: Request): Promise<void> {
  const { apiRateLimiter, env, logger } = getServices();
  try {
    if (await apiRateLimiter.tryAcquire(clientKey(request))) return;
  } catch (error) {
    logger.warn({ err: error }, 'api rate limiter unavailable; allowing request');
    return;
  }
  throw new DomainError(
    'RATE_LIMITED',
    `Rate limit exceeded (${env.RATE_LIMIT_RPM} requests/minute)`,
    { retryable: true },
  );
}

/**
 * Rate-limit guard for routes that build their own `Response` and therefore
 * cannot go through {@link route} — the two SSE endpoints.
 *
 * Returns a 429 to hand straight back, or null to proceed. `/api/ask` needs this
 * on its streaming path specifically: it is the most expensive endpoint in the
 * app, and limiting only the non-streaming path would leave the default one
 * unguarded.
 */
export async function rateLimitGuard(request: Request): Promise<NextResponse<ApiErrorBody> | null> {
  try {
    await enforceRateLimit(request);
    return null;
  } catch (error) {
    if (error instanceof DomainError && error.code === 'RATE_LIMITED') {
      return jsonError(error.code, error.message);
    }
    throw error;
  }
}

/**
 * Wrap a route handler.
 *
 * Zod failures become 400s with field detail (useful to a client), and anything
 * else becomes a 500 with a generic message and a server-side log — the message
 * from an unexpected throw can contain a database URL.
 *
 * Passing the `Request` also applies the per-client rate limit. Every data route
 * does; `/api/health` and `/api/metrics` deliberately do not, because a monitor
 * polling them must never be throttled — losing visibility during a traffic
 * spike is exactly when you need it.
 */
export function route<T>(handler: () => Promise<T>): Promise<NextResponse<T | ApiErrorBody>>;
export function route<T>(
  request: Request,
  handler: () => Promise<T>,
): Promise<NextResponse<T | ApiErrorBody>>;
export function route<T>(
  requestOrHandler: Request | (() => Promise<T>),
  maybeHandler?: () => Promise<T>,
): Promise<NextResponse<T | ApiErrorBody>> {
  const limited = typeof requestOrHandler !== 'function';
  const handler = (limited ? maybeHandler : requestOrHandler) as () => Promise<T>;

  const run = limited ? enforceRateLimit(requestOrHandler as Request).then(handler) : handler();

  return run
    .then((data) => NextResponse.json(data))
    .catch((error: unknown) => {
      if (error instanceof z.ZodError) {
        return jsonError(
          'VALIDATION',
          error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
          400,
        );
      }
      if (error instanceof DomainError) {
        return jsonError(error.code, error.message);
      }
      getServices().logger.error({ err: error }, 'unhandled API error');
      return jsonError('INTERNAL', 'Internal server error', 500);
    });
}

/** Parse and validate search params. */
export function parseQuery<S extends z.ZodTypeAny>(request: Request, schema: S): z.infer<S> {
  const params = new URL(request.url).searchParams;
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    raw[key] = values.length > 1 ? values : values[0]!;
  }
  return schema.parse(raw) as z.infer<S>;
}

/** Comma-separated list -> string[]; used for `?coinIds=a,b,c`. */
export const csv = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    const items = Array.isArray(value) ? value : value.split(',');
    const cleaned = items.map((item) => item.trim()).filter(Boolean);
    return cleaned.length > 0 ? cleaned : undefined;
  });

export const isoDate = z
  .string()
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
      throw new z.ZodError([{ code: 'custom', path: ['date'], message: `invalid date: ${value}` }]);
    return date;
  });

/**
 * Guard for admin/internal routes.
 *
 * When `INTERNAL_API_TOKEN` is unset the guard *denies* rather than allows:
 * failing closed is the only safe default for an endpoint that can trigger
 * collection runs.
 */
export function requireInternalToken(request: Request): void {
  const { env } = getServices();
  const expected = env.INTERNAL_API_TOKEN;
  if (!expected) {
    throw new DomainError('UNAUTHORIZED', 'INTERNAL_API_TOKEN is not configured', {
      retryable: false,
    });
  }
  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (provided !== expected) {
    throw new DomainError('UNAUTHORIZED', 'invalid internal token', { retryable: false });
  }
}
