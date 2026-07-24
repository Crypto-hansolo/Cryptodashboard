import { z } from 'zod';
import {
  eventCategorySchema,
  impactLevelSchema,
  notificationChannelSchema,
  deliveryStatusSchema,
  onchainEventTypeSchema,
  proposalStateSchema,
  sentimentLabelSchema,
} from './enums.js';
import { socialPlatformSchema } from './content.js';

/**
 * Alert rules are declarative data, not code.
 *
 * A discriminated union keeps them (a) storable as JSON, (b) editable from the
 * UI without a deploy, (c) validatable with a single `parse`, and (d) evaluable
 * by a pure function — see services/alert-engine.ts. Adding a rule type means
 * adding a variant here and a case there; nothing else in the system changes.
 */

const comparatorSchema = z.enum(['ABOVE', 'BELOW']);
export type Comparator = z.infer<typeof comparatorSchema>;

const directionSchema = z.enum(['UP', 'DOWN', 'ANY']);
export type Direction = z.infer<typeof directionSchema>;

/** Empty `coinIds` means "any tracked coin" for every rule type. */
const coinScope = z.array(z.string()).default([]);

export const priceChangeRuleSchema = z.object({
  type: z.literal('PRICE_CHANGE'),
  coinIds: coinScope,
  windowMinutes: z.number().int().positive().max(10_080).default(60),
  /** Absolute percentage move, e.g. 5 for ">5%". */
  thresholdPct: z.number().positive(),
  direction: directionSchema.default('ANY'),
});

export const priceLevelRuleSchema = z.object({
  type: z.literal('PRICE_LEVEL'),
  coinIds: coinScope,
  comparator: comparatorSchema,
  price: z.number().positive(),
});

export const volumeSpikeRuleSchema = z.object({
  type: z.literal('VOLUME_SPIKE'),
  coinIds: coinScope,
  /** Multiple of the trailing baseline volume, e.g. 3 for "3x". */
  multiplier: z.number().positive().default(3),
});

export const eventMatchRuleSchema = z.object({
  type: z.literal('EVENT_MATCH'),
  coinIds: coinScope,
  categories: z.array(eventCategorySchema).default([]),
  subtypes: z.array(z.string()).default([]),
  sourceKeys: z.array(z.string()).default([]),
  sentiments: z.array(sentimentLabelSchema).default([]),
  impacts: z.array(impactLevelSchema).default([]),
  minImportance: z.number().int().min(1).max(100).nullable().default(null),
  /** Case-insensitive substrings; any match counts. */
  keywords: z.array(z.string()).default([]),
});

export const exchangeListingRuleSchema = z.object({
  type: z.literal('EXCHANGE_LISTING'),
  coinIds: coinScope,
  /** Venue keys to watch, e.g. ["binance"]. Empty = any venue. */
  venues: z.array(z.string()).default([]),
});

export const githubReleaseRuleSchema = z.object({
  type: z.literal('GITHUB_RELEASE'),
  coinIds: coinScope,
  repos: z.array(z.string()).default([]),
});

export const whaleTransferRuleSchema = z.object({
  type: z.literal('WHALE_TRANSFER'),
  coinIds: coinScope,
  minUsd: z.number().positive().default(1_000_000),
  types: z.array(onchainEventTypeSchema).default([]),
});

export const tokenUnlockRuleSchema = z.object({
  type: z.literal('TOKEN_UNLOCK'),
  coinIds: coinScope,
  /** Fire this many hours before the unlock timestamp. */
  leadTimeHours: z.number().positive().default(24),
  /** Ignore unlocks smaller than this fraction of circulating supply. */
  minPctOfCirculating: z.number().min(0).max(1).default(0.005),
});

export const governanceRuleSchema = z.object({
  type: z.literal('GOVERNANCE_PROPOSAL'),
  coinIds: coinScope,
  states: z.array(proposalStateSchema).default(['ACTIVE']),
});

export const sentimentShiftRuleSchema = z.object({
  type: z.literal('SENTIMENT_SHIFT'),
  coinIds: coinScope,
  /** Minimum absolute change in mean sentiment on the [-1,1] scale. */
  minDelta: z.number().positive().max(2).default(0.4),
  direction: directionSchema.default('ANY'),
});

export const fundingRateRuleSchema = z.object({
  type: z.literal('FUNDING_RATE'),
  coinIds: coinScope,
  comparator: comparatorSchema,
  /** Funding rate as a fraction, e.g. 0.001 for 10bp. */
  threshold: z.number(),
});

export const socialVelocityRuleSchema = z.object({
  type: z.literal('SOCIAL_VELOCITY'),
  coinIds: coinScope,
  platforms: z.array(socialPlatformSchema).default([]),
  /** Mentions relative to trailing baseline; 5 = a 5x spike. */
  minVelocity: z.number().positive().default(4),
});

export const authorPostRuleSchema = z.object({
  type: z.literal('AUTHOR_POST'),
  coinIds: coinScope,
  /** Handles to watch, case-insensitive, without a leading `@`. */
  handles: z.array(z.string()).default([]),
  /** Restrict to accounts the platform marks as verified. */
  verifiedOnly: z.boolean().default(false),
});

export const breakingNewsRuleSchema = z.object({
  type: z.literal('BREAKING_NEWS'),
  coinIds: coinScope,
  minImportance: z.number().int().min(1).max(100).default(75),
});

export const alertRuleSchema = z.discriminatedUnion('type', [
  priceChangeRuleSchema,
  priceLevelRuleSchema,
  volumeSpikeRuleSchema,
  eventMatchRuleSchema,
  exchangeListingRuleSchema,
  githubReleaseRuleSchema,
  whaleTransferRuleSchema,
  tokenUnlockRuleSchema,
  governanceRuleSchema,
  sentimentShiftRuleSchema,
  fundingRateRuleSchema,
  socialVelocityRuleSchema,
  authorPostRuleSchema,
  breakingNewsRuleSchema,
]);
export type AlertRule = z.infer<typeof alertRuleSchema>;
export type AlertRuleType = AlertRule['type'];

export const ALERT_RULE_TYPES = [
  'PRICE_CHANGE',
  'PRICE_LEVEL',
  'VOLUME_SPIKE',
  'EVENT_MATCH',
  'EXCHANGE_LISTING',
  'GITHUB_RELEASE',
  'WHALE_TRANSFER',
  'TOKEN_UNLOCK',
  'GOVERNANCE_PROPOSAL',
  'SENTIMENT_SHIFT',
  'FUNDING_RATE',
  'SOCIAL_VELOCITY',
  'AUTHOR_POST',
  'BREAKING_NEWS',
] as const satisfies readonly AlertRuleType[];

export const alertSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string().min(1),
  rule: alertRuleSchema,
  channels: z.array(notificationChannelSchema).min(1),
  isEnabled: z.boolean().default(true),
  /** Minimum seconds between two firings of this alert. Prevents alert storms. */
  cooldownSeconds: z.number().int().min(0).default(300),
  lastTriggeredAt: z.date().nullable().default(null),
  triggerCount: z.number().int().nonnegative().default(0),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Alert = z.infer<typeof alertSchema>;

export const alertDraftSchema = alertSchema.omit({
  id: true,
  lastTriggeredAt: true,
  triggerCount: true,
  createdAt: true,
  updatedAt: true,
});
export type AlertDraft = z.infer<typeof alertDraftSchema>;

export const alertTriggerSchema = z.object({
  id: z.string(),
  alertId: z.string(),
  /** The event that caused the firing, when the signal was event-shaped. */
  eventId: z.string().nullable().default(null),
  coinId: z.string().nullable().default(null),
  triggeredAt: z.date(),
  title: z.string().min(1),
  message: z.string(),
  /** Numeric value that crossed the threshold, for display ("+7.4%"). */
  observedValue: z.number().nullable().default(null),
  payload: z.record(z.unknown()).default({}),
});
export type AlertTrigger = z.infer<typeof alertTriggerSchema>;

export const notificationDeliverySchema = z.object({
  id: z.string(),
  triggerId: z.string(),
  channel: notificationChannelSchema,
  status: deliveryStatusSchema,
  attempts: z.number().int().nonnegative().default(0),
  error: z.string().nullable().default(null),
  sentAt: z.date().nullable().default(null),
  createdAt: z.date(),
});
export type NotificationDelivery = z.infer<typeof notificationDeliverySchema>;
