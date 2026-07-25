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

export function jsonError(code: string, message: string, status?: number): NextResponse<ApiErrorBody> {
  return NextResponse.json(
    { error: { code, message } },
    { status: status ?? STATUS_BY_CODE[code] ?? 500 },
  );
}

/**
 * Wrap a route handler.
 *
 * Zod failures become 400s with field detail (useful to a client), and anything
 * else becomes a 500 with a generic message and a server-side log — the message
 * from an unexpected throw can contain a database URL.
 */
export function route<T>(
  handler: () => Promise<T>,
): Promise<NextResponse<T | ApiErrorBody>> {
  return handler()
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
    if (Number.isNaN(date.getTime())) throw new z.ZodError([
      { code: 'custom', path: ['date'], message: `invalid date: ${value}` },
    ]);
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
