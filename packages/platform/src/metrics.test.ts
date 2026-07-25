import { beforeEach, describe, expect, it } from 'vitest';
import { metrics } from './metrics.js';

describe('metrics', () => {
  beforeEach(() => {
    metrics.reset();
  });

  it('accumulates counters', () => {
    metrics.increment('events_ingested');
    metrics.increment('events_ingested', undefined, 4);
    expect(metrics.snapshot().counters.events_ingested).toBe(5);
  });

  it('keeps label sets separate', () => {
    metrics.increment('http_request_success', { provider: 'coingecko' });
    metrics.increment('http_request_success', { provider: 'binance' });
    metrics.increment('http_request_success', { provider: 'binance' });

    const { counters } = metrics.snapshot();
    expect(counters['http_request_success{provider="coingecko"}']).toBe(1);
    expect(counters['http_request_success{provider="binance"}']).toBe(2);
  });

  it('normalises label order so the same labels share a series', () => {
    metrics.increment('x', { a: '1', b: '2' });
    metrics.increment('x', { b: '2', a: '1' });
    expect(metrics.snapshot().counters['x{a="1",b="2"}']).toBe(2);
  });

  it('records gauges as last-write-wins', () => {
    metrics.gauge('queue_depth', 10);
    metrics.gauge('queue_depth', 3);
    expect(metrics.snapshot().gauges.queue_depth).toBe(3);
  });

  it('summarises histogram observations', () => {
    for (const value of [10, 20, 30, 40]) metrics.observe('http_request_ms', value);
    const histogram = metrics.snapshot().histograms.http_request_ms;
    expect(histogram?.count).toBe(4);
    expect(histogram?.sum).toBe(100);
    expect(histogram?.mean).toBe(25);
  });

  it('estimates a p95 inside the observed range', () => {
    for (let i = 1; i <= 100; i++) metrics.observe('http_request_ms', i * 10);
    const p95 = metrics.snapshot().histograms.http_request_ms?.p95 ?? 0;
    expect(p95).toBeGreaterThan(500);
    expect(p95).toBeLessThanOrEqual(1_000);
  });

  it('reports a zero p95 for an unobserved histogram', () => {
    expect(metrics.snapshot().histograms.nothing).toBeUndefined();
  });

  it('handles values beyond the largest bucket', () => {
    metrics.observe('http_request_ms', 999_999);
    const histogram = metrics.snapshot().histograms.http_request_ms;
    expect(histogram?.count).toBe(1);
    expect(histogram?.p95).toBeGreaterThan(0);
  });

  it('times an async operation', async () => {
    await metrics.time('llm_request_ms', { model: 'test' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'done';
    });
    expect(metrics.snapshot().histograms['llm_request_ms{model="test"}']?.count).toBe(1);
  });

  it('records a duration even when the timed operation throws', async () => {
    await expect(
      metrics.time('llm_request_ms', undefined, async () => {
        throw new Error('model down');
      }),
    ).rejects.toThrow('model down');
    expect(metrics.snapshot().histograms.llm_request_ms?.count).toBe(1);
  });

  it('emits valid Prometheus exposition text', () => {
    metrics.increment('events_ingested', { source: 'coindesk' }, 3);
    metrics.gauge('tracked_coins', 42);
    metrics.observe('http_request_ms', 15, { provider: 'binance' });

    const text = metrics.toPrometheus();

    expect(text).toContain('# TYPE events_ingested counter');
    expect(text).toContain('events_ingested{source="coindesk"} 3');
    expect(text).toContain('# TYPE tracked_coins gauge');
    expect(text).toContain('tracked_coins 42');
    expect(text).toContain('# TYPE http_request_ms histogram');
    expect(text).toContain('http_request_ms_bucket{provider="binance",le="25"} 1');
    expect(text).toContain('http_request_ms_bucket{provider="binance",le="+Inf"} 1');
    expect(text).toContain('http_request_ms_count{provider="binance"} 1');
    expect(text).toContain('http_request_ms_sum{provider="binance"} 15');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('emits histogram buckets as monotonically cumulative counts', () => {
    for (const value of [1, 30, 300, 3_000]) metrics.observe('h', value);
    const lines = metrics
      .toPrometheus()
      .split('\n')
      .filter((line) => line.startsWith('h_bucket'));

    const counts = lines.map((line) => Number(line.split(' ')[1]));
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!);
    }
    expect(counts[counts.length - 1]).toBe(4);
  });

  it('escapes quotes in label values', () => {
    metrics.increment('x', { name: 'a"b' });
    expect(metrics.toPrometheus()).toContain('a\\"b');
  });

  it('includes registered help text', () => {
    metrics.increment('events_ingested');
    expect(metrics.toPrometheus()).toContain('# HELP events_ingested');
  });

  it('clears everything on reset', () => {
    metrics.increment('a');
    metrics.gauge('b', 1);
    metrics.observe('c', 1);
    metrics.reset();

    const snapshot = metrics.snapshot();
    expect(Object.keys(snapshot.counters)).toHaveLength(0);
    expect(Object.keys(snapshot.gauges)).toHaveLength(0);
    expect(Object.keys(snapshot.histograms)).toHaveLength(0);
  });
});
