import { route } from '@/server/api';
import { getServices } from '@/server/container';
import { getPrismaClient } from '@cid/db';

/**
 * GET /api/health — readiness and dependency status.
 *
 * Reports each dependency separately rather than a single boolean: "the LLM is
 * down but ingestion is fine" is a different operational situation from "the
 * database is unreachable", and a single flag cannot express it.
 *
 * Always 200 so a monitor distinguishes "app responding, dependency degraded"
 * from "app dead". `status` carries the verdict.
 */

export const dynamic = 'force-dynamic';

export function GET() {
  return route(async () => {
    const { repositories, llm, embeddings, env } = getServices();
    const startedAt = Date.now();

    const checks: Record<string, { ok: boolean; detail?: string; latencyMs?: number }> = {};

    // Database
    const dbStart = Date.now();
    try {
      await getPrismaClient().$queryRaw`SELECT 1`;
      checks.database = { ok: true, latencyMs: Date.now() - dbStart };
    } catch (error) {
      checks.database = {
        ok: false,
        detail: error instanceof Error ? error.message : 'unreachable',
        latencyMs: Date.now() - dbStart,
      };
    }

    // Model backends — optional, so "not configured" is `ok: true` with detail.
    if (llm) {
      const llmStart = Date.now();
      const available = await llm.isAvailable();
      checks.llm = {
        ok: available,
        detail: `${llm.provider}/${llm.model}`,
        latencyMs: Date.now() - llmStart,
      };
    } else {
      checks.llm = { ok: true, detail: 'disabled (LLM_PROVIDER=null)' };
    }

    if (embeddings) {
      const available = await embeddings.isAvailable();
      checks.embeddings = { ok: available, detail: `${embeddings.provider}/${embeddings.model}` };
    } else {
      checks.embeddings = { ok: true, detail: 'disabled' };
    }

    // Ingestion freshness: the number that actually says whether the platform is
    // doing its job.
    let ingestion: {
      connectors: number;
      failing: string[];
      lagP50Ms: number | null;
      lagP95Ms: number | null;
    } = { connectors: 0, failing: [], lagP50Ms: null, lagP95Ms: null };

    try {
      const since = new Date(Date.now() - 3_600_000);
      const [health, lag] = await Promise.all([
        repositories.telemetry.connectorHealth(since),
        repositories.telemetry.ingestionLag(since),
      ]);
      ingestion = {
        connectors: health.length,
        failing: health
          .filter((entry) => entry.lastStatus === 'FAILED')
          .map((entry) => entry.connectorKey),
        lagP50Ms: lag?.p50Ms ?? null,
        lagP95Ms: lag?.p95Ms ?? null,
      };
    } catch {
      // Telemetry being unavailable is not itself a health failure.
    }

    const critical = checks.database?.ok === true;
    const degraded = Object.values(checks).some((check) => !check.ok);

    return {
      status: critical ? (degraded ? 'degraded' : 'ok') : 'unhealthy',
      version: '1.0.0',
      environment: env.NODE_ENV,
      checks,
      ingestion,
      tookMs: Date.now() - startedAt,
    };
  });
}
