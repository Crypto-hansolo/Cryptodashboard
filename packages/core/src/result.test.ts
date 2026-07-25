import { describe, expect, it } from 'vitest';
import {
  attempt,
  attemptSync,
  err,
  isErr,
  isOk,
  map,
  mapErr,
  ok,
  partition,
  unwrap,
  unwrapOr,
  type Result,
} from './result.js';

/**
 * `Result` is how every third-party failure travels through the system, so its
 * behaviour is load-bearing rather than incidental: a bug here would either
 * swallow provider errors or turn one into an unwinding throw inside a scheduler
 * tick.
 */

describe('ok / err construction', () => {
  it('carries the value and discriminates on `ok`', () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
  });

  it('carries the error and discriminates on `ok`', () => {
    const error = new Error('boom');
    const result = err(error);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(error);
  });

  it('permits undefined and null as legitimate success values', () => {
    // A collector that fetched nothing succeeded; it did not fail.
    expect(ok(undefined).ok).toBe(true);
    expect(ok(null).value).toBeNull();
  });
});

describe('isOk / isErr', () => {
  it('narrows the union in both directions', () => {
    const result: Result<number, string> = ok(1);

    if (isOk(result)) {
      // Type-level assertion: `.value` is only reachable after narrowing.
      expect(result.value + 1).toBe(2);
    } else {
      throw new Error('narrowing failed');
    }

    const failure: Result<number, string> = err('nope');
    expect(isErr(failure)).toBe(true);
    if (isErr(failure)) expect(failure.error.toUpperCase()).toBe('NOPE');
  });
});

describe('unwrapOr', () => {
  it('returns the value on success', () => {
    expect(unwrapOr(ok(7), 0)).toBe(7);
  });

  it('returns the fallback on failure', () => {
    expect(unwrapOr(err(new Error('x')) as Result<number, Error>, 0)).toBe(0);
  });

  it('never throws, whatever the error is', () => {
    expect(unwrapOr(err('a string error') as Result<number, string>, -1)).toBe(-1);
  });
});

describe('unwrap', () => {
  it('returns the value on success', () => {
    expect(unwrap(ok('value'))).toBe('value');
  });

  it('throws the original error, preserving its type', () => {
    const error = new TypeError('bad type');
    expect(() => unwrap(err(error))).toThrow(error);
    expect(() => unwrap(err(error))).toThrow(TypeError);
  });

  it('wraps a non-Error rejection so the throw is still an Error', () => {
    // Some SDKs reject with a string or a plain object; a `throw 'x'` upstream
    // produces stack-less garbage in logs.
    expect(() => unwrap(err('plain string'))).toThrow('plain string');
    expect(() => unwrap(err({ code: 500 }))).toThrow(Error);
  });
});

describe('map', () => {
  it('transforms a success', () => {
    expect(map(ok(2), (n) => n * 3)).toEqual(ok(6));
  });

  it('passes a failure through untouched, without calling the mapper', () => {
    let called = false;
    const failure: Result<number, string> = err('upstream 502');
    const mapped = map(failure, (n: number) => {
      called = true;
      return n * 3;
    });
    expect(called).toBe(false);
    expect(mapped).toBe(failure);
  });
});

describe('mapErr', () => {
  it('transforms a failure', () => {
    const mapped = mapErr(err('502'), (code) => new Error(`upstream ${code}`));
    expect(isErr(mapped)).toBe(true);
    if (isErr(mapped)) expect(mapped.error.message).toBe('upstream 502');
  });

  it('passes a success through untouched, without calling the mapper', () => {
    let called = false;
    const success: Result<number, string> = ok(1);
    const mapped = mapErr(success, (e) => {
      called = true;
      return e;
    });
    expect(called).toBe(false);
    expect(mapped).toBe(success);
  });
});

describe('attempt', () => {
  it('captures a resolved value', async () => {
    await expect(attempt(async () => 'fine')).resolves.toEqual(ok('fine'));
  });

  it('captures a thrown Error rather than propagating it', async () => {
    const result = await attempt(async () => {
      throw new Error('network down');
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.message).toBe('network down');
  });

  it('normalises a non-Error rejection into an Error', async () => {
    const result = await attempt(async () => {
      throw 'string rejection';
    });
    if (!isErr(result)) throw new Error('expected failure');
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe('string rejection');
  });

  it('captures a synchronous throw inside an async function', async () => {
    const result = await attempt(() => {
      throw new Error('thrown before the first await');
    });
    expect(isErr(result)).toBe(true);
  });
});

describe('attemptSync', () => {
  it('captures a returned value', () => {
    expect(attemptSync(() => 5)).toEqual(ok(5));
  });

  it('captures a throw', () => {
    const result = attemptSync(() => JSON.parse('{ not json'));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error).toBeInstanceOf(Error);
  });

  it('normalises a non-Error throw', () => {
    const result = attemptSync(() => {
      throw 42;
    });
    if (!isErr(result)) throw new Error('expected failure');
    expect(result.error.message).toBe('42');
  });
});

describe('partition', () => {
  it('keeps successes and failures side by side', () => {
    // This is the collector contract: ingest what worked, report what did not.
    const { values, errors } = partition([ok(1), err('a'), ok(2), err('b'), ok(3)]);
    expect(values).toEqual([1, 2, 3]);
    expect(errors).toEqual(['a', 'b']);
  });

  it('preserves input order within each side', () => {
    const { values } = partition([ok('z'), ok('y'), ok('x')]);
    expect(values).toEqual(['z', 'y', 'x']);
  });

  it('handles an empty batch', () => {
    expect(partition([])).toEqual({ values: [], errors: [] });
  });

  it('handles all-failed and all-succeeded batches', () => {
    expect(partition([err('a'), err('b')])).toEqual({ values: [], errors: ['a', 'b'] });
    expect(partition([ok(1)])).toEqual({ values: [1], errors: [] });
  });
});
