/**
 * Typed fetch helpers for the client.
 *
 * Thin on purpose — no data-fetching library. The app has a handful of endpoints
 * and one live stream, and SWR/React Query would mostly duplicate what the SSE
 * connection already provides (server-driven invalidation).
 */

export interface ApiError {
  code: string;
  message: string;
}

export class ApiRequestError extends Error {
  readonly code: string;

  constructor(error: ApiError) {
    super(error.message);
    this.name = 'ApiRequestError';
    this.code = error.code;
  }
}

export async function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { accept: 'application/json' } });
  const body = (await response.json().catch(() => null)) as T | { error: ApiError } | null;

  if (!response.ok || body === null) {
    const error = (body as { error?: ApiError } | null)?.error;
    throw new ApiRequestError(error ?? { code: 'INTERNAL', message: `HTTP ${response.status}` });
  }
  if (typeof body === 'object' && body !== null && 'error' in body) {
    throw new ApiRequestError((body as { error: ApiError }).error);
  }
  return body as T;
}

export async function apiSend<T>(
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  payload?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const body = (await response.json().catch(() => null)) as T | { error: ApiError } | null;

  if (!response.ok || body === null) {
    const error = (body as { error?: ApiError } | null)?.error;
    throw new ApiRequestError(error ?? { code: 'INTERNAL', message: `HTTP ${response.status}` });
  }
  if (typeof body === 'object' && body !== null && 'error' in body) {
    throw new ApiRequestError((body as { error: ApiError }).error);
  }
  return body as T;
}

// ─── Wire types, mirroring the API route responses ───────────────────────────

export interface TimelineItem {
  id: string;
  occurredAt: string;
  ingestedAt: string;
  category: string;
  subtype: string | null;
  headline: string;
  summary: string | null;
  explanation: string | null;
  url: string | null;
  author: string | null;
  importance: number | null;
  confidence: number | null;
  sentiment: string | null;
  sentimentScore: number | null;
  impact: string | null;
  narratives: string[];
  isFud: boolean;
  enriched: boolean;
  source: { id: string; key: string; name: string; kind: string; credibility: number };
  coin: { id: string; symbol: string; name: string; imageUrl: string | null } | null;
  duplicateCount: number;
}

export interface WatchlistItem {
  id: string;
  slug: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  chain: string | null;
  marketCapRank: number | null;
  isPinned: boolean;
  position: number;
  tags: Array<{ id: string; name: string; color: string }>;
  quote: {
    priceUsd: number;
    marketCapUsd: number | null;
    volume24hUsd: number | null;
    change1hPct: number | null;
    change24hPct: number | null;
    change7dPct: number | null;
    observedAt: string;
  } | null;
}

export interface SearchHit {
  id: string;
  slug: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  marketCapRank: number | null;
  score: number;
  matchedOn: string;
  tracked: boolean;
}
