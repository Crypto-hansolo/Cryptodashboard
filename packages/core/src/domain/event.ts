import { z } from 'zod';
import {
  eventCategorySchema,
  impactLevelSchema,
  sentimentLabelSchema,
  sourceKindSchema,
} from './enums.js';

/**
 * `Event` is the spine of the platform.
 *
 * Every connector, regardless of domain, normalises its output into an Event.
 * The typed domain records (MarketSnapshot, NewsArticle, OnchainEvent, ...) keep
 * their full fidelity in their own tables and reference the Event that
 * represents them on the timeline. That split is what lets the timeline, alert
 * engine, semantic search and report generators each work against exactly one
 * shape while analytics still gets properly typed columns.
 */

export const sourceSchema = z.object({
  id: z.string(),
  /** Stable machine key, e.g. `coindesk`, `binance`, `github`. */
  key: z.string().min(1),
  name: z.string().min(1),
  kind: sourceKindSchema,
  homepageUrl: z.string().url().nullable().default(null),
  /**
   * Editorial trust on [0,1]. Feeds directly into importance scoring, so a
   * scraped aggregator cannot outrank a primary announcement.
   */
  credibility: z.number().min(0).max(1).default(0.5),
  isEnabled: z.boolean().default(true),
  createdAt: z.date(),
});
export type Source = z.infer<typeof sourceSchema>;

/** AI-produced assessment attached to an event. All fields optional pre-enrichment. */
export const intelligenceSchema = z.object({
  summary: z.string().nullable().default(null),
  /** Why this matters / why the market reacted. Longer-form than `summary`. */
  explanation: z.string().nullable().default(null),
  sentiment: sentimentLabelSchema.nullable().default(null),
  /** Continuous sentiment on [-1,1]; the label is derived from it. */
  sentimentScore: z.number().min(-1).max(1).nullable().default(null),
  importance: z.number().int().min(1).max(100).nullable().default(null),
  confidence: z.number().int().min(1).max(100).nullable().default(null),
  impact: impactLevelSchema.nullable().default(null),
  /** Narrative labels the model attached, e.g. ["restaking", "etf-flows"]. */
  narratives: z.array(z.string()).default([]),
  /** True when the model judged the item to be coordinated FUD or hype. */
  isFud: z.boolean().default(false),
  /** Model that produced the assessment, for reproducibility. */
  model: z.string().nullable().default(null),
  enrichedAt: z.date().nullable().default(null),
});
export type Intelligence = z.infer<typeof intelligenceSchema>;

export const eventSchema = z.object({
  id: z.string(),
  /** When the thing actually happened upstream (not when we saw it). */
  occurredAt: z.date(),
  /** When our pipeline first stored it. `ingestedAt - occurredAt` is our lag SLO. */
  ingestedAt: z.date(),
  coinId: z.string().nullable().default(null),
  sourceId: z.string(),
  category: eventCategorySchema,
  /** Connector-specific refinement of `category`, e.g. `GITHUB_RELEASE`. */
  subtype: z.string().nullable().default(null),
  headline: z.string().min(1),
  body: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  author: z.string().nullable().default(null),
  /**
   * Stable hash over normalised content. Unique per source, and the basis for
   * cross-source near-duplicate clustering.
   */
  dedupeHash: z.string().min(1),
  /** Cluster key shared by all events reporting the same underlying story. */
  clusterId: z.string().nullable().default(null),
  intelligence: intelligenceSchema,
  /** Verbatim connector payload. Never read by business logic — audit only. */
  payload: z.record(z.unknown()).default({}),
  /** Additional coins mentioned but not the primary subject. */
  relatedCoinIds: z.array(z.string()).default([]),
});
export type Event = z.infer<typeof eventSchema>;

/**
 * What a connector emits. `dedupeHash` is computed by the ingestion service
 * (not the connector) so the hashing rule stays in one place, and ids/timestamps
 * are assigned by the repository.
 */
export const eventDraftSchema = z.object({
  occurredAt: z.date(),
  /** Resolved to a `sourceId` during ingestion. */
  sourceKey: z.string().min(1),
  coinId: z.string().nullable().optional(),
  category: eventCategorySchema,
  subtype: z.string().nullable().optional(),
  headline: z.string().min(1),
  body: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
  payload: z.record(z.unknown()).optional(),
  relatedCoinIds: z.array(z.string()).optional(),
  /**
   * Connector-supplied importance hint on [1,100]. The scoring service treats
   * it as a prior and may override it — a Binance listing is objectively big
   * regardless of what the LLM thinks of the wording.
   */
  importanceHint: z.number().int().min(1).max(100).nullable().optional(),
  /** Pre-computed sentiment when the source provides one (e.g. funding rate sign). */
  sentimentHint: z.number().min(-1).max(1).nullable().optional(),
});
export type EventDraft = z.infer<typeof eventDraftSchema>;

/** An event joined with the display data the timeline needs. */
export interface TimelineEntry {
  event: Event;
  source: Pick<Source, 'id' | 'key' | 'name' | 'kind' | 'credibility'>;
  coin: { id: string; symbol: string; name: string; imageUrl: string | null } | null;
  /** Count of other events in the same dedupe cluster. */
  duplicateCount: number;
}

// ─── Timeline querying ───────────────────────────────────────────────────────

export const timelineFilterSchema = z.object({
  coinIds: z.array(z.string()).optional(),
  categories: z.array(eventCategorySchema).optional(),
  sourceKeys: z.array(z.string()).optional(),
  sentiments: z.array(sentimentLabelSchema).optional(),
  impacts: z.array(impactLevelSchema).optional(),
  minImportance: z.number().int().min(1).max(100).optional(),
  from: z.date().optional(),
  to: z.date().optional(),
  /** Free-text match against headline/body. Distinct from semantic search. */
  query: z.string().optional(),
  /** Collapse dedupe clusters to a single representative row. */
  collapseDuplicates: z.boolean().default(true),
  limit: z.number().int().min(1).max(500).default(100),
  /** Opaque keyset-pagination cursor. */
  cursor: z.string().nullish(),
});
export type TimelineFilter = z.infer<typeof timelineFilterSchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  /** Total is intentionally optional: counting millions of rows per request is not free. */
  total?: number;
}
