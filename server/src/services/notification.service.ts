import type { TenantDb } from '../db/pool.js';

const SEVERITY_RANK: Record<string, number> = {
  INFO: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

/**
 * Dispatch notifications for an event. Recipient lists come ONLY from this
 * org's notification_rules (queried under RLS), so tenant A's event can never
 * be delivered to tenant B's recipients. Rows are written with the org's id.
 */
export async function dispatchNotifications(
  db: TenantDb,
  organizationId: string,
  event: { id: string; severity: string; eventType: string; cameraId: string },
): Promise<number> {
  const rules = await db.query<{ id: string; channel: string; target: string; min_severity: string }>(
    `SELECT id, channel, target, min_severity FROM notification_rules WHERE enabled = true`,
  );
  let sent = 0;
  for (const rule of rules.rows) {
    if (SEVERITY_RANK[event.severity]! < SEVERITY_RANK[rule.min_severity]!) continue;
    await db.query(
      `INSERT INTO notifications(organization_id, event_id, notification_rule_id, channel, target, message)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        organizationId,
        event.id,
        rule.id,
        rule.channel,
        rule.target,
        `${event.severity} ${event.eventType} detected`,
      ],
    );
    sent += 1;
  }
  return sent;
}
