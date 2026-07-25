/**
 * Minimal in-process metrics with a Prometheus text exposition.
 *
 * Not a Prometheus client library: pulling one in would add a dependency for
 * counters, gauges and naive histograms that are ~150 lines here, and the
 * `/api/metrics` endpoint only needs to emit text. If this ever needs
 * exemplars, native histograms or push-gateway support, swap in `prom-client` —
 * the call sites only use `increment`/`observe`/`gauge`.
 */

type Labels = Record<string, string | number>;

interface HistogramState {
  count: number;
  sum: number;
  /** Bucket upper bounds in milliseconds, plus an implicit +Inf. */
  buckets: number[];
  counts: number[];
}

const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000];

function labelKey(name: string, labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${String(value).replace(/"/g, '\\"')}"`);
  return `${name}{${parts.join(',')}}`;
}

class MetricsRegistry {
  #counters = new Map<string, number>();
  #gauges = new Map<string, number>();
  #histograms = new Map<string, HistogramState>();
  /** Metric name -> help text, for the exposition output. */
  #help = new Map<string, string>();

  describe(name: string, help: string): void {
    this.#help.set(name, help);
  }

  increment(name: string, labels?: Labels, amount = 1): void {
    const key = labelKey(name, labels);
    this.#counters.set(key, (this.#counters.get(key) ?? 0) + amount);
  }

  gauge(name: string, value: number, labels?: Labels): void {
    this.#gauges.set(labelKey(name, labels), value);
  }

  observe(name: string, value: number, labels?: Labels): void {
    const key = labelKey(name, labels);
    let state = this.#histograms.get(key);
    if (!state) {
      state = {
        count: 0,
        sum: 0,
        buckets: DEFAULT_BUCKETS,
        counts: new Array(DEFAULT_BUCKETS.length + 1).fill(0),
      };
      this.#histograms.set(key, state);
    }
    state.count++;
    state.sum += value;
    let index = state.buckets.findIndex((bound) => value <= bound);
    if (index === -1) index = state.buckets.length; // +Inf bucket
    state.counts[index] = (state.counts[index] ?? 0) + 1;
  }

  /** Time an async operation and record its duration. */
  async time<T>(name: string, labels: Labels | undefined, fn: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      return await fn();
    } finally {
      this.observe(name, Date.now() - startedAt, labels);
    }
  }

  /** Structured snapshot, for the status UI and for tests. */
  snapshot(): {
    counters: Record<string, number>;
    gauges: Record<string, number>;
    histograms: Record<string, { count: number; sum: number; mean: number; p95: number }>;
  } {
    const histograms: Record<string, { count: number; sum: number; mean: number; p95: number }> =
      {};
    for (const [key, state] of this.#histograms) {
      histograms[key] = {
        count: state.count,
        sum: state.sum,
        mean: state.count === 0 ? 0 : state.sum / state.count,
        p95: estimateQuantile(state, 0.95),
      };
    }
    return {
      counters: Object.fromEntries(this.#counters),
      gauges: Object.fromEntries(this.#gauges),
      histograms,
    };
  }

  /** Prometheus text format (v0.0.4). */
  toPrometheus(): string {
    const lines: string[] = [];
    const emitted = new Set<string>();

    const header = (key: string, type: string): void => {
      const name = key.split('{')[0] ?? key;
      if (emitted.has(name)) return;
      emitted.add(name);
      const help = this.#help.get(name);
      if (help) lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
    };

    for (const [key, value] of this.#counters) {
      header(key, 'counter');
      lines.push(`${key} ${value}`);
    }
    for (const [key, value] of this.#gauges) {
      header(key, 'gauge');
      lines.push(`${key} ${value}`);
    }
    for (const [key, state] of this.#histograms) {
      header(key, 'histogram');
      const name = key.split('{')[0] ?? key;
      const labelPart = key.includes('{') ? key.slice(key.indexOf('{') + 1, -1) : '';
      const withLe = (le: string): string =>
        `${name}_bucket{${labelPart ? `${labelPart},` : ''}le="${le}"}`;

      let cumulative = 0;
      state.buckets.forEach((bound, index) => {
        cumulative += state.counts[index] ?? 0;
        lines.push(`${withLe(String(bound))} ${cumulative}`);
      });
      cumulative += state.counts[state.buckets.length] ?? 0;
      lines.push(`${withLe('+Inf')} ${cumulative}`);
      lines.push(`${name}_sum${labelPart ? `{${labelPart}}` : ''} ${state.sum}`);
      lines.push(`${name}_count${labelPart ? `{${labelPart}}` : ''} ${state.count}`);
    }

    return `${lines.join('\n')}\n`;
  }

  reset(): void {
    this.#counters.clear();
    this.#gauges.clear();
    this.#histograms.clear();
  }
}

/**
 * Linear interpolation within the containing bucket. Approximate by
 * construction — good enough to answer "is ingestion lag getting worse".
 */
function estimateQuantile(state: HistogramState, quantile: number): number {
  if (state.count === 0) return 0;
  const target = state.count * quantile;
  let cumulative = 0;
  for (let i = 0; i < state.buckets.length; i++) {
    const bucketCount = state.counts[i] ?? 0;
    if (cumulative + bucketCount >= target) {
      const lower = i === 0 ? 0 : state.buckets[i - 1]!;
      const upper = state.buckets[i]!;
      if (bucketCount === 0) return upper;
      return lower + ((target - cumulative) / bucketCount) * (upper - lower);
    }
    cumulative += bucketCount;
  }
  return state.buckets[state.buckets.length - 1]!;
}

/** Process-wide registry. */
export const metrics = new MetricsRegistry();

metrics.describe('http_request_ms', 'Upstream HTTP request duration in milliseconds');
metrics.describe('http_request_success', 'Successful upstream HTTP requests');
metrics.describe('http_request_failure', 'Failed upstream HTTP requests after retries');
metrics.describe('http_cache_hit', 'Upstream HTTP responses served from cache');
metrics.describe('http_circuit_rejected', 'Requests rejected by an open circuit breaker');
metrics.describe('collector_run_ms', 'Connector collection run duration in milliseconds');
metrics.describe('collector_items_ingested', 'Records persisted by a connector run');
metrics.describe('events_ingested', 'Timeline events appended');
metrics.describe('events_duplicate', 'Events skipped as duplicates');
metrics.describe('ingestion_lag_ms', 'Delay between event occurrence and ingestion');
metrics.describe('llm_request_ms', 'LLM completion latency in milliseconds');
metrics.describe('llm_request_failure', 'Failed LLM completions');
metrics.describe('alerts_triggered', 'Alerts fired');
metrics.describe('notifications_sent', 'Notifications delivered per channel');

export type { MetricsRegistry };
