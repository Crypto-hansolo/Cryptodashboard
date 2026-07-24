/**
 * Domain error taxonomy.
 *
 * The `retryable` flag is the contract between connectors and the scheduler:
 * the retry policy in `@cid/worker` reads it instead of pattern-matching on
 * error messages. Getting this wrong is expensive in both directions — retrying
 * a 401 forever burns rate limit, and dropping a 503 loses data.
 */

export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'UPSTREAM'
  | 'TIMEOUT'
  | 'CIRCUIT_OPEN'
  | 'UNSUPPORTED'
  | 'CONFIG'
  | 'INTERNAL';

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; context?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.context = Object.freeze({ ...options.context });
    if (options.cause !== undefined) this.cause = options.cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      context: this.context,
    };
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('VALIDATION', message, { retryable: false, context });
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, identifier: string) {
    super('NOT_FOUND', `${resource} not found: ${identifier}`, {
      retryable: false,
      context: { resource, identifier },
    });
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('CONFLICT', message, { retryable: false, context });
  }
}

/** Missing/invalid credentials for a provider. Never retryable — it will not fix itself. */
export class UnauthorizedError extends DomainError {
  constructor(provider: string, message = 'missing or rejected credentials') {
    super('UNAUTHORIZED', `${provider}: ${message}`, { retryable: false, context: { provider } });
  }
}

export class RateLimitError extends DomainError {
  /** Seconds to wait, when the upstream told us via Retry-After. */
  readonly retryAfterSeconds: number | undefined;

  constructor(provider: string, retryAfterSeconds?: number) {
    super('RATE_LIMITED', `${provider}: rate limited`, {
      retryable: true,
      context: { provider, retryAfterSeconds },
    });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Upstream returned an unexpected status or body. Retryable for 5xx only. */
export class UpstreamError extends DomainError {
  readonly status: number | undefined;

  constructor(provider: string, message: string, status?: number) {
    super('UPSTREAM', `${provider}: ${message}`, {
      // 5xx and transport-level failures are worth another shot; 4xx are not.
      retryable: status === undefined || status >= 500,
      context: { provider, status },
    });
    this.status = status;
  }
}

export class TimeoutError extends DomainError {
  constructor(operation: string, timeoutMs: number) {
    super('TIMEOUT', `${operation} timed out after ${timeoutMs}ms`, {
      retryable: true,
      context: { operation, timeoutMs },
    });
  }
}

export class CircuitOpenError extends DomainError {
  constructor(provider: string, reopensAt: Date) {
    super('CIRCUIT_OPEN', `${provider}: circuit open until ${reopensAt.toISOString()}`, {
      // Retryable, but the caller should back off well past `reopensAt`.
      retryable: true,
      context: { provider, reopensAt: reopensAt.toISOString() },
    });
  }
}

/** A connector was asked for something it structurally cannot provide. */
export class UnsupportedError extends DomainError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('UNSUPPORTED', message, { retryable: false, context });
  }
}

export class ConfigError extends DomainError {
  constructor(message: string, context?: Record<string, unknown>) {
    super('CONFIG', message, { retryable: false, context });
  }
}

/** True when the scheduler should schedule another attempt. */
export function isRetryable(error: unknown): boolean {
  return error instanceof DomainError ? error.retryable : true;
}

export function toDomainError(error: unknown, fallbackMessage = 'unexpected error'): DomainError {
  if (error instanceof DomainError) return error;
  if (error instanceof Error) {
    return new DomainError('INTERNAL', error.message || fallbackMessage, {
      retryable: true,
      cause: error,
    });
  }
  return new DomainError('INTERNAL', fallbackMessage, {
    retryable: true,
    context: { raw: String(error) },
  });
}
