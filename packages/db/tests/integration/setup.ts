import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import type { PrismaClient } from '@prisma/client';
import { buildRepositories, type CidRepositories } from '../../src/index.js';

/**
 * Integration-test harness.
 *
 * These tests run against a real Postgres with pgvector, because the whole point
 * of the repository layer is the SQL — keyset pagination, `DISTINCT ON`,
 * `date_bin` bucketing, HNSW vector search, the conditional alert claim. None of
 * that is exercised by a mock, and all of it is easy to get subtly wrong.
 *
 * Bring the dependencies up with:
 *   docker compose up -d postgres redis
 *   npm run db:migrate:deploy
 *
 * Without DATABASE_URL the suite skips rather than fails, so `npm test` stays
 * runnable on a laptop with nothing installed.
 */

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env') });

/**
 * Guard against truncating a real database.
 *
 * `resetDatabase` TRUNCATEs every table, and this harness previously defaulted
 * to whatever `DATABASE_URL` pointed at — which meant `npm run test:integration`
 * silently destroyed a developer's working data (it destroyed the seed data on
 * this machine, which is how the guard came to exist).
 *
 * So: prefer an explicit `TEST_DATABASE_URL`, and otherwise only accept a
 * `DATABASE_URL` whose database name marks it as disposable. Anything else makes
 * the suite skip with a loud message rather than run destructively.
 */
function resolveTestDatabaseUrl(): { url: string | undefined; reason: string | null } {
  const explicit = process.env.TEST_DATABASE_URL;
  if (explicit) return { url: explicit, reason: null };

  const fallback = process.env.DATABASE_URL;
  if (!fallback) {
    return { url: undefined, reason: 'neither TEST_DATABASE_URL nor DATABASE_URL is set' };
  }

  let databaseName: string;
  try {
    databaseName = new URL(fallback).pathname.replace(/^\//, '');
  } catch {
    return { url: undefined, reason: `DATABASE_URL is not a valid URL: ${fallback}` };
  }

  if (/(^|[_-])(test|ci|e2e)(_|-|$)/i.test(databaseName)) {
    return { url: fallback, reason: null };
  }

  return {
    url: undefined,
    reason:
      `refusing to run destructive integration tests against database "${databaseName}". ` +
      'Set TEST_DATABASE_URL, or point DATABASE_URL at a database whose name contains ' +
      '"test", "ci" or "e2e". These tests TRUNCATE every table.',
  };
}

const resolved = resolveTestDatabaseUrl();

export const DATABASE_URL = resolved.url;
export const hasDatabase = Boolean(DATABASE_URL);

if (!hasDatabase && resolved.reason) {
  // Printed once per run so a skipped suite is never mistaken for a passing one.
  console.warn(`[integration] skipped: ${resolved.reason}`);
}

export interface TestContext {
  db: PrismaClient;
  repositories: CidRepositories;
}

export function createTestContext(): TestContext {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required for integration tests');
  const { db, repositories } = buildRepositories({ databaseUrl: DATABASE_URL });
  return { db, repositories };
}

/**
 * Truncate everything between tests.
 *
 * One statement with CASCADE and RESTART IDENTITY: per-table deleteMany in
 * dependency order is both slower and a maintenance burden every time a relation
 * is added. `_prisma_migrations` is preserved so the schema stays applied.
 */
export async function resetDatabase(db: PrismaClient): Promise<void> {
  const tables = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
  `;
  if (tables.length === 0) return;
  const list = tables.map((row) => `"public"."${row.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/** Register the source rows that ingestion paths resolve `sourceKey` against. */
export async function seedSources(db: PrismaClient): Promise<Map<string, string>> {
  const specs = [
    { key: 'coingecko', name: 'CoinGecko', kind: 'MARKET_DATA' as const, credibility: 0.9 },
    { key: 'coindesk', name: 'CoinDesk', kind: 'NEWS' as const, credibility: 0.85 },
    { key: 'theblock', name: 'The Block', kind: 'NEWS' as const, credibility: 0.88 },
    { key: 'binance', name: 'Binance', kind: 'DERIVATIVES' as const, credibility: 0.95 },
    { key: 'etherscan', name: 'Etherscan', kind: 'ONCHAIN' as const, credibility: 0.95 },
    { key: 'github', name: 'GitHub', kind: 'CODE' as const, credibility: 0.95 },
    { key: 'snapshot', name: 'Snapshot', kind: 'GOVERNANCE' as const, credibility: 0.9 },
    { key: 'x', name: 'X', kind: 'SOCIAL' as const, credibility: 0.45 },
  ];
  const out = new Map<string, string>();
  for (const spec of specs) {
    const row = await db.source.upsert({
      where: { key: spec.key },
      create: spec,
      update: {},
    });
    out.set(row.key, row.id);
  }
  return out;
}

export async function seedCoin(
  db: PrismaClient,
  overrides: { slug?: string; symbol?: string; name?: string; rank?: number } = {},
): Promise<string> {
  const slug = overrides.slug ?? 'bitcoin';
  const row = await db.coin.upsert({
    where: { slug },
    create: {
      slug,
      symbol: overrides.symbol ?? 'BTC',
      name: overrides.name ?? 'Bitcoin',
      coingeckoId: slug,
      marketCapRank: overrides.rank ?? 1,
    },
    update: {},
  });
  return row.id;
}

export async function seedUser(db: PrismaClient, email = 'test@localhost'): Promise<string> {
  const row = await db.user.upsert({ where: { email }, create: { email }, update: {} });
  return row.id;
}

/** Deterministic unit vector of the configured dimension, for embedding tests. */
export function makeVector(seed: number, dimensions = 768): number[] {
  const vector = new Array<number>(dimensions);
  let state = seed || 1;
  for (let i = 0; i < dimensions; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    vector[i] = (state / 0x7fffffff) * 2 - 1;
  }
  // Normalise so cosine distance behaves predictably.
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / magnitude);
}
