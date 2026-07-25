import { z } from 'zod';
import { REPORT_KINDS } from '@cid/core';
import { parseQuery, route } from '@/server/api';
import { getServices } from '@/server/container';

/** GET /api/reports — generated briefings, newest first. */

export const dynamic = 'force-dynamic';

const querySchema = z.object({
  kind: z.enum(REPORT_KINDS).optional(),
  id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export function GET(request: Request) {
  return route(async () => {
    const query = parseQuery(request, querySchema);
    const { repositories } = getServices();

    if (query.id) {
      const report = await repositories.reports.findById(query.id);
      if (!report) return { report: null };
      return {
        report: {
          ...report,
          periodStart: report.periodStart.toISOString(),
          periodEnd: report.periodEnd.toISOString(),
          createdAt: report.createdAt.toISOString(),
        },
      };
    }

    const reports = await repositories.reports.list({
      ...(query.kind ? { kind: query.kind } : {}),
      limit: query.limit,
    });

    // List view omits the body: report bodies are multi-kilobyte Markdown and
    // the list only needs headers.
    return {
      reports: reports.map((report) => ({
        id: report.id,
        kind: report.kind,
        title: report.title,
        periodStart: report.periodStart.toISOString(),
        periodEnd: report.periodEnd.toISOString(),
        createdAt: report.createdAt.toISOString(),
        model: report.model,
        eventCount: (report.metadata as { eventCount?: number }).eventCount ?? null,
      })),
    };
  });
}
