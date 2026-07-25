-- Search indexes that Prisma's schema language cannot express.
--
-- Kept as a hand-written migration rather than raw SQL executed at boot so that
-- it is versioned, reviewable and applied exactly once.

-- ─── Semantic search: approximate nearest neighbour over event embeddings ────
--
-- HNSW rather than IVFFlat: IVFFlat needs a representative training set to build
-- its lists, and this table starts empty and grows continuously, so an IVFFlat
-- index built on day one degrades badly. HNSW builds incrementally and gives
-- better recall at the cost of a slower insert, which is the right trade here
-- (one insert per event, many searches per event).
--
-- vector_cosine_ops because embeddings are normalised and the repository ranks
-- by cosine distance (`<=>`).
CREATE INDEX IF NOT EXISTS "EventEmbedding_vector_hnsw_idx"
  ON "EventEmbedding"
  USING hnsw ("vector" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ─── Keyword search: the fallback when no embedding model is configured ──────
--
-- A generated tsvector column with a GIN index, weighting the headline above the
-- body ('A' vs 'B') so a title match outranks a passing mention.
-- STORED, not an expression index: the ranking query needs to read the vector
-- back for ts_rank, and recomputing to_tsvector per row at query time is what
-- makes naive full-text search slow.
ALTER TABLE "Event"
  ADD COLUMN IF NOT EXISTS "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("headline", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("body", '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS "Event_searchVector_idx"
  ON "Event"
  USING GIN ("searchVector");

-- Trigram index on headlines, for fuzzy "did you mean" matching and for
-- substring filters in the timeline that a tsvector cannot serve (partial words,
-- ticker fragments).
CREATE INDEX IF NOT EXISTS "Event_headline_trgm_idx"
  ON "Event"
  USING GIN ("headline" gin_trgm_ops);

-- Coin search: users type partial names and misspellings into the command
-- palette, so both columns get trigram coverage.
CREATE INDEX IF NOT EXISTS "Coin_name_trgm_idx"
  ON "Coin"
  USING GIN ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Coin_symbol_trgm_idx"
  ON "Coin"
  USING GIN ("symbol" gin_trgm_ops);

-- ─── Partial indexes for hot, selective queries ─────────────────────────────

-- The enrichment queue only ever scans un-enriched rows. A partial index keeps
-- it proportional to the backlog rather than to the whole (millions of rows)
-- table.
CREATE INDEX IF NOT EXISTS "Event_pending_enrichment_idx"
  ON "Event" ("importance" DESC NULLS LAST, "occurredAt" DESC)
  WHERE "enrichedAt" IS NULL;

-- Same argument for the embedding backfill queue.
CREATE INDEX IF NOT EXISTS "Event_high_importance_idx"
  ON "Event" ("occurredAt" DESC)
  WHERE "importance" >= 65;

-- Pending notification deliveries are a small working set inside a table that
-- grows forever.
CREATE INDEX IF NOT EXISTS "NotificationDelivery_pending_idx"
  ON "NotificationDelivery" ("createdAt")
  WHERE "status" = 'PENDING';
