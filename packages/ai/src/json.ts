/**
 * Tolerant JSON extraction from LLM output.
 *
 * Even with constrained decoding, small local models wrap JSON in prose, fence
 * it in ```json blocks, emit trailing commas, or append a chatty sentence after
 * the closing brace. Failing the whole enrichment on that would mean most events
 * never get scored, so the parser is deliberately forgiving — but it validates
 * with zod afterwards, so forgiving parsing never means accepting bad data.
 */

/**
 * Find the first balanced JSON object or array in a string.
 *
 * Brace counting rather than a regex: regexes cannot match nested structures,
 * and `summary` fields routinely contain braces and quotes.
 */
export function extractJsonBlock(text: string): string | null {
  // Prefer a fenced block when present — it is the model's own delimiter.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const haystack = fenced?.[1] ?? text;

  const start = haystack.search(/[[{]/);
  if (start === -1) return null;

  const opening = haystack[start];
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < haystack.length; i++) {
    const char = haystack[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    // Braces inside a string literal are content, not structure.
    if (inString) continue;

    if (char === opening) depth++;
    else if (char === closing) {
      depth--;
      if (depth === 0) return haystack.slice(start, i + 1);
    }
  }

  return null;
}

/** Repair the malformations local models produce most often. */ function repairJson(
  input: string,
): string {
  return (
    input
      // Trailing commas before a close.
      .replace(/,(\s*[}\]])/g, '$1')
      // Python/JS literals a model may emit instead of JSON ones.
      .replace(/:\s*None\b/g, ': null')
      .replace(/:\s*True\b/g, ': true')
      .replace(/:\s*False\b/g, ': false')
      .replace(/:\s*NaN\b/g, ': null')
      // Smart quotes around keys/values.
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
  );
}

/**
 * Parse JSON from model output, trying progressively more aggressive repairs.
 * Returns null rather than throwing; the caller falls back to lexicon scoring.
 */
export function parseLlmJson<T = unknown>(text: string): T | null {
  const candidates: string[] = [];

  const block = extractJsonBlock(text);
  if (block) candidates.push(block, repairJson(block));
  // Last resort: the whole response might be bare JSON with stray whitespace.
  candidates.push(text.trim(), repairJson(text.trim()));

  for (const candidate of candidates) {
    if (candidate === '') continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try the next repair strategy.
    }
  }

  return null;
}
