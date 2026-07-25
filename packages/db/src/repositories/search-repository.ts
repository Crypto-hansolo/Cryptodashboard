import type { SearchRepository, SemanticHit } from '@cid/core';
import { Prisma } from '@prisma/client';
import type { Db } from '../client.js';

/**
 * Words carried by almost every question but by no headline. Removing them is
 * what turns a question into a usable OR query rather than one that can never
 * match.
 */
const QUESTION_STOPWORDS = new Set([
  'what',
  'why',
  'how',
  'when',
  'where',
  'which',
  'who',
  'whose',
  'whom',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'am',
  'do',
  'does',
  'did',
  'done',
  'doing',
  'has',
  'have',
  'had',
  'having',
  'can',
  'could',
  'will',
  'would',
  'should',
  'may',
  'might',
  'must',
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'if',
  'then',
  'than',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'with',
  'from',
  'by',
  'about',
  'happened',
  'happening',
  'happen',
  'happens',
  'tell',
  'show',
  'give',
  'list',
  'find',
  'explain',
  'any',
  'anything',
  'me',
  'my',
  'i',
  'you',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'there',
  'here',
  'now',
  'today',
  'yesterday',
  'week',
  'day',
  'time',
  'going',
  'go',
  'get',
  'got',
  'much',
  'many',
  'some',
  'all',
  'more',
  'most',
]);

/**
 * True when the user typed something they expect operator semantics for.
 * Quoted phrases, `-exclusions` and an explicit `or` are all websearch syntax.
 */
function hasSearchOperators(term: string): boolean {
  return /["']/.test(term) || /(^|\s)-\S/.test(term) || /\bor\b/i.test(term);
}

/**
 * Build the tsquery expression for a raw user string.
 * Returns null when nothing searchable remains.
 */
function buildTsQuery(term: string): Prisma.Sql | null {
  if (hasSearchOperators(term)) {
    return Prisma.sql`websearch_to_tsquery('english', ${term})`;
  }

  // Extract alphanumeric terms, drop question filler and single characters.
  const tokens = (term.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (token) => token.length > 1 && !QUESTION_STOPWORDS.has(token),
  );

  // Everything was filler: fall back to the literal string rather than matching
  // the entire table.
  if (tokens.length === 0) {
    return Prisma.sql`websearch_to_tsquery('english', ${term})`;
  }

  // Tokens are alphanumeric-only by construction, so they are safe inside a
  // to_tsquery expression; they are still passed as a bound parameter.
  const orQuery = [...new Set(tokens)].join(' | ');
  return Prisma.sql`to_tsquery('english', ${orQuery})`;
}

/**
 * Semantic and keyword search.
 *
 * Everything here is raw SQL because Prisma cannot express `vector` columns or
 * the `<=>` cosine-distance operator, and because `ts_rank` over a generated
 * tsvector column has no query-builder equivalent either.
 *
 * The two methods are complements, not alternatives: `semanticSearch` needs an
 * embedding model to be configured, and `keywordSearch` is what the UI falls
 * back to when `LLM_PROVIDER=null` or the embedding backlog has not caught up.
 */
export class PrismaSearchRepository implements SearchRepository {
  readonly #db: Db;
  readonly #dimensions: number;

  constructor(db: Db, options: { dimensions?: number } = {}) {
    this.#db = db;
    this.#dimensions = options.dimensions ?? 768;
  }

  /**
   * Format a vector as a pgvector literal.
   *
   * Values are checked to be finite numbers before interpolation. They come from
   * a local model rather than a user, but this string is concatenated into SQL,
   * so it is validated rather than trusted — a NaN would also silently poison
   * every distance comparison against this row.
   */
  #toVectorLiteral(vector: readonly number[]): string {
    if (vector.length !== this.#dimensions) {
      throw new Error(
        `Embedding dimension mismatch: expected ${this.#dimensions}, got ${vector.length}. ` +
          'Changing EMBEDDING_DIMENSIONS requires a migration — see docs/DEVELOPMENT.md.',
      );
    }
    const parts = vector.map((value) => {
      if (!Number.isFinite(value)) throw new Error('Embedding contains a non-finite value');
      return value.toString();
    });
    return `[${parts.join(',')}]`;
  }

  async upsertEmbedding(eventId: string, vector: readonly number[]): Promise<void> {
    const literal = this.#toVectorLiteral(vector);
    // Parameterised except for the vector cast, which pgvector requires as a
    // literal string cast rather than a bound parameter.
    await this.#db.$executeRaw`
      INSERT INTO "EventEmbedding" ("eventId", "vector", "model", "createdAt")
      VALUES (${eventId}, ${literal}::vector, ${'local'}, now())
      ON CONFLICT ("eventId") DO UPDATE SET "vector" = ${literal}::vector, "createdAt" = now()
    `;
  }

  /**
   * Events lacking an embedding, most important first.
   * Bounded to recent history: back-filling years of low-importance events would
   * starve the queue of the ones a user might actually search for.
   */
  async listMissingEmbeddings(
    limit: number,
  ): Promise<Array<{ id: string; headline: string; body: string | null }>> {
    return this.#db.$queryRaw<Array<{ id: string; headline: string; body: string | null }>>`
      SELECT e.id, e.headline, e.body
      FROM "Event" e
      LEFT JOIN "EventEmbedding" emb ON emb."eventId" = e.id
      WHERE emb."eventId" IS NULL
        AND e."occurredAt" > now() - interval '30 days'
      ORDER BY e.importance DESC NULLS LAST, e."occurredAt" DESC
      LIMIT ${limit}
    `;
  }

  /**
   * Approximate nearest-neighbour search over event embeddings.
   *
   * `1 - (vector <=> query)` converts cosine distance to similarity on [0,1],
   * matching the `SemanticHit` contract. The HNSW index serves the ORDER BY.
   */
  async semanticSearch(input: {
    vector: readonly number[];
    limit: number;
    coinIds?: readonly string[];
    from?: Date;
    to?: Date;
    minSimilarity?: number;
  }): Promise<SemanticHit[]> {
    const literal = this.#toVectorLiteral(input.vector);
    const minSimilarity = input.minSimilarity ?? 0;
    const coinIds = input.coinIds?.length ? [...input.coinIds] : null;

    const rows = await this.#db.$queryRaw<Array<{ eventId: string; similarity: number }>>`
      SELECT emb."eventId", 1 - (emb."vector" <=> ${literal}::vector) AS similarity
      FROM "EventEmbedding" emb
      JOIN "Event" e ON e.id = emb."eventId"
      WHERE (${coinIds}::text[] IS NULL OR e."coinId" = ANY(${coinIds}::text[]))
        AND (${input.from ?? null}::timestamptz IS NULL OR e."occurredAt" >= ${input.from ?? null})
        AND (${input.to ?? null}::timestamptz IS NULL OR e."occurredAt" <= ${input.to ?? null})
        AND 1 - (emb."vector" <=> ${literal}::vector) >= ${minSimilarity}
      ORDER BY emb."vector" <=> ${literal}::vector
      LIMIT ${input.limit}
    `;

    return rows.map((row) => ({ eventId: row.eventId, similarity: Number(row.similarity) }));
  }

  /**
   * Postgres full-text search, normalised onto the same [0,1] similarity scale
   * as the semantic path so the two can be blended or swapped transparently.
   *
   * Two query modes, because this endpoint serves two very different callers:
   *
   *  - A search box, where the user types operators they expect to work
   *    ("binance listing" -delist, quoted phrases). `websearch_to_tsquery`
   *    handles those, and its AND semantics are what the user means.
   *
   *  - The research agent, which passes a whole natural-language question.
   *    ANDing every word there matches nothing: "What happened with Binance?"
   *    requires `happen & binanc`, and no headline contains "happened". The
   *    agent's questions used to return zero evidence for exactly this reason.
   *    So a plain question becomes an OR of its significant terms and lets
   *    `ts_rank` do the ordering — retrieval, not filtering.
   */
  async keywordSearch(input: {
    query: string;
    limit: number;
    coinIds?: readonly string[];
    from?: Date;
    to?: Date;
  }): Promise<SemanticHit[]> {
    const term = input.query.trim();
    if (term === '') return [];
    const coinIds = input.coinIds?.length ? [...input.coinIds] : null;

    const tsquery = buildTsQuery(term);
    // No usable terms at all (e.g. "???") — nothing to search for.
    if (tsquery === null) return [];

    const rows = await this.#db.$queryRaw<Array<{ id: string; rank: number }>>`
      SELECT e.id, ts_rank(e."searchVector", ${tsquery}) AS rank
      FROM "Event" e
      WHERE e."searchVector" @@ ${tsquery}
        AND (${coinIds}::text[] IS NULL OR e."coinId" = ANY(${coinIds}::text[]))
        AND (${input.from ?? null}::timestamptz IS NULL OR e."occurredAt" >= ${input.from ?? null})
        AND (${input.to ?? null}::timestamptz IS NULL OR e."occurredAt" <= ${input.to ?? null})
      ORDER BY rank DESC, e."occurredAt" DESC
      LIMIT ${input.limit}
    `;

    // ts_rank is unbounded above; squash it so callers can compare against
    // cosine similarities without needing to know which path produced the hit.
    return rows.map((row) => ({
      eventId: row.id,
      similarity: Math.min(1, Number(row.rank) * 4),
    }));
  }

  /**
   * Blended search: semantic recall plus lexical precision.
   *
   * Embeddings miss exact tokens (a ticker, a contract address, a version
   * number) and full-text misses paraphrase. Running both and merging scores
   * beats either alone, which is why this is the default the API uses.
   */
  async hybridSearch(input: {
    query: string;
    vector?: readonly number[] | null;
    limit: number;
    coinIds?: readonly string[];
    from?: Date;
    to?: Date;
  }): Promise<SemanticHit[]> {
    const overFetch = Math.max(input.limit * 2, 20);

    const [keyword, semantic] = await Promise.all([
      this.keywordSearch({ ...input, limit: overFetch }),
      input.vector
        ? this.semanticSearch({ ...input, vector: input.vector, limit: overFetch })
        : Promise.resolve<SemanticHit[]>([]),
    ]);

    // Weighted merge, semantic favoured slightly for recall on paraphrase.
    const scores = new Map<string, number>();
    for (const hit of semantic) {
      scores.set(hit.eventId, (scores.get(hit.eventId) ?? 0) + hit.similarity * 0.6);
    }
    for (const hit of keyword) {
      scores.set(hit.eventId, (scores.get(hit.eventId) ?? 0) + hit.similarity * 0.4);
    }

    return [...scores.entries()]
      .map(([eventId, similarity]) => ({ eventId, similarity: Math.min(1, similarity) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, input.limit);
  }

  /** How much of the recent corpus is embedded — surfaced on the status page. */
  async embeddingCoverage(): Promise<{ embedded: number; total: number }> {
    const rows = await this.#db.$queryRaw<Array<{ embedded: bigint; total: bigint }>>`
      SELECT
        count(emb."eventId") AS embedded,
        count(e.id) AS total
      FROM "Event" e
      LEFT JOIN "EventEmbedding" emb ON emb."eventId" = e.id
      WHERE e."occurredAt" > now() - interval '30 days'
    `;
    const row = rows[0];
    return { embedded: Number(row?.embedded ?? 0), total: Number(row?.total ?? 0) };
  }

  /** Guard used by the AI layer before it tries a vector query. */
  static isVectorDimensionError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      typeof error.message === 'string' &&
      error.message.includes('vector')
    );
  }
}
