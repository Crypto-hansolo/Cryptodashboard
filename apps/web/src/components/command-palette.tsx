'use client';

import { useEffect, useRef, useState } from 'react';
import { apiGet, apiSend, type SearchHit } from '@/lib/api';
import { cn } from '@/lib/format';

/**
 * The global command palette (⌘K).
 *
 * Searches the local index first and only falls through to CoinGecko when local
 * results are thin, so typing does not spend the provider's rate limit per
 * keystroke. Untracked results offer "add"; tracked ones filter the timeline.
 *
 * Hand-rolled rather than using `cmdk`: the interaction is a single list with
 * arrow/enter handling, and this keeps the keyboard behaviour and the two-tier
 * search semantics in one readable place.
 */

const DEBOUNCE_MS = 180;

export function CommandPalette({
  open,
  onClose,
  onCoinAdded,
  onSelectCoin,
}: {
  open: boolean;
  onClose: () => void;
  onCoinAdded: () => void;
  onSelectCoin: (coinId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset and focus on open. Without the reset, reopening shows the previous
  // query's results for a frame.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResults([]);
    setActiveIndex(0);
    // rAF so the focus lands after the element is actually painted.
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // Debounced search, with the in-flight request abandoned when a newer one
  // starts so results cannot arrive out of order.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed === '') {
      setResults([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      void apiGet<{ results: SearchHit[] }>(`/api/coins/search?q=${encodeURIComponent(trimmed)}`)
        .then((data) => {
          if (cancelled) return;
          setResults(data.results);
          setActiveIndex(0);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open]);

  const choose = async (hit: SearchHit): Promise<void> => {
    if (busy) return;

    if (hit.tracked) {
      onSelectCoin(hit.id);
      onClose();
      return;
    }

    // Untracked: import it, then refresh the watchlist.
    setBusy(true);
    try {
      // `slug` here is the CoinGecko id for remote hits.
      await apiSend('/api/coins', 'POST', { query: hit.slug });
      onCoinAdded();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[10vh] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      // Clicking the backdrop closes; clicking the panel must not.
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-lg border border-base-600 bg-base-900 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveIndex((index) => Math.min(index + 1, results.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((index) => Math.max(index - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const hit = results[activeIndex];
              if (hit) void choose(hit);
            }
          }}
          placeholder="Search a coin by name, symbol, contract address or CoinGecko id…"
          className="w-full border-b border-base-700 bg-transparent px-4 py-3 text-sm text-ink placeholder:text-ink-faint focus:outline-none"
          aria-label="Search coins"
          aria-autocomplete="list"
        />

        <div className="max-h-[50vh] overflow-y-auto">
          {loading && results.length === 0 && (
            <p className="px-4 py-3 text-xs text-ink-faint">Searching…</p>
          )}

          {!loading && query.trim() !== '' && results.length === 0 && (
            <p className="px-4 py-3 text-xs text-ink-faint">
              Nothing found. Try a contract address, a CoinGecko id, or{' '}
              <code className="text-ink-muted">$SYMBOL</code>.
            </p>
          )}

          {query.trim() === '' && (
            <div className="px-4 py-3 text-xs text-ink-faint">
              <p className="mb-2">Search any cryptocurrency to track it.</p>
              <ul className="space-y-0.5 text-2xs">
                <li>
                  <code className="text-ink-muted">bitcoin</code> — by name
                </li>
                <li>
                  <code className="text-ink-muted">$CRO</code> — by ticker
                </li>
                <li>
                  <code className="text-ink-muted">ethereum:0x514910…</code> — by contract
                </li>
                <li>
                  <code className="text-ink-muted">coingecko:celestia</code> — by provider id
                </li>
              </ul>
            </div>
          )}

          <ul role="listbox">
            {results.map((hit, index) => (
              <li key={`${hit.id}-${index}`} role="option" aria-selected={index === activeIndex}>
                <button
                  type="button"
                  onClick={() => void choose(hit)}
                  onMouseEnter={() => setActiveIndex(index)}
                  disabled={busy}
                  className={cn(
                    'flex w-full items-center gap-3 px-4 py-2 text-left transition-colors',
                    index === activeIndex ? 'bg-accent/15' : 'hover:bg-base-850',
                  )}
                >
                  <span className="font-mono text-xs font-semibold text-ink">{hit.symbol}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-muted">{hit.name}</span>
                  {hit.marketCapRank !== null && (
                    <span className="text-2xs text-ink-faint">#{hit.marketCapRank}</span>
                  )}
                  <span
                    className={cn(
                      'chip',
                      hit.tracked ? 'bg-base-700 text-ink-faint' : 'bg-bull/15 text-bull',
                    )}
                  >
                    {hit.tracked ? 'tracked' : '+ add'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center gap-3 border-t border-base-700 px-4 py-1.5 text-2xs text-ink-faint">
          <span>
            <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> navigate
          </span>
          <span>
            <kbd className="kbd">↵</kbd> select
          </span>
          <span>
            <kbd className="kbd">Esc</kbd> close
          </span>
          {busy && <span className="ml-auto text-accent">Adding…</span>}
        </div>
      </div>
    </div>
  );
}
