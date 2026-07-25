/**
 * `@cid/ai` — the intelligence layer.
 *
 * Local-LLM provider adapters, event enrichment, embeddings, the RAG research
 * agent and report generation.
 *
 * Design rule throughout: the model supplies judgement, the deterministic code
 * in `@cid/core` supplies numbers. Scores stay reproducible and comparable
 * across model swaps, and every AI feature degrades to a useful non-AI path
 * when `LLM_PROVIDER=null` or the backend is unreachable.
 */

export * from './providers/llm.js';
export * from './json.js';
export * from './enricher.js';
export * from './agent.js';
export * from './reports.js';
export * from './testing.js';
