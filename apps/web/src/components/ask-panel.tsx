'use client';

import { useRef, useState } from 'react';

/**
 * The AI research console.
 *
 * Streams tokens over SSE so the answer starts appearing in ~1s rather than
 * after the model finishes. Citations arrive first and render immediately, which
 * also means the pane is useful even if the model then fails: you still have the
 * evidence.
 */

interface Citation {
  eventId: string;
  headline: string;
  sourceName: string;
  occurredAt: string;
  url: string | null;
}

const EXAMPLES = [
  'Why is the market moving today?',
  'What happened to ETH this week?',
  'Show every bullish event about CRO',
  'Any security incidents in the last 24 hours?',
];

export function AskPanel({ coinIds, onClose }: { coinIds: string[]; onClose: () => void }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<Citation[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const ask = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed.length < 3 || streaming) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStreaming(true);
    setAnswer('');
    setCitations([]);
    setError(null);

    try {
      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question: trimmed,
          ...(coinIds.length > 0 ? { coinIds } : {}),
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        setError(`Request failed (HTTP ${response.status})`);
        return;
      }

      // Manual SSE parsing: EventSource cannot issue a POST, and the question
      // does not belong in a URL.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const eventLine = frame.split('\n').find((line) => line.startsWith('event:'));
          const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
          if (!eventLine || !dataLine) continue;

          const type = eventLine.slice(6).trim();
          const payload = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;

          if (type === 'citations') setCitations(payload.citations as Citation[]);
          else if (type === 'token') setAnswer((current) => current + String(payload.token));
          else if (type === 'error') setError(String(payload.message));
        }
      }
    } catch (caught) {
      if ((caught as Error).name !== 'AbortError') {
        setError(caught instanceof Error ? caught.message : 'request failed');
      }
    } finally {
      setStreaming(false);
    }
  };

  return (
    <>
      <div className="panel-header shrink-0 bg-base-900">
        <h2 className="panel-title">Research</h2>
        <button type="button" className="btn btn-ghost px-1.5 py-0.5 text-2xs" onClick={onClose}>
          Close <kbd className="kbd ml-1">Esc</kbd>
        </button>
      </div>

      <form
        className="shrink-0 border-b border-base-700 p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(question);
        }}
      >
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            // Enter submits, Shift+Enter adds a newline — chat convention.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void ask(question);
            }
          }}
          rows={2}
          placeholder="Ask about anything in the database…"
          className="input resize-none"
          aria-label="Research question"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <button type="submit" className="btn btn-accent" disabled={streaming}>
            {streaming ? 'Thinking…' : 'Ask'}
          </button>
          {coinIds.length > 0 && (
            <span className="text-2xs text-ink-faint">scoped to selected coin</span>
          )}
        </div>
      </form>

      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {error && (
          <p className="mb-2 rounded border border-bear/40 bg-bear/10 p-2 text-xs text-bear">
            {error}
          </p>
        )}

        {answer === '' && !streaming && !error && (
          <div className="space-y-2">
            <p className="text-2xs uppercase tracking-wider text-ink-faint">Try</p>
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                className="block w-full rounded border border-base-700 bg-base-850 px-2 py-1.5 text-left text-xs text-ink-muted hover:border-base-600 hover:text-ink"
                onClick={() => {
                  setQuestion(example);
                  void ask(example);
                }}
              >
                {example}
              </button>
            ))}
          </div>
        )}

        {answer !== '' && (
          <div className="mb-3 whitespace-pre-wrap text-xs leading-relaxed text-ink">
            {answer}
            {streaming && <span className="ml-0.5 animate-pulse text-accent">▌</span>}
          </div>
        )}

        {citations.length > 0 && (
          <section>
            <h3 className="mb-1 text-2xs font-semibold uppercase tracking-wider text-ink-faint">
              Evidence · {citations.length}
            </h3>
            <ol className="space-y-1">
              {citations.map((citation, index) => (
                <li
                  key={citation.eventId}
                  className="rounded border border-base-700 bg-base-850 p-1.5 text-2xs"
                >
                  <span className="mr-1 font-mono text-accent">[{index + 1}]</span>
                  {citation.url ? (
                    <a
                      href={citation.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-ink-muted hover:text-ink hover:underline"
                    >
                      {citation.headline}
                    </a>
                  ) : (
                    <span className="text-ink-muted">{citation.headline}</span>
                  )}
                  <span className="ml-1 text-ink-faint">
                    — {citation.sourceName}, {citation.occurredAt.slice(0, 16).replace('T', ' ')}Z
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </>
  );
}
