'use client';

import { useState } from 'react';
import { apiSend, type WatchlistItem } from '@/lib/api';
import { changeClass, cn, formatPercent, formatUsd } from '@/lib/format';

/**
 * The watchlist pane.
 *
 * Pinned coins sort first — the same ordering the scheduler uses to prioritise
 * polling, so what you see at the top is also what updates fastest.
 */
export function Watchlist({
  items,
  selectedCoinId,
  totalMarketCap,
  onSelect,
  onChanged,
}: {
  items: WatchlistItem[];
  selectedCoinId: string | null;
  totalMarketCap: number;
  onSelect: (coinId: string) => void;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const togglePin = async (item: WatchlistItem): Promise<void> => {
    setBusyId(item.id);
    try {
      await apiSend('/api/coins', 'PATCH', {
        action: 'pin',
        coinId: item.id,
        pinned: !item.isPinned,
      });
      onChanged();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (item: WatchlistItem): Promise<void> => {
    setBusyId(item.id);
    try {
      await apiSend(`/api/coins?coinId=${encodeURIComponent(item.id)}`, 'DELETE');
      onChanged();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="panel-header shrink-0 bg-base-900">
        <h2 className="panel-title">Watchlist · {items.length}</h2>
        {totalMarketCap > 0 && (
          <span className="text-2xs text-ink-faint" title="Combined market cap">
            {formatUsd(totalMarketCap)}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="p-4 text-xs text-ink-faint">
            No coins tracked. Press <kbd className="kbd">⌘K</kbd> to search and add one.
          </p>
        ) : (
          <ul>
            {items.map((item) => {
              const selected = selectedCoinId === item.id;
              const change = item.quote?.change24hPct ?? null;

              return (
                <li key={item.id}>
                  <div
                    className={cn(
                      'group flex items-center gap-2 border-b border-base-800 px-3 py-2 transition-colors',
                      selected ? 'bg-accent/10' : 'hover:bg-base-850/60',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(item.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      aria-pressed={selected}
                      title={`Filter the timeline to ${item.name}`}
                    >
                      {item.isPinned && (
                        <span className="text-2xs text-warn" title="Pinned (polled fastest)">
                          ★
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-1.5">
                          <span className="font-mono text-xs font-semibold text-ink">
                            {item.symbol}
                          </span>
                          <span className="truncate text-2xs text-ink-faint">{item.name}</span>
                        </div>
                        {item.tags.length > 0 && (
                          <div className="mt-0.5 flex gap-1">
                            {item.tags.map((tag) => (
                              <span
                                key={tag.id}
                                className="chip"
                                style={{ backgroundColor: `${tag.color}22`, color: tag.color }}
                              >
                                {tag.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="shrink-0 text-right">
                        <div className="font-mono text-xs text-ink">
                          {item.quote ? formatUsd(item.quote.priceUsd) : '—'}
                        </div>
                        <div className={cn('font-mono text-2xs', changeClass(change))}>
                          {change === null ? '—' : formatPercent(change)}
                        </div>
                      </div>
                    </button>

                    {/* Row actions appear on hover/focus to keep the row clean. */}
                    <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                      <button
                        type="button"
                        className="btn btn-ghost px-1 py-0.5 text-2xs"
                        disabled={busyId === item.id}
                        onClick={() => void togglePin(item)}
                        title={item.isPinned ? 'Unpin' : 'Pin'}
                      >
                        {item.isPinned ? '☆' : '★'}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost px-1 py-0.5 text-2xs hover:text-bear"
                        disabled={busyId === item.id}
                        onClick={() => void remove(item)}
                        title="Remove from watchlist (history is kept)"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
