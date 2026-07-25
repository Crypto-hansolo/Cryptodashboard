import { describe, expect, it } from 'vitest';
import { UpstreamError, isErr, isOk } from '@cid/core';
import { FakeHttpClient } from '@cid/platform/testing';
import {
  OllamaClient,
  OllamaEmbeddingClient,
  OpenAiCompatibleClient,
  OpenAiCompatibleEmbeddingClient,
  createEmbeddingClient,
  createLlmClient,
} from './llm.js';

/**
 * Provider adapters are pure translation: our `ChatMessage[]` in, a provider's
 * wire format out, and back. The bugs live in the translation — a field named
 * differently, an empty completion treated as success, an out-of-order embedding
 * batch — so these tests pin the exact payloads and the exact failure handling.
 */

const base = { baseUrl: 'http://localhost:11434', model: 'llama3.1:8b' };
const messages = [{ role: 'user' as const, content: 'Why is CRO up?' }];

describe('OllamaClient', () => {
  function client(routes: Parameters<typeof FakeHttpClient.prototype.on>[0][] = []) {
    const http = new FakeHttpClient(routes);
    return { http, llm: new OllamaClient({ ...base, http }) };
  }

  it('calls /api/chat with the model, messages and non-streaming flag', async () => {
    const { http, llm } = client([{ match: '/api/chat', body: { message: { content: 'Hi' } } }]);

    const result = await llm.complete(messages);

    expect(isOk(result)).toBe(true);
    expect(http.lastRequest?.url).toBe('http://localhost:11434/api/chat');
    expect(http.lastRequest?.method).toBe('POST');
    expect(http.lastRequest?.body).toMatchObject({
      model: 'llama3.1:8b',
      messages,
      stream: false,
    });
  });

  it('joins the URL correctly when the base has a trailing slash', async () => {
    const http = new FakeHttpClient([{ match: '/api/chat', body: { message: { content: 'ok' } } }]);
    const llm = new OllamaClient({ ...base, baseUrl: 'http://localhost:11434///', http });

    await llm.complete(messages);

    expect(http.lastRequest?.url).toBe('http://localhost:11434/api/chat');
  });

  it('passes a JSON schema through as `format` — the constrained-decoding lever', async () => {
    /*
     * This is the whole reason Ollama's native API is used instead of its
     * OpenAI-compatible shim: `format` constrains generation to the schema, which
     * takes an 8B model's structured-output reliability from "usually" to
     * "effectively always".
     */
    const { http, llm } = client([{ match: '/api/chat', body: { message: { content: '{}' } } }]);
    const jsonSchema = { type: 'object', properties: { sentiment: { type: 'string' } } };

    await llm.complete(messages, { jsonSchema });

    expect((http.lastRequest?.body as { format?: unknown }).format).toEqual(jsonSchema);
  });

  it('omits `format` entirely when no schema is requested', async () => {
    const { http, llm } = client([{ match: '/api/chat', body: { message: { content: 'x' } } }]);

    await llm.complete(messages);

    expect(http.lastRequest?.body).not.toHaveProperty('format');
  });

  it('maps generation options onto Ollama option names', async () => {
    const { http, llm } = client([{ match: '/api/chat', body: { message: { content: 'x' } } }]);

    await llm.complete(messages, { temperature: 0.9, maxTokens: 128, stop: ['\n\n'] });

    expect((http.lastRequest?.body as { options: Record<string, unknown> }).options).toEqual({
      temperature: 0.9,
      num_predict: 128,
      stop: ['\n\n'],
    });
  });

  it('prefers per-call options over client defaults', async () => {
    const http = new FakeHttpClient([{ match: '/api/chat', body: { message: { content: 'x' } } }]);
    const llm = new OllamaClient({ ...base, http, temperature: 0.1, maxTokens: 64 });

    await llm.complete(messages, { temperature: 0.7 });

    const options = (http.lastRequest?.body as { options: Record<string, unknown> }).options;
    // The call overrides temperature; maxTokens falls back to the client default.
    expect(options.temperature).toBe(0.7);
    expect(options.num_predict).toBe(64);
  });

  it('returns the completion text and token usage', async () => {
    const { llm } = client([
      {
        match: '/api/chat',
        body: {
          message: { content: 'CRO is up on a Binance listing.' },
          prompt_eval_count: 812,
          eval_count: 96,
        },
      },
    ]);

    const result = await llm.complete(messages);

    if (!isOk(result)) throw new Error('expected success');
    expect(result.value.text).toBe('CRO is up on a Binance listing.');
    expect(result.value.model).toBe('llama3.1:8b');
    expect(result.value.usage.promptTokens).toBe(812);
    expect(result.value.usage.completionTokens).toBe(96);
    expect(result.value.usage.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('reports missing usage counters as null rather than zero', async () => {
    // Zero would be a lie that pollutes any cost or throughput accounting.
    const { llm } = client([{ match: '/api/chat', body: { message: { content: 'x' } } }]);

    const result = await llm.complete(messages);

    if (!isOk(result)) throw new Error('expected success');
    expect(result.value.usage.promptTokens).toBeNull();
    expect(result.value.usage.completionTokens).toBeNull();
  });

  it('treats an empty completion as a failure, not an empty success', async () => {
    /*
     * An overloaded or mis-prompted local model returns "" with HTTP 200. Passing
     * that on as success would store an event with an empty summary and mark it
     * enriched, so it would never be retried.
     */
    const { llm } = client([{ match: '/api/chat', body: { message: { content: '   ' } } }]);

    const result = await llm.complete(messages);

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('UPSTREAM');
      expect(result.error.message).toContain('empty completion');
    }
  });

  it('treats a missing message field as an empty completion', async () => {
    const { llm } = client([{ match: '/api/chat', body: {} }]);

    expect(isErr(await llm.complete(messages))).toBe(true);
  });

  it('propagates a transport failure unchanged', async () => {
    const error = new UpstreamError('ollama', 'connection refused');
    const { llm } = client([{ match: '/api/chat', error }]);

    const result = await llm.complete(messages);

    if (!isErr(result)) throw new Error('expected failure');
    expect(result.error).toBe(error);
  });

  it('probes /api/tags for availability', async () => {
    const { http, llm } = client([{ match: '/api/tags', body: { models: [] } }]);

    expect(await llm.isAvailable()).toBe(true);
    expect(http.lastRequest?.url).toBe('http://localhost:11434/api/tags');
  });

  it('reports unavailable rather than throwing when the probe fails', async () => {
    const { llm } = client([{ match: '/api/tags', error: new UpstreamError('ollama', 'refused') }]);

    expect(await llm.isAvailable()).toBe(false);
  });
});

describe('OpenAiCompatibleClient', () => {
  const openAiBase = { baseUrl: 'http://localhost:1234/v1', model: 'local-model' };

  it('posts to /v1/chat/completions with OpenAI field names', async () => {
    const http = new FakeHttpClient([
      { match: '/chat/completions', body: { choices: [{ message: { content: 'Hi' } }] } },
    ]);
    const llm = new OpenAiCompatibleClient({ ...openAiBase, http });

    await llm.complete(messages, { temperature: 0.4, maxTokens: 256 });

    expect(http.lastRequest?.url).toBe('http://localhost:1234/v1/v1/chat/completions');
    expect(http.lastRequest?.body).toMatchObject({
      model: 'local-model',
      stream: false,
      temperature: 0.4,
      max_tokens: 256,
    });
  });

  it('reads the first choice and OpenAI usage counters', async () => {
    const http = new FakeHttpClient([
      {
        match: '/chat/completions',
        body: {
          choices: [{ message: { content: 'answer' } }, { message: { content: 'ignored' } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        },
      },
    ]);
    const llm = new OpenAiCompatibleClient({ ...openAiBase, http });

    const result = await llm.complete(messages);

    if (!isOk(result)) throw new Error('expected success');
    expect(result.value.text).toBe('answer');
    expect(result.value.usage.promptTokens).toBe(10);
    expect(result.value.usage.completionTokens).toBe(4);
  });

  it('requests a json_schema response format when a schema is given', async () => {
    const http = new FakeHttpClient([
      { match: '/chat/completions', body: { choices: [{ message: { content: '{}' } }] } },
    ]);
    const llm = new OpenAiCompatibleClient({ ...openAiBase, http });
    const jsonSchema = { type: 'object' };

    await llm.complete(messages, { jsonSchema });

    expect(http.lastRequest?.body).toMatchObject({
      response_format: {
        type: 'json_schema',
        // `strict: false`, because servers that only partially implement this
        // reject strict mode outright — the tolerant parser covers the gap.
        json_schema: { name: 'verdict', schema: jsonSchema, strict: false },
      },
    });
  });

  it('attaches a bearer token only when one is configured', async () => {
    const withKey = new FakeHttpClient([
      { match: '/chat/completions', body: { choices: [{ message: { content: 'x' } }] } },
    ]);
    await new OpenAiCompatibleClient({ ...openAiBase, http: withKey, apiKey: 'sk-local' }).complete(
      messages,
    );
    expect(withKey.lastRequest?.headers).toEqual({ authorization: 'Bearer sk-local' });

    const withoutKey = new FakeHttpClient([
      { match: '/chat/completions', body: { choices: [{ message: { content: 'x' } }] } },
    ]);
    await new OpenAiCompatibleClient({ ...openAiBase, http: withoutKey }).complete(messages);
    expect(withoutKey.lastRequest?.headers).toEqual({});
  });

  it('treats an empty or absent choice as a failure', async () => {
    const empty = new OpenAiCompatibleClient({
      ...openAiBase,
      http: new FakeHttpClient([{ match: '/chat/completions', body: { choices: [] } }]),
    });
    expect(isErr(await empty.complete(messages))).toBe(true);

    const blank = new OpenAiCompatibleClient({
      ...openAiBase,
      http: new FakeHttpClient([
        { match: '/chat/completions', body: { choices: [{ message: { content: '' } }] } },
      ]),
    });
    expect(isErr(await blank.complete(messages))).toBe(true);
  });

  it('carries the provider label into its errors, so metrics attribute correctly', async () => {
    const llm = new OpenAiCompatibleClient(
      {
        ...openAiBase,
        http: new FakeHttpClient([{ match: '/chat/completions', body: { choices: [] } }]),
      },
      'vllm',
    );

    const result = await llm.complete(messages);

    expect(llm.provider).toBe('vllm');
    if (!isErr(result)) throw new Error('expected failure');
    expect(result.error.message).toContain('vllm');
  });

  it('probes /v1/models for availability', async () => {
    const http = new FakeHttpClient([{ match: '/v1/models', body: { data: [] } }]);
    const llm = new OpenAiCompatibleClient({ ...openAiBase, http });

    expect(await llm.isAvailable()).toBe(true);
  });
});

describe('OllamaEmbeddingClient', () => {
  function client(routes: Parameters<typeof FakeHttpClient.prototype.on>[0][], dimensions = 3) {
    const http = new FakeHttpClient(routes);
    return { http, embeddings: new OllamaEmbeddingClient({ ...base, http, dimensions }) };
  }

  it('short-circuits an empty batch without calling the provider', async () => {
    const { http, embeddings } = client([]);

    const result = await embeddings.embed([]);

    expect(result).toEqual({ ok: true, value: [] });
    expect(http.requests).toHaveLength(0);
  });

  it('batches inputs into a single /api/embed call', async () => {
    const { http, embeddings } = client([
      {
        match: '/api/embed',
        body: {
          embeddings: [
            [0.1, 0.2, 0.3],
            [0.4, 0.5, 0.6],
          ],
        },
      },
    ]);

    const result = await embeddings.embed(['a', 'b']);

    if (!isOk(result)) throw new Error('expected success');
    expect(result.value).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    expect(http.requests).toHaveLength(1);
    expect(http.lastRequest?.body).toEqual({ model: 'llama3.1:8b', input: ['a', 'b'] });
  });

  it('rejects a short batch instead of silently misaligning vectors', async () => {
    /*
     * Two inputs, one vector: assigning it to the wrong event would poison
     * semantic search in a way nothing downstream could detect.
     */
    const { embeddings } = client([
      { match: '/api/embed', body: { embeddings: [[0.1, 0.2, 0.3]] } },
    ]);

    const result = await embeddings.embed(['a', 'b']);

    if (!isErr(result)) throw new Error('expected failure');
    expect(result.error.message).toContain('expected 2 embeddings, received 1');
  });

  it('rejects a dimension mismatch, naming the cause', async () => {
    // pgvector would reject the insert anyway; this says why.
    const { embeddings } = client([{ match: '/api/embed', body: { embeddings: [[0.1, 0.2]] } }], 3);

    const result = await embeddings.embed(['a']);

    if (!isErr(result)) throw new Error('expected failure');
    expect(result.error.message).toContain('model returned 2');
    expect(result.error.message).toContain('EMBEDDING_DIMENSIONS is 3');
  });

  it('rejects a malformed payload', async () => {
    const { embeddings } = client([{ match: '/api/embed', body: { embeddings: null } }]);

    expect(isErr(await embeddings.embed(['a']))).toBe(true);
  });
});

describe('OpenAiCompatibleEmbeddingClient', () => {
  const options = { baseUrl: 'http://localhost:8000', model: 'nomic', dimensions: 2 };

  it('reads the OpenAI data envelope', async () => {
    const http = new FakeHttpClient([
      { match: '/v1/embeddings', body: { data: [{ embedding: [0.1, 0.2], index: 0 }] } },
    ]);
    const embeddings = new OpenAiCompatibleEmbeddingClient({ ...options, http });

    const result = await embeddings.embed(['a']);

    expect(result).toEqual({ ok: true, value: [[0.1, 0.2]] });
  });

  it('reorders out-of-order results by index', async () => {
    /*
     * The OpenAI spec explicitly permits results in any order, and batching
     * servers do reorder them. Without the sort, embeddings would be attached to
     * the wrong events.
     */
    const http = new FakeHttpClient([
      {
        match: '/v1/embeddings',
        body: {
          data: [
            { embedding: [0.9, 0.9], index: 1 },
            { embedding: [0.1, 0.1], index: 0 },
          ],
        },
      },
    ]);
    const embeddings = new OpenAiCompatibleEmbeddingClient({ ...options, http });

    const result = await embeddings.embed(['first', 'second']);

    if (!isOk(result)) throw new Error('expected success');
    expect(result.value).toEqual([
      [0.1, 0.1],
      [0.9, 0.9],
    ]);
  });

  it('rejects a count mismatch and a dimension mismatch', async () => {
    const short = new OpenAiCompatibleEmbeddingClient({
      ...options,
      http: new FakeHttpClient([{ match: '/v1/embeddings', body: { data: [] } }]),
    });
    expect(isErr(await short.embed(['a']))).toBe(true);

    const wrongDims = new OpenAiCompatibleEmbeddingClient({
      ...options,
      http: new FakeHttpClient([
        { match: '/v1/embeddings', body: { data: [{ embedding: [0.1, 0.2, 0.3] }] } },
      ]),
    });
    const result = await wrongDims.embed(['a']);
    if (!isErr(result)) throw new Error('expected failure');
    expect(result.error.message).toContain('EMBEDDING_DIMENSIONS is 2');
  });

  it('rejects a row with no embedding array', async () => {
    const embeddings = new OpenAiCompatibleEmbeddingClient({
      ...options,
      http: new FakeHttpClient([{ match: '/v1/embeddings', body: { data: [{ index: 0 }] } }]),
    });

    const result = await embeddings.embed(['a']);

    if (!isErr(result)) throw new Error('expected failure');
    expect(result.error.message).toContain('malformed embedding payload');
  });
});

describe('factories', () => {
  const options = { http: new FakeHttpClient(), baseUrl: 'http://x', model: 'm' };

  it('returns null for the `null` provider, which is how AI is disabled', async () => {
    expect(createLlmClient('null', options)).toBeNull();
    expect(createEmbeddingClient('null', { ...options, dimensions: 1 })).toBeNull();
  });

  it('builds Ollama for ollama', () => {
    expect(createLlmClient('ollama', options)).toBeInstanceOf(OllamaClient);
    expect(createEmbeddingClient('ollama', { ...options, dimensions: 1 })).toBeInstanceOf(
      OllamaEmbeddingClient,
    );
  });

  it('builds an OpenAI-compatible client for the other providers, keeping the label', () => {
    // The label is not cosmetic: metrics, the health check and the status page
    // all key on `provider`, so "vllm is down" must not read as "openai".
    for (const provider of ['lmstudio', 'vllm', 'llamacpp', 'openai-compatible'] as const) {
      const llm = createLlmClient(provider, options);
      expect(llm).toBeInstanceOf(OpenAiCompatibleClient);
      expect(llm?.provider).toBe(provider);

      const embeddings = createEmbeddingClient(provider, { ...options, dimensions: 1 });
      expect(embeddings).toBeInstanceOf(OpenAiCompatibleEmbeddingClient);
      expect(embeddings?.provider).toBe(provider);
    }
  });
});
