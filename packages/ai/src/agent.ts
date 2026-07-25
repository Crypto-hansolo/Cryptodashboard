import {
  err,
  formatRelativeTime,
  formatUsd,
  ok,
  truncate,
  type ChatMessage,
  type DomainError,
  type EmbeddingClient,
  type LlmClient,
  type Logger,
  type Repositories,
  type Result,
} from '@cid/core';
import { noopLogger } from '@cid/core';

/**
 * The research agent.
 *
 * Answers natural-language questions ("Why is CRO pumping today?") from the
 * platform's own database rather than the model's training data. That distinction
 * is the whole point: a local 8B model knows nothing about today, but it is
 * perfectly capable of reading twenty retrieved events and explaining them.
 *
 * Retrieval is hybrid (embeddings + full-text) and every answer carries the
 * event ids it drew on, so the UI can link each claim back to its evidence.
 */

export interface ResearchCitation {
  eventId: string;
  headline: string;
  sourceName: string;
  occurredAt: Date;
  url: string | null;
  importance: number | null;
}

export interface ResearchAnswer {
  answer: string;
  citations: ResearchCitation[];
  /** True when retrieval found nothing and the model was not consulted. */
  noEvidence: boolean;
  model: string | null;
}

export interface ResearchAgentOptions {
  repositories: Repositories;
  llm: LlmClient | null;
  embeddings: EmbeddingClient | null;
  logger?: Logger;
  /** Events retrieved per question. Bounded by the model's context window. */
  maxContextEvents?: number;
}

const SYSTEM_PROMPT = `You are a crypto research analyst with access to a live event database.

You will be given a question and a numbered list of retrieved events with timestamps, sources and importance scores. Answer using ONLY those events.

Rules:
- Cite evidence inline as [1], [2] matching the numbered events.
- If the events do not answer the question, say so plainly. Never speculate to fill a gap.
- Lead with the answer, then the supporting detail. No preamble.
- Be specific about magnitudes and timing when the events provide them.
- If the events conflict, say so and note which source is more credible.
- Keep it under 250 words unless the question demands more.`;

export class ResearchAgent {
  readonly #repositories: Repositories;
  readonly #llm: LlmClient | null;
  readonly #embeddings: EmbeddingClient | null;
  readonly #logger: Logger;
  readonly #maxContextEvents: number;

  constructor(options: ResearchAgentOptions) {
    this.#repositories = options.repositories;
    this.#llm = options.llm;
    this.#embeddings = options.embeddings;
    this.#logger = (options.logger ?? noopLogger).child({ component: 'agent' });
    this.#maxContextEvents = options.maxContextEvents ?? 20;
  }

  /**
   * Retrieve relevant events for a question.
   *
   * Exposed separately from {@link ask} because the semantic-search UI needs
   * exactly this, without an LLM round trip.
   */
  async retrieve(input: {
    question: string;
    coinIds?: readonly string[];
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<ResearchCitation[]> {
    const limit = input.limit ?? this.#maxContextEvents;

    // Embed the question when a model is available; fall back to keyword-only.
    let vector: number[] | null = null;
    if (this.#embeddings) {
      const embedded = await this.#embeddings.embed([input.question]);
      if (embedded.ok && embedded.value[0]) vector = embedded.value[0];
      else if (!embedded.ok) {
        this.#logger.debug(
          { err: embedded.error.message },
          'embedding failed, keyword-only search',
        );
      }
    }

    const search = this.#repositories.search as {
      hybridSearch?: (args: {
        query: string;
        vector?: readonly number[] | null;
        limit: number;
        coinIds?: readonly string[];
        from?: Date;
        to?: Date;
      }) => Promise<Array<{ eventId: string; similarity: number }>>;
    };

    const hits = search.hybridSearch
      ? await search.hybridSearch({
          query: input.question,
          vector,
          limit,
          ...(input.coinIds ? { coinIds: input.coinIds } : {}),
          ...(input.from ? { from: input.from } : {}),
          ...(input.to ? { to: input.to } : {}),
        })
      : // Port-only implementations may not offer hybrid; degrade to keyword.
        await this.#repositories.search.keywordSearch({
          query: input.question,
          limit,
          ...(input.coinIds ? { coinIds: input.coinIds } : {}),
          ...(input.from ? { from: input.from } : {}),
          ...(input.to ? { to: input.to } : {}),
        });

    if (hits.length === 0) return [];

    // Hydrate hits into citations, preserving relevance order.
    const events = await Promise.all(
      hits.map(async (hit) => this.#repositories.events.findById(hit.eventId)),
    );
    const sources = await this.#repositories.sources.listEnabled();
    const sourceNames = new Map(sources.map((source) => [source.id, source.name]));

    return events.flatMap((event) =>
      event
        ? [
            {
              eventId: event.id,
              headline: event.headline,
              sourceName: sourceNames.get(event.sourceId) ?? 'unknown',
              occurredAt: event.occurredAt,
              url: event.url,
              importance: event.intelligence.importance,
            },
          ]
        : [],
    );
  }

  /** Answer a question with citations. */
  async ask(input: {
    question: string;
    coinIds?: readonly string[];
    from?: Date;
    to?: Date;
  }): Promise<Result<ResearchAnswer, DomainError>> {
    const citations = await this.retrieve(input);

    if (citations.length === 0) {
      // No evidence: say so rather than letting the model invent an answer from
      // stale training data. This is the failure mode that destroys trust.
      return ok({
        answer:
          'I have no events matching that question in the database. Either it has not been ingested yet, or the question falls outside the tracked coins and time range.',
        citations: [],
        noEvidence: true,
        model: null,
      });
    }

    if (!this.#llm) {
      // Without a model, return the evidence itself. Still useful.
      return ok({
        answer: `AI answering is disabled (LLM_PROVIDER=null). ${citations.length} matching events are listed below.`,
        citations,
        noEvidence: false,
        model: null,
      });
    }

    const context = await this.#buildContext(citations, input.coinIds);

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Question: ${input.question}\n\n${context}` },
    ];

    const completion = await this.#llm.complete(messages, { temperature: 0.3, maxTokens: 900 });
    if (!completion.ok) return err(completion.error);

    return ok({
      answer: completion.value.text.trim(),
      citations,
      noEvidence: false,
      model: completion.value.model,
    });
  }

  /** Stream an answer token-by-token for the interactive console. */
  async *askStream(input: {
    question: string;
    coinIds?: readonly string[];
    from?: Date;
    to?: Date;
  }): AsyncIterable<
    | { type: 'citations'; citations: ResearchCitation[] }
    | { type: 'token'; token: string }
    | { type: 'error'; message: string }
    | { type: 'done' }
  > {
    const citations = await this.retrieve(input);
    // Send citations first so the UI can render evidence while tokens arrive.
    yield { type: 'citations', citations };

    if (citations.length === 0) {
      yield {
        type: 'token',
        token: 'No matching events found in the database for that question.',
      };
      yield { type: 'done' };
      return;
    }

    if (!this.#llm) {
      yield { type: 'token', token: 'AI answering is disabled (LLM_PROVIDER=null).' };
      yield { type: 'done' };
      return;
    }

    const context = await this.#buildContext(citations, input.coinIds);
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Question: ${input.question}\n\n${context}` },
    ];

    for await (const chunk of this.#llm.stream(messages, { temperature: 0.3, maxTokens: 900 })) {
      if (chunk.ok) yield { type: 'token', token: chunk.value };
      else {
        yield { type: 'error', message: chunk.error.message };
        return;
      }
    }
    yield { type: 'done' };
  }

  /**
   * Assemble the retrieval context.
   *
   * Includes current market state alongside the events, because "why is X
   * pumping" is unanswerable without knowing that it is in fact up 12%.
   */
  async #buildContext(
    citations: readonly ResearchCitation[],
    coinIds: readonly string[] | undefined,
  ): Promise<string> {
    const parts: string[] = [];

    if (coinIds && coinIds.length > 0) {
      const [coins, quotes] = await Promise.all([
        this.#repositories.coins.findManyByIds(coinIds),
        this.#repositories.market.latestQuotes(coinIds),
      ]);

      const lines = coins.flatMap((coin) => {
        const quote = quotes.get(coin.id);
        if (!quote) return [];
        const change = quote.priceChange24hPct;
        return [
          `- ${coin.symbol} (${coin.name}): ${formatUsd(quote.priceUsd)}, ` +
            `24h ${change === null ? 'n/a' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}, ` +
            `24h volume ${formatUsd(quote.volume24hUsd)}`,
        ];
      });

      if (lines.length > 0) {
        parts.push(`Current market state:\n${lines.join('\n')}`);
      }
    }

    const now = new Date();
    const events = await Promise.all(
      citations.map(async (citation, index) => {
        const event = await this.#repositories.events.findById(citation.eventId);
        if (!event) return null;

        const intel = event.intelligence;
        return [
          `[${index + 1}] ${formatRelativeTime(event.occurredAt, now)} ago — ${citation.sourceName}` +
            `${intel.importance !== null ? ` (importance ${intel.importance}/100` : ''}` +
            `${intel.sentiment !== null ? `, ${intel.sentiment.toLowerCase().replace('_', ' ')}` : ''}` +
            `${intel.importance !== null ? ')' : ''}`,
          `    ${event.headline}`,
          intel.summary ? `    ${truncate(intel.summary, 300)}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      }),
    );

    parts.push(`Retrieved events:\n${events.filter(Boolean).join('\n')}`);
    return parts.join('\n\n');
  }
}
