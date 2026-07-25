'use client';

import { useMemo, useState } from 'react';
import type { EventCategory, ImpactLevel, SentimentLabel } from '@cid/core';
import type { TimelineItem } from '@/lib/api';
import {
  CATEGORY_STYLE,
  IMPACT_STYLE,
  SENTIMENT_STYLE,
  cn,
  formatRelativeTime,
  importanceClass,
} from '@/lib/format';

/**
 * The event timeline.
 *
 * Information density is the design goal: one line per event by default, with
 * the AI summary and explanation revealed on expand. A trader scanning for
 * something needs many rows visible at once, not cards.
 */

export interface TimelineFilters {
  coinIds: string[];
  categories: string[];
  minImportance: number | null;
  query: string;
}

const IMPORTANCE_PRESETS = [
  { label: 'All', value: null },
  { label: '40+', value: 40 },
  { label: '65+', value: 65 },
  { label: '85+', value: 85 },
];

export function Timeline({
  items,
  filters,
  onFiltersChange,
  onLoadMore,
  hasMore,
  loadingMore,
  availableCategories,
}: {
  items: TimelineItem[];
  filters: TimelineFilters;
  onFiltersChange: (filters: TimelineFilters) => void;
  onLoadMore: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  availableCategories: string[];
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [queryDraft, setQueryDraft] = useState(filters.query);

  const toggleExpanded = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleCategory = (category: string): void => {
    onFiltersChange({
      ...filters,
      categories: filters.categories.includes(category)
        ? filters.categories.filter((entry) => entry !== category)
        : [...filters.categories, category],
    });
  };

  // Group by day so a long scroll stays legible.
  const grouped = useMemo(() => {
    const groups: Array<{ day: string; items: TimelineItem[] }> = [];
    for (const item of items) {
      const day = item.occurredAt.slice(0, 10);
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.items.push(item);
      else groups.push({ day, items: [item] });
    }
    return groups;
  }, [items]);

  const now = new Date();

  return (
    <>
      {/* ── Filter bar ── */}
      <div className="shrink-0 border-b border-base-700 bg-base-900">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <form
            className="flex min-w-[12rem] flex-1 items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              onFiltersChange({ ...filters, query: queryDraft });
            }}
          >
            <input
              type="search"
              value={queryDraft}
              onChange={(event) => setQueryDraft(event.target.value)}
              placeholder="Filter headlines…"
              className="input"
              aria-label="Filter timeline"
            />
          </form>

          <div className="flex items-center gap-1" role="group" aria-label="Minimum importance">
            {IMPORTANCE_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => onFiltersChange({ ...filters, minImportance: preset.value })}
                aria-pressed={filters.minImportance === preset.value}
                className={cn(
                  'btn px-2 py-1 text-2xs',
                  filters.minImportance === preset.value && 'btn-accent',
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>

          {(filters.categories.length > 0 || filters.query !== '' || filters.coinIds.length > 0) && (
            <button
              type="button"
              className="btn btn-ghost px-2 py-1 text-2xs"
              onClick={() => {
                setQueryDraft('');
                onFiltersChange({ coinIds: [], categories: [], minImportance: null, query: '' });
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        {/* Category chips. Scrollable rather than wrapping, to keep the header
            height fixed regardless of how many categories exist. */}
        <div className="flex gap-1 overflow-x-auto px-3 pb-2">
          {availableCategories.map((category) => {
            const style = CATEGORY_STYLE[category as EventCategory];
            const active = filters.categories.includes(category);
            return (
              <button
                key={category}
                type="button"
                onClick={() => toggleCategory(category)}
                aria-pressed={active}
                className={cn(
                  'chip whitespace-nowrap border border-transparent transition-colors',
                  active ? style?.className : 'bg-base-800 text-ink-faint hover:text-ink-muted',
                  active && 'border-current/30',
                )}
              >
                {style?.label ?? category}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Rows ── */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="p-8 text-center text-xs text-ink-faint">
            <p className="mb-1 text-ink-muted">No events match these filters.</p>
            <p>
              If the database is empty, start the worker to begin ingesting, or run{' '}
              <code className="text-ink-muted">npm run db:seed</code> for sample data.
            </p>
          </div>
        ) : (
          grouped.map((group) => (
            <section key={group.day}>
              <h2 className="sticky top-0 z-10 border-b border-base-700 bg-base-850/95 px-3 py-1 text-2xs font-semibold uppercase tracking-wider text-ink-faint backdrop-blur">
                {group.day}
              </h2>
              <ul>
                {group.items.map((item) => (
                  <TimelineRow
                    key={item.id}
                    item={item}
                    now={now}
                    expanded={expanded.has(item.id)}
                    onToggle={() => toggleExpanded(item.id)}
                  />
                ))}
              </ul>
            </section>
          ))
        )}

        {hasMore && (
          <div className="p-3">
            <button
              type="button"
              className="btn w-full"
              onClick={onLoadMore}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : 'Load older events'}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function TimelineRow({
  item,
  now,
  expanded,
  onToggle,
}: {
  item: TimelineItem;
  now: Date;
  expanded: boolean;
  onToggle: () => void;
}) {
  const category = CATEGORY_STYLE[item.category as EventCategory];
  const sentiment = item.sentiment ? SENTIMENT_STYLE[item.sentiment as SentimentLabel] : null;
  const impact = item.impact ? IMPACT_STYLE[item.impact as ImpactLevel] : null;

  return (
    <li className="group border-b border-base-800 transition-colors hover:bg-base-850/60">
      <div className="flex items-start gap-2 px-3 py-2">
        {/* Importance is shown as a bar rather than a number: it is a relative
            magnitude, and a column of 2-digit numbers is harder to scan. */}
        <div
          className="mt-1 h-8 w-1 shrink-0 rounded-full"
          title={item.importance === null ? 'Not yet scored' : `Importance ${item.importance}/100`}
        >
          <div
            className={cn('w-full rounded-full', importanceClass(item.importance))}
            style={{ height: `${Math.max(12, item.importance ?? 12)}%` }}
          />
        </div>

        <time
          className="mt-0.5 w-10 shrink-0 font-mono text-2xs text-ink-faint"
          dateTime={item.occurredAt}
          title={new Date(item.occurredAt).toLocaleString()}
        >
          {formatRelativeTime(new Date(item.occurredAt), now)}
        </time>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-1.5">
            {item.coin && (
              <span className="font-mono text-xs font-semibold text-ink">{item.coin.symbol}</span>
            )}

            <button
              type="button"
              onClick={onToggle}
              className="min-w-0 flex-1 text-left text-xs leading-snug text-ink hover:text-white"
              aria-expanded={expanded}
            >
              {item.headline}
            </button>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {category && <span className={cn('chip', category.className)}>{category.label}</span>}
            {sentiment && <span className={cn('chip', sentiment.className)}>{sentiment.label}</span>}
            {impact && item.impact !== 'LOW' && (
              <span className={cn('chip', impact.className)}>{impact.label}</span>
            )}
            {item.isFud && <span className="chip bg-bear/20 text-bear">Possible FUD</span>}

            <span className="text-2xs text-ink-faint">{item.source.name}</span>

            {item.duplicateCount > 0 && (
              <span
                className="text-2xs text-ink-faint"
                title="Other sources reporting the same story"
              >
                +{item.duplicateCount} more
              </span>
            )}

            {!item.enriched && (
              <span className="text-2xs text-ink-faint" title="Awaiting AI analysis">
                ○ pending
              </span>
            )}

            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-2xs text-accent hover:underline"
                // Stop the row from expanding when the user meant to follow the link.
                onClick={(event) => event.stopPropagation()}
              >
                source ↗
              </a>
            )}
          </div>

          {expanded && (
            <div className="mt-2 animate-fade-in space-y-2 rounded border border-base-700 bg-base-850 p-2.5">
              {item.summary && (
                <p className="text-xs leading-relaxed text-ink-muted">{item.summary}</p>
              )}
              {item.explanation && (
                <div>
                  <p className="mb-0.5 text-2xs font-semibold uppercase tracking-wider text-ink-faint">
                    Why it matters
                  </p>
                  <p className="text-xs leading-relaxed text-ink-muted">{item.explanation}</p>
                </div>
              )}
              {!item.summary && !item.explanation && (
                <p className="text-2xs text-ink-faint">
                  No AI analysis yet. Enrichment runs asynchronously; enable a local model with
                  LLM_PROVIDER to generate summaries.
                </p>
              )}

              <dl className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-ink-faint">
                {item.importance !== null && (
                  <div>
                    <dt className="inline">Importance </dt>
                    <dd className="inline text-ink-muted">{item.importance}/100</dd>
                  </div>
                )}
                {item.confidence !== null && (
                  <div>
                    <dt className="inline">Confidence </dt>
                    <dd className="inline text-ink-muted">{item.confidence}/100</dd>
                  </div>
                )}
                {item.author && (
                  <div>
                    <dt className="inline">Author </dt>
                    <dd className="inline text-ink-muted">{item.author}</dd>
                  </div>
                )}
                <div>
                  <dt className="inline">Ingested </dt>
                  <dd className="inline text-ink-muted">
                    {formatRelativeTime(new Date(item.ingestedAt), now)} after
                  </dd>
                </div>
              </dl>

              {item.narratives.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {item.narratives.map((narrative) => (
                    <span key={narrative} className="chip bg-accent/12 text-accent">
                      {narrative}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
