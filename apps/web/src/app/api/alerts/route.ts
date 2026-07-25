import { z } from 'zod';
import { NOTIFICATION_CHANNELS, alertRuleSchema } from '@cid/core';
import { parseQuery, route } from '@/server/api';
import { getLocalUserId, getServices } from '@/server/container';

/**
 * GET    /api/alerts  — configured alerts plus recent firings
 * POST   /api/alerts  — create
 * PATCH  /api/alerts  — update (including enable/disable)
 * DELETE /api/alerts?id=
 *
 * Rules are validated with the same schema the evaluation engine uses, so the UI
 * cannot persist a rule the worker would later reject.
 */

export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return route(request, async () => {
    const { repositories } = getServices();
    const userId = await getLocalUserId();

    const [alerts, triggers] = await Promise.all([
      repositories.alerts.listForUser(userId),
      repositories.alerts.listTriggers({ userId, limit: 50 }),
    ]);

    return {
      alerts: alerts.map((alert) => ({
        id: alert.id,
        name: alert.name,
        rule: alert.rule,
        channels: alert.channels,
        isEnabled: alert.isEnabled,
        cooldownSeconds: alert.cooldownSeconds,
        lastTriggeredAt: alert.lastTriggeredAt?.toISOString() ?? null,
        triggerCount: alert.triggerCount,
      })),
      triggers: triggers.map((trigger) => ({
        id: trigger.id,
        alertId: trigger.alertId,
        eventId: trigger.eventId,
        coinId: trigger.coinId,
        triggeredAt: trigger.triggeredAt.toISOString(),
        title: trigger.title,
        message: trigger.message,
        observedValue: trigger.observedValue,
      })),
      availableChannels: NOTIFICATION_CHANNELS,
    };
  });
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  rule: alertRuleSchema,
  channels: z.array(z.enum(NOTIFICATION_CHANNELS)).min(1),
  cooldownSeconds: z.number().int().min(0).max(86_400).default(300),
  isEnabled: z.boolean().default(true),
});

export function POST(request: Request) {
  return route(request, async () => {
    const body = createSchema.parse(await request.json());
    const { repositories } = getServices();
    const userId = await getLocalUserId();

    const alert = await repositories.alerts.create({ userId, ...body });
    return { alert: { id: alert.id, name: alert.name } };
  });
}

const patchSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  rule: alertRuleSchema.optional(),
  channels: z.array(z.enum(NOTIFICATION_CHANNELS)).min(1).optional(),
  cooldownSeconds: z.number().int().min(0).max(86_400).optional(),
  isEnabled: z.boolean().optional(),
});

export function PATCH(request: Request) {
  return route(request, async () => {
    const { id, ...patch } = patchSchema.parse(await request.json());
    const { repositories } = getServices();
    const alert = await repositories.alerts.update(id, patch);
    return { alert: { id: alert.id, isEnabled: alert.isEnabled } };
  });
}

export function DELETE(request: Request) {
  return route(request, async () => {
    const { id } = parseQuery(request, z.object({ id: z.string().min(1) }));
    const { repositories } = getServices();
    await repositories.alerts.remove(id);
    return { removed: true };
  });
}
