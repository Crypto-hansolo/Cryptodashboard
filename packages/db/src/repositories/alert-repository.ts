import type {
  Alert,
  AlertDraft,
  AlertRepository,
  AlertTrigger,
  NotificationDelivery,
} from '@cid/core';
import { alertRuleSchema } from '@cid/core';
import type { Prisma } from '@prisma/client';
import type { Db } from '../client.js';
import { toAlertTrigger } from '../mappers.js';

/**
 * Alert persistence.
 *
 * Rules are stored as JSON and validated with `alertRuleSchema` on the way out,
 * so a rule written by an older version of the app (or hand-edited in the
 * database) cannot crash the evaluation loop — it is skipped with a warning
 * instead.
 */
export class PrismaAlertRepository implements AlertRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Parse a row, returning null when its stored rule no longer validates. */
  #toAlert(row: {
    id: string;
    userId: string;
    name: string;
    rule: Prisma.JsonValue;
    channels: Alert['channels'];
    isEnabled: boolean;
    cooldownSeconds: number;
    lastTriggeredAt: Date | null;
    triggerCount: number;
    createdAt: Date;
    updatedAt: Date;
  }): Alert | null {
    const parsed = alertRuleSchema.safeParse(row.rule);
    if (!parsed.success) return null;
    return { ...row, rule: parsed.data };
  }

  async listForUser(userId: string): Promise<Alert[]> {
    const rows = await this.#db.alert.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.flatMap((row) => {
      const alert = this.#toAlert(row);
      return alert ? [alert] : [];
    });
  }

  async listEnabled(): Promise<Alert[]> {
    const rows = await this.#db.alert.findMany({ where: { isEnabled: true } });
    return rows.flatMap((row) => {
      const alert = this.#toAlert(row);
      return alert ? [alert] : [];
    });
  }

  async findById(id: string): Promise<Alert | null> {
    const row = await this.#db.alert.findUnique({ where: { id } });
    return row ? this.#toAlert(row) : null;
  }

  async create(draft: AlertDraft): Promise<Alert> {
    const row = await this.#db.alert.create({
      data: {
        userId: draft.userId,
        name: draft.name,
        rule: draft.rule as unknown as Prisma.InputJsonValue,
        channels: draft.channels,
        isEnabled: draft.isEnabled ?? true,
        cooldownSeconds: draft.cooldownSeconds ?? 300,
      },
    });
    const alert = this.#toAlert(row);
    if (!alert) throw new Error('Created alert failed rule validation');
    return alert;
  }

  async update(id: string, patch: Partial<AlertDraft>): Promise<Alert> {
    const row = await this.#db.alert.update({
      where: { id },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.rule !== undefined
          ? { rule: patch.rule as unknown as Prisma.InputJsonValue }
          : {}),
        ...(patch.channels !== undefined ? { channels: patch.channels } : {}),
        ...(patch.isEnabled !== undefined ? { isEnabled: patch.isEnabled } : {}),
        ...(patch.cooldownSeconds !== undefined ? { cooldownSeconds: patch.cooldownSeconds } : {}),
      },
    });
    const alert = this.#toAlert(row);
    if (!alert) throw new Error('Updated alert failed rule validation');
    return alert;
  }

  async remove(id: string): Promise<void> {
    await this.#db.alert.delete({ where: { id } });
  }

  /**
   * Atomically claim a firing.
   *
   * The conditional `updateMany` is the concurrency guard: two worker replicas
   * evaluating the same signal both try to claim, and only the one whose update
   * matches a row still outside its cooldown proceeds. Returning null tells the
   * loser to drop the notification rather than send a duplicate.
   */
  async recordTrigger(
    alertId: string,
    trigger: Omit<AlertTrigger, 'id' | 'alertId'>,
  ): Promise<AlertTrigger | null> {
    return this.#db.$transaction(async (tx) => {
      const alert = await tx.alert.findUnique({
        where: { id: alertId },
        select: { cooldownSeconds: true, lastTriggeredAt: true, isEnabled: true },
      });
      if (!alert || !alert.isEnabled) return null;

      const cooldownFloor =
        alert.cooldownSeconds > 0
          ? new Date(trigger.triggeredAt.getTime() - alert.cooldownSeconds * 1000)
          : null;

      const claimed = await tx.alert.updateMany({
        where: {
          id: alertId,
          isEnabled: true,
          // Claim only if nobody fired inside the cooldown window.
          ...(cooldownFloor
            ? { OR: [{ lastTriggeredAt: null }, { lastTriggeredAt: { lt: cooldownFloor } }] }
            : {}),
        },
        data: { lastTriggeredAt: trigger.triggeredAt, triggerCount: { increment: 1 } },
      });

      if (claimed.count === 0) return null;

      const created = await tx.alertTrigger.create({
        data: {
          alertId,
          eventId: trigger.eventId,
          coinId: trigger.coinId,
          triggeredAt: trigger.triggeredAt,
          title: trigger.title,
          message: trigger.message,
          observedValue: trigger.observedValue,
          payload: (trigger.payload ?? {}) as Prisma.InputJsonValue,
        },
      });
      return toAlertTrigger(created);
    });
  }

  async listTriggers(input: { userId: string; limit: number }): Promise<AlertTrigger[]> {
    const rows = await this.#db.alertTrigger.findMany({
      where: { alert: { userId: input.userId } },
      orderBy: { triggeredAt: 'desc' },
      take: input.limit,
    });
    return rows.map(toAlertTrigger);
  }

  async recordDelivery(delivery: Omit<NotificationDelivery, 'id' | 'createdAt'>): Promise<void> {
    await this.#db.notificationDelivery.create({ data: delivery });
  }

  async listPendingDeliveries(limit: number): Promise<NotificationDelivery[]> {
    return this.#db.notificationDelivery.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  /** Mark a delivery attempt's outcome. */
  async updateDelivery(
    id: string,
    patch: { status: NotificationDelivery['status']; error?: string | null; sentAt?: Date | null },
  ): Promise<void> {
    await this.#db.notificationDelivery.update({
      where: { id },
      data: {
        status: patch.status,
        error: patch.error ?? null,
        sentAt: patch.sentAt ?? null,
        attempts: { increment: 1 },
      },
    });
  }
}
