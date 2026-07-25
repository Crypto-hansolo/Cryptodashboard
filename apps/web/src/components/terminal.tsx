'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EVENT_CATEGORIES } from '@cid/core';
import { apiGet, type TimelineItem, type WatchlistItem } from '@/lib/api';
import { cn, formatDuration, formatRelativeTime } from '@/lib/format';
import {
  useDesktopNotifications,
  useLiveStream,
  type LiveAlertPayload,
  type LiveEventPayload,
  type LiveQuotePayload,
  type LiveStatus,
} from '@/lib/use-live-stream';
import { Watchlist } from './watchlist';
import { Timeline, type TimelineFilters } from './timeline';
import { CommandPalette } from './command-palette';
import { AskPanel } from './ask-panel';

/**
 * The terminal shell.
 *
 * Three panes: watchlist, timeline, research console. Live updates arrive over
 * one SSE connection held here and pushed down, rather than each pane opening its
 * own — browsers cap concurrent connections per origin, and three streams would
 * mean three Redis subscriptions per open tab.
 */

export interface TerminalInitialState {
  watchlist: WatchlistItem[];
  timeline: TimelineItem[];
  nextCursor: string | null;
  status: {
    connectors: number;
    failing: number;
    ingestedLastHour: number;
    lagP50Ms: number | null;
  };
}

const STATUS_LABEL: Record<LiveStatus, { label: string; className: string }> = {
  live: { label: 'LIVE', className: 'text-bull' },
  connecting: { label: 'CONNECTING', className: 'text-warn' },
  stale: { label: 'RECONNECTING', className: 'text-warn' },
  error: { label: 'OFFLINE', className: 'text-bear' },
};

export function Terminal({ initial }: { initial: TerminalInitialState }) {
  const [watchlist, setWatchlist] = useState(initial.watchlist);
  const [events, setEvents] = useState(initial.timeline);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [filters, setFilters] = useState<TimelineFilters>({
    coinIds: [],
    categories: [],
    minImportance: null,
    query: '',
  });
  const [alerts, setAlerts] = useState<LiveAlertPayload[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [selectedCoinId, setSelectedCoinId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const { notify, permission, request: requestNotifications } = useDesktopNotifications();

  // ── Live updates ──
  const liveStatus = useLiveStream({
    onEvent: useCallback((payload: LiveEventPayload) => {
      // Prepend, and cap the in-memory list: an unbounded feed on a page left
      // open overnight is a memory leak.
      setEvents((current) => {
        if (current.some((event) => event.id === payload.id)) return current;
        const optimistic: TimelineItem = {
          id: payload.id,
          occurredAt: payload.occurredAt,
          ingestedAt: new Date().toISOString(),
          category: payload.category,
          subtype: null,
          headline: payload.headline,
          summary: null,
          explanation: null,
          url: payload.url,
          author: null,
          importance: payload.importance,
          confidence: null,
          sentiment: payload.sentiment,
          sentimentScore: null,
          impact: null,
          narratives: [],
          isFud: false,
          enriched: false,
          source: { id: '', key: 'live', name: 'live', kind: 'INTERNAL', credibility: 0.5 },
          coin: null,
          duplicateCount: 0,
        };
        return [optimistic, ...current].slice(0, 400);
      });
    }, []),

    onQuote: useCallback((payload: LiveQuotePayload) => {
      setWatchlist((current) =>
        current.map((item) =>
          item.id === payload.coinId && item.quote
            ? {
                ...item,
                quote: {
                  ...item.quote,
                  priceUsd: payload.priceUsd,
                  change24hPct: payload.change24hPct ?? item.quote.change24hPct,
                  observedAt: new Date().toISOString(),
                },
              }
            : item,
        ),
      );
    }, []),

    onAlert: useCallback(
      (payload: LiveAlertPayload) => {
        setAlerts((current) => [payload, ...current].slice(0, 20));
        notify(payload);
      },
      [notify],
    ),
  });

  // ── Keyboard shortcuts ──
  //
  // Deliberately terminal-like. Ignored while typing in an input, so `/` inside
  // the search box types a slash instead of re-opening search.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true;

      if ((event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (typing) {
        if (event.key === 'Escape') target?.blur();
        return;
      }

      switch (event.key) {
        case '/':
          event.preventDefault();
          setPaletteOpen(true);
          break;
        case 'a':
          event.preventDefault();
          setAskOpen((open) => !open);
          break;
        case 'r':
          event.preventDefault();
          void refresh();
          break;
        case 'Escape':
          setPaletteOpen(false);
          setAskOpen(false);
          setSelectedCoinId(null);
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // Bound once for the lifetime of the terminal. `refresh` is read through the
    // closure rather than listed as a dependency, because re-binding a global
    // key handler on every filter change is both wasteful and a source of
    // missed keystrokes mid-swap.
  }, []);

  // ── Data loading ──
  const buildQuery = useCallback(
    (nextCursor?: string | null): string => {
      const params = new URLSearchParams();
      if (filters.coinIds.length > 0) params.set('coinIds', filters.coinIds.join(','));
      if (filters.categories.length > 0) params.set('categories', filters.categories.join(','));
      if (filters.minImportance !== null)
        params.set('minImportance', String(filters.minImportance));
      if (filters.query.trim() !== '') params.set('q', filters.query.trim());
      if (nextCursor) params.set('cursor', nextCursor);
      params.set('limit', '60');
      return params.toString();
    },
    [filters],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const data = await apiGet<{ items: TimelineItem[]; nextCursor: string | null }>(
      `/api/timeline?${buildQuery()}`,
    );
    setEvents(data.items);
    setCursor(data.nextCursor);
  }, [buildQuery]);

  // Re-query whenever filters change. The first render already has server data,
  // so this is skipped on mount.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    void refresh();
  }, [refresh]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await apiGet<{ items: TimelineItem[]; nextCursor: string | null }>(
        `/api/timeline?${buildQuery(cursor)}`,
      );
      setEvents((current) => {
        const seen = new Set(current.map((event) => event.id));
        return [...current, ...data.items.filter((item) => !seen.has(item.id))];
      });
      setCursor(data.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, buildQuery]);

  const refreshWatchlist = useCallback(async (): Promise<void> => {
    const data = await apiGet<{ items: WatchlistItem[] }>('/api/coins');
    setWatchlist(data.items);
  }, []);

  const status = STATUS_LABEL[liveStatus];
  const totalMarketCap = useMemo(
    () => watchlist.reduce((sum, item) => sum + (item.quote?.marketCapUsd ?? 0), 0),
    [watchlist],
  );

  return (
    <div className="flex h-full flex-col">
      {/* ── Top bar ── */}
      <header className="flex shrink-0 items-center gap-3 border-b border-base-700 bg-base-900 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-bold tracking-tight text-ink">CID</span>
          <span className="hidden text-2xs uppercase tracking-widest text-ink-faint sm:inline">
            Crypto Intelligence Terminal
          </span>
        </div>

        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="ml-2 flex min-w-0 flex-1 items-center gap-2 rounded border border-base-600 bg-base-850 px-2 py-1 text-left text-xs text-ink-faint hover:border-base-500"
        >
          <span className="truncate">Search coins, events, anything…</span>
          <span className="ml-auto hidden items-center gap-1 sm:flex">
            <kbd className="kbd">⌘</kbd>
            <kbd className="kbd">K</kbd>
          </span>
        </button>

        <div className="flex items-center gap-3 text-2xs text-ink-faint">
          <span title="Connectors reporting in the last hour">
            {initial.status.connectors - initial.status.failing}/{initial.status.connectors} sources
          </span>
          {initial.status.lagP50Ms !== null && (
            <span title="Median delay between an event happening and being ingested">
              lag {formatDuration(initial.status.lagP50Ms)}
            </span>
          )}
          <span className={cn('font-mono font-semibold', status.className)}>● {status.label}</span>
        </div>

        <button type="button" className="btn btn-ghost" onClick={() => setAskOpen((open) => !open)}>
          Ask AI <kbd className="kbd ml-1">A</kbd>
        </button>
      </header>

      {/* ── Alert banner ── */}
      {alerts.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-warn/30 bg-warn/10 px-3 py-1.5 text-xs">
          <span className="font-semibold text-warn">ALERT</span>
          <span className="truncate text-ink">{alerts[0]?.title}</span>
          <span className="text-ink-faint">
            {alerts[0] ? formatRelativeTime(new Date(alerts[0].triggeredAt)) : ''}
          </span>
          {permission === 'default' && (
            <button
              type="button"
              className="btn btn-ghost ml-auto"
              onClick={() => void requestNotifications()}
            >
              Enable desktop notifications
            </button>
          )}
          <button
            type="button"
            className={cn('btn btn-ghost', permission !== 'default' && 'ml-auto')}
            onClick={() => setAlerts([])}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Panes ── */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="flex min-h-0 shrink-0 flex-col border-b border-base-700 lg:w-80 lg:border-b-0 lg:border-r">
          <Watchlist
            items={watchlist}
            selectedCoinId={selectedCoinId}
            totalMarketCap={totalMarketCap}
            onSelect={(coinId) => {
              // Selecting a coin filters the timeline; selecting it again clears.
              setSelectedCoinId((current) => (current === coinId ? null : coinId));
              setFilters((current) => ({
                ...current,
                coinIds: current.coinIds.includes(coinId) ? [] : [coinId],
              }));
            }}
            onChanged={refreshWatchlist}
          />
        </aside>

        <main className="flex min-h-0 flex-1 flex-col">
          <Timeline
            items={events}
            filters={filters}
            onFiltersChange={setFilters}
            onLoadMore={loadMore}
            hasMore={cursor !== null}
            loadingMore={loadingMore}
            availableCategories={[...EVENT_CATEGORIES]}
          />
        </main>

        {askOpen && (
          <aside className="flex min-h-0 shrink-0 flex-col border-t border-base-700 lg:w-96 lg:border-l lg:border-t-0">
            <AskPanel coinIds={filters.coinIds} onClose={() => setAskOpen(false)} />
          </aside>
        )}
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onCoinAdded={refreshWatchlist}
        onSelectCoin={(coinId) => {
          setSelectedCoinId(coinId);
          setFilters((current) => ({ ...current, coinIds: [coinId] }));
        }}
      />
    </div>
  );
}
