import { ConfigError } from '@cid/core';

/**
 * A small typed DI container.
 *
 * Deliberately not `tsyringe`/`inversify`: those need decorators and
 * `reflect-metadata`, which conflicts with the "core must be bundlable for the
 * browser" constraint and adds a build-order dependency for very little gain at
 * this size. What we actually need is (a) lazy singletons, (b) type-safe
 * resolution, (c) override-in-tests, and (d) ordered shutdown. That is ~100
 * lines, and the compiler still catches a wrong-typed registration.
 *
 *   const DB = token<PrismaClient>('db');
 *   container.singleton(DB, () => new PrismaClient(), { dispose: (c) => c.$disconnect() });
 *   const db = container.resolve(DB);
 */

declare const brand: unique symbol;

/** An opaque, type-carrying key. The phantom type is what makes resolve() typed. */
export interface Token<T> {
  readonly name: string;
  readonly [brand]?: T;
}

export function token<T>(name: string): Token<T> {
  return { name };
}

type Factory<T> = (container: Container) => T;

interface Registration<T> {
  factory: Factory<T>;
  /** Singletons are cached; transients are constructed per resolve. */
  singleton: boolean;
  dispose?: (value: T) => Promise<void> | void;
  instance?: T;
  hasInstance: boolean;
}

export class Container {
  #registrations = new Map<string, Registration<unknown>>();
  /** Resolution stack, used to produce a readable cycle error. */
  #resolving: string[] = [];
  /** Creation order, so shutdown can run in reverse. */
  #created: string[] = [];

  /** Register a lazily-constructed process-wide singleton. */
  singleton<T>(
    key: Token<T>,
    factory: Factory<T>,
    options: { dispose?: (value: T) => Promise<void> | void } = {},
  ): this {
    this.#registrations.set(key.name, {
      factory: factory as Factory<unknown>,
      singleton: true,
      dispose: options.dispose as ((value: unknown) => Promise<void> | void) | undefined,
      hasInstance: false,
    });
    return this;
  }

  /** Register a factory that runs on every resolve. */
  transient<T>(key: Token<T>, factory: Factory<T>): this {
    this.#registrations.set(key.name, {
      factory: factory as Factory<unknown>,
      singleton: false,
      hasInstance: false,
    });
    return this;
  }

  /** Register an already-built value. Used for config and for test doubles. */
  value<T>(key: Token<T>, instance: T): this {
    this.#registrations.set(key.name, {
      factory: () => instance,
      singleton: true,
      instance,
      hasInstance: true,
    });
    return this;
  }

  has<T>(key: Token<T>): boolean {
    return this.#registrations.has(key.name);
  }

  resolve<T>(key: Token<T>): T {
    const registration = this.#registrations.get(key.name) as Registration<T> | undefined;
    if (!registration) {
      throw new ConfigError(`No registration for token "${key.name}"`, {
        registered: [...this.#registrations.keys()],
      });
    }

    if (registration.singleton && registration.hasInstance) {
      return registration.instance as T;
    }

    if (this.#resolving.includes(key.name)) {
      throw new ConfigError(`Circular dependency: ${[...this.#resolving, key.name].join(' -> ')}`);
    }

    this.#resolving.push(key.name);
    try {
      const instance = registration.factory(this);
      if (registration.singleton) {
        registration.instance = instance;
        registration.hasInstance = true;
        this.#created.push(key.name);
      }
      return instance;
    } finally {
      this.#resolving.pop();
    }
  }

  /**
   * Dispose every constructed singleton in reverse creation order, so a
   * dependency outlives its dependents. Errors are collected rather than thrown
   * so one stuck connection cannot block the rest of shutdown.
   */
  async dispose(): Promise<Error[]> {
    const errors: Error[] = [];
    for (const name of [...this.#created].reverse()) {
      const registration = this.#registrations.get(name);
      if (!registration?.dispose || !registration.hasInstance) continue;
      try {
        await registration.dispose(registration.instance);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
      registration.hasInstance = false;
      registration.instance = undefined;
    }
    this.#created = [];
    return errors;
  }

  /**
   * Child container for request or test scoping. Overrides shadow the parent
   * without mutating it, so parallel tests do not interfere.
   */
  createScope(): Container {
    const child = new Container();
    for (const [name, registration] of this.#registrations) {
      // Share resolved singletons; re-register the rest so the child builds
      // its own copies.
      child.#registrations.set(name, { ...registration });
    }
    return child;
  }
}

export const rootContainer = new Container();
