import { metrics } from '@cid/platform';

/**
 * GET /api/metrics — Prometheus exposition.
 *
 * Text rather than JSON so it can be scraped directly. Note this reports the
 * *web* process's counters; the worker exposes its own, and in a multi-process
 * deployment both should be scraped.
 */

export const dynamic = 'force-dynamic';

export function GET(): Response {
  return new Response(metrics.toPrometheus(), {
    status: 200,
    headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
  });
}
