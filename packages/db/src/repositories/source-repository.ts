import type { Source, SourceRepository } from '@cid/core';
import type { Db } from '../client.js';

/**
 * Sources are registered on first use from each connector's descriptor, so the
 * table is always consistent with the code rather than with a fixture someone
 * forgot to update.
 */
export class PrismaSourceRepository implements SourceRepository {
  readonly #db: Db;
  /** Sources change roughly never; cache the key -> row lookup on the hot path. */
  readonly #cache = new Map<string, Source>();

  constructor(db: Db) {
    this.#db = db;
  }

  async findByKey(key: string): Promise<Source | null> {
    const cached = this.#cache.get(key);
    if (cached) return cached;
    const row = await this.#db.source.findUnique({ where: { key } });
    if (row) this.#cache.set(key, row);
    return row;
  }

  async listEnabled(): Promise<Source[]> {
    return this.#db.source.findMany({ where: { isEnabled: true }, orderBy: { key: 'asc' } });
  }

  async ensure(source: Pick<Source, 'key' | 'name' | 'kind'> & Partial<Source>): Promise<Source> {
    const row = await this.#db.source.upsert({
      where: { key: source.key },
      create: {
        key: source.key,
        name: source.name,
        kind: source.kind,
        homepageUrl: source.homepageUrl ?? null,
        credibility: source.credibility ?? 0.5,
        isEnabled: source.isEnabled ?? true,
      },
      // Metadata may be revised in code; a human's `isEnabled` toggle must not
      // be reverted on every restart, so it is deliberately not updated here.
      update: {
        name: source.name,
        kind: source.kind,
        homepageUrl: source.homepageUrl ?? null,
        credibility: source.credibility ?? 0.5,
      },
    });
    this.#cache.set(row.key, row);
    return row;
  }

  async setEnabled(key: string, enabled: boolean): Promise<void> {
    await this.#db.source.update({ where: { key }, data: { isEnabled: enabled } });
    this.#cache.delete(key);
  }

  /**
   * Resolve a source key to its id, for the `sourceKey` -> `sourceId` step every
   * insert path performs. Throws when unknown: a connector writing under an
   * unregistered key is a wiring bug, not a runtime condition.
   */
  async requireId(key: string): Promise<string> {
    const source = await this.findByKey(key);
    if (!source) {
      throw new Error(
        `Unknown source key "${key}". Connectors must be registered before ingesting.`,
      );
    }
    return source.id;
  }

  /** Resolve many keys in one round trip. */
  async resolveIds(keys: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(keys)];
    const missing = unique.filter((key) => !this.#cache.has(key));
    if (missing.length > 0) {
      const rows = await this.#db.source.findMany({ where: { key: { in: missing } } });
      for (const row of rows) this.#cache.set(row.key, row);
    }
    const out = new Map<string, string>();
    for (const key of unique) {
      const source = this.#cache.get(key);
      if (source) out.set(key, source.id);
    }
    return out;
  }

  clearCache(): void {
    this.#cache.clear();
  }
}
