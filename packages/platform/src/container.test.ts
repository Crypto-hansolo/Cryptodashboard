import { describe, expect, it, vi } from 'vitest';
import { Container, token } from './container.js';

interface Db {
  name: string;
}
interface Service {
  db: Db;
}

const DB = token<Db>('db');
const SERVICE = token<Service>('service');

describe('Container', () => {
  it('resolves a registered singleton', () => {
    const container = new Container();
    container.singleton(DB, () => ({ name: 'pg' }));
    expect(container.resolve(DB).name).toBe('pg');
  });

  it('constructs a singleton lazily and only once', () => {
    const container = new Container();
    const factory = vi.fn(() => ({ name: 'pg' }));
    container.singleton(DB, factory);

    expect(factory).not.toHaveBeenCalled();
    const a = container.resolve(DB);
    const b = container.resolve(DB);
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('constructs a transient on every resolve', () => {
    const container = new Container();
    container.transient(DB, () => ({ name: 'pg' }));
    expect(container.resolve(DB)).not.toBe(container.resolve(DB));
  });

  it('returns a pre-built value as-is', () => {
    const container = new Container();
    const instance = { name: 'fixed' };
    container.value(DB, instance);
    expect(container.resolve(DB)).toBe(instance);
  });

  it('injects dependencies through the container', () => {
    const container = new Container();
    container.singleton(DB, () => ({ name: 'pg' }));
    container.singleton(SERVICE, (c) => ({ db: c.resolve(DB) }));
    expect(container.resolve(SERVICE).db.name).toBe('pg');
  });

  it('throws a helpful error for an unregistered token', () => {
    const container = new Container();
    container.singleton(DB, () => ({ name: 'pg' }));
    expect(() => container.resolve(SERVICE)).toThrow(/No registration for token "service"/);
  });

  it('detects a circular dependency and names the cycle', () => {
    const container = new Container();
    const A = token<unknown>('a');
    const B = token<unknown>('b');
    container.singleton(A, (c) => c.resolve(B));
    container.singleton(B, (c) => c.resolve(A));
    expect(() => container.resolve(A)).toThrow(/Circular dependency: a -> b -> a/);
  });

  it('recovers from a failed resolution without leaving a stale stack', () => {
    const container = new Container();
    let shouldThrow = true;
    container.singleton(DB, () => {
      if (shouldThrow) throw new Error('boom');
      return { name: 'pg' };
    });

    expect(() => container.resolve(DB)).toThrow('boom');
    shouldThrow = false;
    // The resolving stack must have been unwound, or this reports a false cycle.
    expect(container.resolve(DB).name).toBe('pg');
  });

  it('reports registration presence', () => {
    const container = new Container();
    container.value(DB, { name: 'x' });
    expect(container.has(DB)).toBe(true);
    expect(container.has(SERVICE)).toBe(false);
  });

  it('disposes constructed singletons in reverse creation order', async () => {
    const container = new Container();
    const order: string[] = [];
    container.singleton(DB, () => ({ name: 'pg' }), {
      dispose: () => {
        order.push('db');
      },
    });
    container.singleton(SERVICE, (c) => ({ db: c.resolve(DB) }), {
      dispose: () => {
        order.push('service');
      },
    });

    container.resolve(SERVICE);
    expect(await container.dispose()).toEqual([]);
    // Service depends on db, so service must be torn down first.
    expect(order).toEqual(['service', 'db']);
  });

  it('does not dispose singletons that were never constructed', async () => {
    const container = new Container();
    const dispose = vi.fn();
    container.singleton(DB, () => ({ name: 'pg' }), { dispose });
    await container.dispose();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('collects disposal errors instead of aborting shutdown', async () => {
    const container = new Container();
    const secondDispose = vi.fn();
    const A = token<{ n: number }>('a');
    const B = token<{ n: number }>('b');

    container.singleton(A, () => ({ n: 1 }), { dispose: secondDispose });
    container.singleton(B, () => ({ n: 2 }), {
      dispose: () => {
        throw new Error('stuck connection');
      },
    });
    container.resolve(A);
    container.resolve(B);

    const errors = await container.dispose();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('stuck connection');
    // The remaining singleton was still disposed.
    expect(secondDispose).toHaveBeenCalled();
  });

  it('rebuilds after disposal', async () => {
    const container = new Container();
    const factory = vi.fn(() => ({ name: 'pg' }));
    container.singleton(DB, factory, { dispose: () => {} });

    container.resolve(DB);
    await container.dispose();
    container.resolve(DB);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('createScope() lets a test override without mutating the parent', () => {
    const parent = new Container();
    parent.singleton(DB, () => ({ name: 'real' }));

    const scope = parent.createScope();
    scope.value(DB, { name: 'fake' });

    expect(scope.resolve(DB).name).toBe('fake');
    expect(parent.resolve(DB).name).toBe('real');
  });
});
