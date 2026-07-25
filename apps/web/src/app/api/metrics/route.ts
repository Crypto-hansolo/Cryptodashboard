import { metrics } from '@cid/platform';

/**
 * GET /api/metrics — Prometheus exposition.
 *
 * Text rather than JSON so it can be scraped directly. Note this reports the
 * *web* process's counters only. The worker records into its own in-process
 * registry and serves no HTTP, so its collection telemetry is persisted to
 * `CollectorRun` and surfaced by /api/health rather than scraped here.
 */

export const dynamic = 'force-dynamic';

metrics.describe('process_uptime_seconds', 'Seconds since this process started');
metrics.describe('process_resident_memory_bytes', 'Resident set size in bytes');
metrics.describe('nodejs_heap_used_bytes', 'V8 heap currently in use, in bytes');

export function GET(): Response {
  /*
   * Sample process gauges on every scrape.
   *
   * Without these the endpoint returns an empty body until something else
   * happens to record a metric, which makes a fresh process look broken to a
   * monitor and gives no baseline to alert on. Reading them here rather than on a
   * timer means no work happens between scrapes.
   */
  const memory = process.memoryUsage();
  metrics.gauge('process_uptime_seconds', Math.round(process.uptime()));
  metrics.gauge('process_resident_memory_bytes', memory.rss);
  metrics.gauge('nodejs_heap_used_bytes', memory.heapUsed);

  return new Response(metrics.toPrometheus(), {
    status: 200,
    headers: {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
