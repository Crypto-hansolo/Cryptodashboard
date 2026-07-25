import {
  err,
  ok,
  type ChatMessage,
  type CompletionOptions,
  type CompletionResult,
  type DomainError,
  type EmbeddingClient,
  type LlmClient,
  type Result,
} from '@cid/core';
import { UpstreamError } from '@cid/core';

/**
 * Scripted LLM/embedding doubles.
 *
 * The enrichment pipeline's most important behaviour is what it does with *bad*
 * model output — prose-wrapped JSON, wrong enum casing, a bullish verdict on an
 * exploit. None of that is testable against a real model, so these fakes return
 * exactly the pathological responses that matter.
 */

export interface FakeLlmOptions {
  /** Responses returned in order; the last one repeats once exhausted. */
  responses: readonly string[];
  /** Fail every call instead, to exercise the degradation paths. */
  failWith?: DomainError;
  model?: string;
}

export class FakeLlmClient implements LlmClient {
  readonly provider = 'fake';
  readonly model: string;
  readonly #options: FakeLlmOptions;
  #index = 0;
  /** Prompts received, for asserting on what the pipeline actually asked. */
  readonly prompts: ChatMessage[][] = [];

  constructor(options: FakeLlmOptions) {
    this.#options = options;
    this.model = options.model ?? 'fake-model';
  }

  async isAvailable(): Promise<boolean> {
    return this.#options.failWith === undefined;
  }

  async complete(
    messages: readonly ChatMessage[],
    _options?: CompletionOptions,
  ): Promise<Result<CompletionResult, DomainError>> {
    this.prompts.push([...messages]);
    if (this.#options.failWith) return err(this.#options.failWith);

    const text =
      this.#options.responses[Math.min(this.#index, this.#options.responses.length - 1)] ?? '';
    this.#index++;

    return ok({
      text,
      model: this.model,
      usage: { promptTokens: 100, completionTokens: 50, totalMs: 1 },
    });
  }

  async *stream(
    messages: readonly ChatMessage[],
    _options?: CompletionOptions,
  ): AsyncIterable<Result<string, DomainError>> {
    this.prompts.push([...messages]);
    if (this.#options.failWith) {
      yield err(this.#options.failWith);
      return;
    }
    const text =
      this.#options.responses[Math.min(this.#index, this.#options.responses.length - 1)] ?? '';
    this.#index++;
    // Emit in small chunks so consumers exercise their accumulation logic.
    for (const chunk of text.match(/.{1,8}/gs) ?? []) yield ok(chunk);
  }
}

export class FakeEmbeddingClient implements EmbeddingClient {
  readonly provider = 'fake';
  readonly model = 'fake-embed';
  readonly dimensions: number;
  #available: boolean;

  constructor(options: { dimensions?: number; available?: boolean } = {}) {
    this.dimensions = options.dimensions ?? 768;
    this.#available = options.available ?? true;
  }

  async isAvailable(): Promise<boolean> {
    return this.#available;
  }

  async embed(texts: readonly string[]): Promise<Result<number[][], DomainError>> {
    if (!this.#available) return err(new UpstreamError('fake', 'unavailable'));
    // Deterministic pseudo-embedding derived from the text, so identical inputs
    // embed identically and different inputs differ.
    return ok(
      texts.map((text) => {
        let seed = 0;
        for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) | 0;
        const vector = new Array<number>(this.dimensions);
        let state = seed || 1;
        for (let i = 0; i < this.dimensions; i++) {
          state = (state * 1103515245 + 12345) & 0x7fffffff;
          vector[i] = (state / 0x7fffffff) * 2 - 1;
        }
        const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        return vector.map((value) => value / magnitude);
      }),
    );
  }
}

/** A well-formed verdict, as a compliant model would return it. */
export function fakeVerdictJson(
  overrides: Partial<{
    summary: string;
    explanation: string;
    sentiment: string;
    importance: number;
    confidence: number;
    impact: string;
    category: string;
    narratives: string[];
    isFud: boolean;
  }> = {},
): string {
  return JSON.stringify({
    summary: 'A concise factual summary.',
    explanation: 'Why this matters for the asset.',
    sentiment: 'BULLISH',
    importance: 70,
    confidence: 75,
    impact: 'HIGH',
    category: 'NEWS',
    narratives: ['etf-flows'],
    isFud: false,
    ...overrides,
  });
}
