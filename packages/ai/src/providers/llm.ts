import {
  TimeoutError,
  UpstreamError,
  err,
  ok,
  type ChatMessage,
  type CompletionOptions,
  type CompletionResult,
  type DomainError,
  type EmbeddingClient,
  type HttpClient,
  type LlmClient,
  type Logger,
  type Result,
} from '@cid/core';
import { noopLogger } from '@cid/core';
import { metrics } from '@cid/platform';

/**
 * Local LLM providers.
 *
 * Five backends are supported, and they reduce to two wire protocols:
 *
 *  - Ollama's native `/api/chat` (kept because its `format` parameter gives real
 *    constrained JSON decoding, which a local 8B model badly needs)
 *  - OpenAI-compatible `/v1/chat/completions`, which covers LM Studio, vLLM,
 *    llama.cpp's server, LiteLLM and anything else pretending to be OpenAI
 *
 * Everything is behind the `LlmClient` port, so swapping providers is a config
 * change and the enrichment pipeline can be tested against a scripted fake.
 */

export interface LlmClientOptions {
  http: HttpClient;
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  logger?: Logger;
}

/** Strip a trailing slash so URL joining is unambiguous. */
function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

// ─── Ollama ──────────────────────────────────────────────────────────────────

export class OllamaClient implements LlmClient {
  readonly provider = 'ollama';
  readonly model: string;
  readonly #options: LlmClientOptions;
  readonly #logger: Logger;

  constructor(options: LlmClientOptions) {
    this.#options = options;
    this.model = options.model;
    this.#logger = (options.logger ?? noopLogger).child({ llm: 'ollama' });
  }

  async isAvailable(): Promise<boolean> {
    const response = await this.#options.http.getJson<{ models?: unknown[] }>(
      `${normalizeBase(this.#options.baseUrl)}/api/tags`,
      { timeoutMs: 3_000 },
    );
    return response.ok;
  }

  async complete(
    messages: readonly ChatMessage[],
    options: CompletionOptions = {},
  ): Promise<Result<CompletionResult, DomainError>> {
    const startedAt = Date.now();

    const response = await this.#options.http.request<{
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    }>({
      url: `${normalizeBase(this.#options.baseUrl)}/api/chat`,
      method: 'POST',
      body: {
        model: this.model,
        messages,
        stream: false,
        // Ollama accepts a JSON Schema here and constrains generation to it.
        // This is the single biggest quality lever for small local models.
        ...(options.jsonSchema ? { format: options.jsonSchema } : {}),
        options: {
          temperature: options.temperature ?? this.#options.temperature ?? 0.2,
          num_predict: options.maxTokens ?? this.#options.maxTokens ?? 1024,
          ...(options.stop ? { stop: options.stop } : {}),
        },
      },
      timeoutMs: this.#options.timeoutMs ?? 120_000,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      metrics.increment('llm_request_failure', { provider: this.provider });
      return err(response.error);
    }

    const text = response.value.data.message?.content ?? '';
    const totalMs = Date.now() - startedAt;
    metrics.observe('llm_request_ms', totalMs, { provider: this.provider });

    if (text.trim() === '') {
      this.#logger.warn({ model: this.model }, 'ollama returned an empty completion');
      return err(new UpstreamError('ollama', 'empty completion'));
    }

    return ok({
      text,
      model: this.model,
      usage: {
        promptTokens: response.value.data.prompt_eval_count ?? null,
        completionTokens: response.value.data.eval_count ?? null,
        totalMs,
      },
    });
  }

  /**
   * Streaming completion.
   *
   * Ollama streams newline-delimited JSON objects rather than SSE, so this
   * parses line-by-line. Used by the interactive research console, where
   * first-token latency matters far more than total time.
   */
  async *stream(
    messages: readonly ChatMessage[],
    options: CompletionOptions = {},
  ): AsyncIterable<Result<string, DomainError>> {
    const url = `${normalizeBase(this.#options.baseUrl)}/api/chat`;
    const body = JSON.stringify({
      model: this.model,
      messages,
      stream: true,
      options: {
        temperature: options.temperature ?? this.#options.temperature ?? 0.2,
        num_predict: options.maxTokens ?? this.#options.maxTokens ?? 1024,
      },
    });

    yield* streamNdjson(url, body, this.#options, options, (chunk) => {
      const parsed = chunk as { message?: { content?: string }; done?: boolean };
      return parsed.message?.content ?? null;
    });
  }
}

// ─── OpenAI-compatible (LM Studio, vLLM, llama.cpp, LiteLLM) ─────────────────

export class OpenAiCompatibleClient implements LlmClient {
  readonly provider: string;
  readonly model: string;
  readonly #options: LlmClientOptions;
  readonly #logger: Logger;

  constructor(options: LlmClientOptions, provider = 'openai-compatible') {
    this.#options = options;
    this.provider = provider;
    this.model = options.model;
    this.#logger = (options.logger ?? noopLogger).child({ llm: provider });
  }

  #headers(): Record<string, string> {
    return this.#options.apiKey ? { authorization: `Bearer ${this.#options.apiKey}` } : {};
  }

  async isAvailable(): Promise<boolean> {
    const response = await this.#options.http.getJson<unknown>(
      `${normalizeBase(this.#options.baseUrl)}/v1/models`,
      { headers: this.#headers(), timeoutMs: 3_000 },
    );
    return response.ok;
  }

  async complete(
    messages: readonly ChatMessage[],
    options: CompletionOptions = {},
  ): Promise<Result<CompletionResult, DomainError>> {
    const startedAt = Date.now();

    const response = await this.#options.http.request<{
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }>({
      url: `${normalizeBase(this.#options.baseUrl)}/v1/chat/completions`,
      method: 'POST',
      headers: this.#headers(),
      body: {
        model: this.model,
        messages,
        stream: false,
        temperature: options.temperature ?? this.#options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? this.#options.maxTokens ?? 1024,
        ...(options.stop ? { stop: options.stop } : {}),
        // vLLM and LM Studio both accept this; servers that do not simply
        // ignore it, and the tolerant JSON extraction covers the difference.
        ...(options.jsonSchema
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'verdict', schema: options.jsonSchema, strict: false },
              },
            }
          : {}),
      },
      timeoutMs: this.#options.timeoutMs ?? 120_000,
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      metrics.increment('llm_request_failure', { provider: this.provider });
      return err(response.error);
    }

    const text = response.value.data.choices?.[0]?.message?.content ?? '';
    const totalMs = Date.now() - startedAt;
    metrics.observe('llm_request_ms', totalMs, { provider: this.provider });

    if (text.trim() === '') {
      this.#logger.warn({ model: this.model }, 'provider returned an empty completion');
      return err(new UpstreamError(this.provider, 'empty completion'));
    }

    return ok({
      text,
      model: this.model,
      usage: {
        promptTokens: response.value.data.usage?.prompt_tokens ?? null,
        completionTokens: response.value.data.usage?.completion_tokens ?? null,
        totalMs,
      },
    });
  }

  /** OpenAI-style SSE: `data: {...}` lines terminated by `data: [DONE]`. */
  async *stream(
    messages: readonly ChatMessage[],
    options: CompletionOptions = {},
  ): AsyncIterable<Result<string, DomainError>> {
    const url = `${normalizeBase(this.#options.baseUrl)}/v1/chat/completions`;
    const body = JSON.stringify({
      model: this.model,
      messages,
      stream: true,
      temperature: options.temperature ?? this.#options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? this.#options.maxTokens ?? 1024,
    });

    yield* streamSse(url, body, this.#options, options, this.#headers());
  }
}

// ─── Streaming helpers ───────────────────────────────────────────────────────

/**
 * These bypass the resilient HTTP client deliberately: it buffers the whole
 * response to parse JSON, which defeats streaming. Streaming is only used by the
 * interactive console, where the user is watching and a failure is visible
 * immediately, so retries and caching add nothing.
 */
async function* streamNdjson(
  url: string,
  body: string,
  clientOptions: LlmClientOptions,
  options: CompletionOptions,
  extract: (chunk: unknown) => string | null,
): AsyncIterable<Result<string, DomainError>> {
  const controller = new AbortController();
  const timeoutMs = clientOptions.timeoutMs ?? 120_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      yield err(new UpstreamError('llm', `HTTP ${response.status}`, response.status));
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Keep the trailing partial line in the buffer.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          const token = extract(JSON.parse(trimmed));
          if (token) yield ok(token);
        } catch {
          // A malformed frame mid-stream is not worth aborting the whole answer.
        }
      }
    }
  } catch (error) {
    yield err(
      controller.signal.aborted
        ? new TimeoutError('llm stream', timeoutMs)
        : new UpstreamError('llm', (error as Error).message),
    );
  } finally {
    clearTimeout(timer);
  }
}

async function* streamSse(
  url: string,
  body: string,
  clientOptions: LlmClientOptions,
  options: CompletionOptions,
  headers: Record<string, string>,
): AsyncIterable<Result<string, DomainError>> {
  const controller = new AbortController();
  const timeoutMs = clientOptions.timeoutMs ?? 120_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  options.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      yield err(new UpstreamError('llm', `HTTP ${response.status}`, response.status));
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const token = parsed.choices?.[0]?.delta?.content;
          if (token) yield ok(token);
        } catch {
          // Ignore malformed frames.
        }
      }
    }
  } catch (error) {
    yield err(
      controller.signal.aborted
        ? new TimeoutError('llm stream', timeoutMs)
        : new UpstreamError('llm', (error as Error).message),
    );
  } finally {
    clearTimeout(timer);
  }
}

// ─── Embeddings ──────────────────────────────────────────────────────────────

export interface EmbeddingClientOptions extends Omit<
  LlmClientOptions,
  'temperature' | 'maxTokens'
> {
  dimensions: number;
}

export class OllamaEmbeddingClient implements EmbeddingClient {
  readonly provider = 'ollama';
  readonly model: string;
  readonly dimensions: number;
  readonly #options: EmbeddingClientOptions;

  constructor(options: EmbeddingClientOptions) {
    this.#options = options;
    this.model = options.model;
    this.dimensions = options.dimensions;
  }

  async isAvailable(): Promise<boolean> {
    const response = await this.#options.http.getJson<unknown>(
      `${normalizeBase(this.#options.baseUrl)}/api/tags`,
      { timeoutMs: 3_000 },
    );
    return response.ok;
  }

  async embed(texts: readonly string[]): Promise<Result<number[][], DomainError>> {
    if (texts.length === 0) return ok([]);

    // `/api/embed` accepts a batch; older Ollama only had single-input
    // `/api/embeddings`. Batch first, since it is dramatically faster.
    const response = await this.#options.http.request<{ embeddings?: number[][] }>({
      url: `${normalizeBase(this.#options.baseUrl)}/api/embed`,
      method: 'POST',
      body: { model: this.model, input: [...texts] },
      timeoutMs: this.#options.timeoutMs ?? 60_000,
    });

    if (!response.ok) return err(response.error);

    const embeddings = response.value.data.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
      return err(
        new UpstreamError(
          'ollama',
          `expected ${texts.length} embeddings, received ${embeddings?.length ?? 0}`,
        ),
      );
    }

    for (const vector of embeddings) {
      if (vector.length !== this.dimensions) {
        // A dimension mismatch would be rejected by the pgvector column anyway;
        // failing here names the actual cause.
        return err(
          new UpstreamError(
            'ollama',
            `embedding dimension mismatch: model returned ${vector.length}, EMBEDDING_DIMENSIONS is ${this.dimensions}`,
          ),
        );
      }
    }

    return ok(embeddings);
  }
}

export class OpenAiCompatibleEmbeddingClient implements EmbeddingClient {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  readonly #options: EmbeddingClientOptions;

  constructor(options: EmbeddingClientOptions, provider = 'openai-compatible') {
    this.#options = options;
    this.provider = provider;
    this.model = options.model;
    this.dimensions = options.dimensions;
  }

  #headers(): Record<string, string> {
    return this.#options.apiKey ? { authorization: `Bearer ${this.#options.apiKey}` } : {};
  }

  async isAvailable(): Promise<boolean> {
    const response = await this.#options.http.getJson<unknown>(
      `${normalizeBase(this.#options.baseUrl)}/v1/models`,
      { headers: this.#headers(), timeoutMs: 3_000 },
    );
    return response.ok;
  }

  async embed(texts: readonly string[]): Promise<Result<number[][], DomainError>> {
    if (texts.length === 0) return ok([]);

    const response = await this.#options.http.request<{
      data?: Array<{ embedding?: number[]; index?: number }>;
    }>({
      url: `${normalizeBase(this.#options.baseUrl)}/v1/embeddings`,
      method: 'POST',
      headers: this.#headers(),
      body: { model: this.model, input: [...texts] },
      timeoutMs: this.#options.timeoutMs ?? 60_000,
    });

    if (!response.ok) return err(response.error);

    const rows = response.value.data.data ?? [];
    if (rows.length !== texts.length) {
      return err(
        new UpstreamError(this.provider, `expected ${texts.length} embeddings, got ${rows.length}`),
      );
    }

    // The spec allows out-of-order results, so sort by index when present.
    const sorted = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors: number[][] = [];
    for (const row of sorted) {
      if (!Array.isArray(row.embedding)) {
        return err(new UpstreamError(this.provider, 'malformed embedding payload'));
      }
      if (row.embedding.length !== this.dimensions) {
        return err(
          new UpstreamError(
            this.provider,
            `embedding dimension mismatch: model returned ${row.embedding.length}, EMBEDDING_DIMENSIONS is ${this.dimensions}`,
          ),
        );
      }
      vectors.push(row.embedding);
    }

    return ok(vectors);
  }
}

// ─── Factories ───────────────────────────────────────────────────────────────

export type LlmProviderName =
  'ollama' | 'lmstudio' | 'openai-compatible' | 'llamacpp' | 'vllm' | 'null';

/**
 * Build an LLM client for the configured provider.
 * Returns null for `null`, which disables AI enrichment while leaving ingestion,
 * alerting and charts fully functional.
 */
export function createLlmClient(
  provider: LlmProviderName,
  options: LlmClientOptions,
): LlmClient | null {
  switch (provider) {
    case 'null':
      return null;
    case 'ollama':
      return new OllamaClient(options);
    // These all speak the OpenAI protocol; only the label differs, and the label
    // matters for metrics and the status page.
    case 'lmstudio':
      return new OpenAiCompatibleClient(options, 'lmstudio');
    case 'vllm':
      return new OpenAiCompatibleClient(options, 'vllm');
    case 'llamacpp':
      return new OpenAiCompatibleClient(options, 'llamacpp');
    case 'openai-compatible':
      return new OpenAiCompatibleClient(options);
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

export function createEmbeddingClient(
  provider: LlmProviderName,
  options: EmbeddingClientOptions,
): EmbeddingClient | null {
  switch (provider) {
    case 'null':
      return null;
    case 'ollama':
      return new OllamaEmbeddingClient(options);
    case 'lmstudio':
      return new OpenAiCompatibleEmbeddingClient(options, 'lmstudio');
    case 'vllm':
      return new OpenAiCompatibleEmbeddingClient(options, 'vllm');
    case 'llamacpp':
      return new OpenAiCompatibleEmbeddingClient(options, 'llamacpp');
    case 'openai-compatible':
      return new OpenAiCompatibleEmbeddingClient(options);
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}
