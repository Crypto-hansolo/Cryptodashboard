import { type EmbeddingClient, type Enricher, type Logger, type RealtimeBus } from '@cid/core';
import { noopLogger, truncate } from '@cid/core';
import type { CidRepositories } from '@cid/db';
import { metrics } from '@cid/platform';
import type { AlertEngine } from './alerts.js';

/**
 * The enrichment loop.
 *
 * Runs decoupled from ingestion on purpose: a local model takes seconds per
 * event, and blocking a 10-second price poll on that would collapse the whole
 * cadence. Events land immediately with deterministic scores and are refined
 * asynchronously, which is why the timeline is never empty while the model
 * catches up.
 *
 * Concurrency is bounded by `LLM_CONCURRENCY` because a single-GPU box serialises
 * anyway, and issuing twenty parallel requests just adds queueing latency.
 */

export interface EnrichmentWorkerOptions {
  repositories: CidRepositories;
  enricher: Enricher;
  embeddings: EmbeddingClient | null;
  alerts: AlertEngine;
  realtime: RealtimeBus;
  logger?: Logger;
  concurrency?: number;
  batchSize?: number;
}

export class EnrichmentWorker {
  readonly #options: EnrichmentWorkerOptions;
  readonly #logger: Logger;
  readonly #concurrency: number;
  readonly #batchSize: number;
  #running = false;

  constructor(options: EnrichmentWorkerOptions) {
    this.#options = options;
    this.#logger = (options.logger ?? noopLogger).child({ component: 'enrichment' });
    this.#concurrency = Math.max(1, options.concurrency ?? 2);
    this.#batchSize = Math.max(1, options.batchSize ?? 12);
  }

  /**
   * Process one batch of pending events.
   *
   * Returns the number enriched, so the caller can decide whether to loop again
   * immediately (backlog) or wait for the next interval (caught up).
   */
  async runOnce(): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;

    try {
      const pending = await this.#options.repositories.events.listPendingEnrichment(
        this.#batchSize,
      );
      if (pending.length === 0) return 0;

      const sources = await this.#options.repositories.sources.listEnabled();
      const sourceById = new Map(sources.map((source) => [source.id, source]));

      let enriched = 0;

      // Fixed-size worker pool over the batch.
      const queue = [...pending];
      const workers = Array.from(
        { length: Math.min(this.#concurrency, queue.length) },
        async () => {
          for (;;) {
            const event = queue.shift();
            if (!event) return;

            const source = sourceById.get(event.sourceId);
            const coin = event.coinId
              ? await this.#options.repositories.coins.findById(event.coinId)
              : null;

            const verdict = await this.#options.enricher.enrich({
              headline: event.headline,
              body: event.body,
              sourceName: source?.name ?? 'unknown',
              sourceCredibility: source?.credibility ?? 0.5,
              coinSymbol: coin?.symbol ?? null,
              category: event.category,
              occurredAt: event.occurredAt,
            });

            if (!verdict.ok) {
              this.#logger.debug(
                { eventId: event.id, err: verdict.error.message },
                'enrichment failed; event stays queued for retry',
              );
              // Deliberately not marking enrichedAt: the event is retried on the
              // next pass. A transient model outage must not permanently leave
              // events unscored.
              continue;
            }

            await this.#options.repositories.events.updateIntelligence(event.id, {
              summary: verdict.value.summary,
              explanation: verdict.value.explanation,
              sentiment: verdict.value.sentiment,
              sentimentScore: verdict.value.sentimentScore,
              importance: verdict.value.importance,
              confidence: verdict.value.confidence,
              impact: verdict.value.impact,
              narratives: verdict.value.narratives,
              isFud: verdict.value.isFud,
              model: 'enriched',
              enrichedAt: new Date(),
            });

            enriched++;

            // Alerts are evaluated *after* enrichment, because rules that filter
            // on importance or sentiment cannot match an unscored event.
            const reloaded = await this.#options.repositories.events.findById(event.id);
            if (reloaded && source) {
              await this.#options.alerts.process({
                kind: 'event',
                event: reloaded,
                sourceKey: source.key,
                coinId: reloaded.coinId,
              });
            }
          }
        },
      );

      await Promise.all(workers);

      if (enriched > 0) {
        this.#logger.info({ enriched, batch: pending.length }, 'enriched events');
      }
      return enriched;
    } finally {
      this.#running = false;
    }
  }

  /**
   * Backfill embeddings for semantic search.
   *
   * Separate from verdict enrichment because it uses a different model and has a
   * different failure mode: a missing embedding degrades search to keyword-only,
   * whereas a missing verdict leaves a row unscored.
   */
  async backfillEmbeddings(limit = 32): Promise<number> {
    const embeddings = this.#options.embeddings;
    if (!embeddings) return 0;

    const pending = await this.#options.repositories.search.listMissingEmbeddings(limit);
    if (pending.length === 0) return 0;

    // Embed the headline plus a slice of the body: the headline carries most of
    // the semantic signal, and long bodies dilute the vector.
    const texts = pending.map((event) =>
      truncate(`${event.headline}. ${event.body ?? ''}`.trim(), 1_000),
    );

    const result = await embeddings.embed(texts);
    if (!result.ok) {
      this.#logger.warn({ err: result.error.message }, 'embedding batch failed');
      return 0;
    }

    let written = 0;
    for (const [index, event] of pending.entries()) {
      const vector = result.value[index];
      if (!vector) continue;
      try {
        await this.#options.repositories.search.upsertEmbedding(event.id, vector);
        written++;
      } catch (error) {
        // A dimension mismatch is a config error, not a transient one; log it
        // loudly rather than retrying forever.
        this.#logger.warn({ eventId: event.id, err: error }, 'failed to store embedding');
      }
    }

    if (written > 0) {
      metrics.increment('embeddings_written', undefined, written);
      this.#logger.debug({ written }, 'backfilled embeddings');
    }
    return written;
  }

  /** Long-running loop; resolves when `signal` aborts. */
  async start(intervalMs: number, signal: AbortSignal): Promise<void> {
    this.#logger.info({ intervalMs, concurrency: this.#concurrency }, 'enrichment loop started');

    while (!signal.aborted) {
      try {
        const enriched = await this.runOnce();
        await this.backfillEmbeddings();

        // A full batch means there is a backlog: loop again immediately rather
        // than waiting out the interval.
        if (enriched >= this.#batchSize) continue;
      } catch (error) {
        this.#logger.error({ err: error }, 'enrichment loop iteration failed');
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }

    this.#logger.info('enrichment loop stopped');
  }
}
