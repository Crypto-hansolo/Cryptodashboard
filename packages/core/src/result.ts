/**
 * A small explicit Result type.
 *
 * Connectors talk to ~30 third-party APIs that fail constantly and in boring
 * ways (429, 502, malformed JSON, DNS blips). Modelling those as return values
 * rather than thrown exceptions keeps the scheduler's control flow honest: a
 * failing source degrades one collector run instead of unwinding a whole tick.
 *
 * Exceptions are still used for genuine programmer errors and unrecoverable
 * boot failures (bad config, missing migration) — things that *should* crash.
 */

export type Result<T, E = Error> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;

export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

/** Unwrap or fall back. Never throws. */
export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/** Unwrap or throw. Use only where a failure genuinely is a bug. */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw r.error instanceof Error ? r.error : new Error(String(r.error));
}

export function map<T, U, E>(r: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r;
}

export function mapErr<T, E, F>(r: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return r.ok ? r : err(fn(r.error));
}

/** Run a throwing async function and capture the throw as an `Err`. */
export async function attempt<T>(fn: () => Promise<T>): Promise<Result<T, Error>> {
  try {
    return ok(await fn());
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Synchronous counterpart to {@link attempt}. */
export function attemptSync<T>(fn: () => T): Result<T, Error> {
  try {
    return ok(fn());
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Collect many results, keeping successes and failures side by side.
 * Collectors use this to ingest whatever worked and report the rest.
 */
export function partition<T, E>(
  results: readonly Result<T, E>[],
): {
  values: T[];
  errors: E[];
} {
  const values: T[] = [];
  const errors: E[] = [];
  for (const r of results) {
    if (r.ok) values.push(r.value);
    else errors.push(r.error);
  }
  return { values, errors };
}
