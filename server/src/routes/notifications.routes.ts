import { Router } from 'express';
import { notificationRuleSchema } from '../lib/validation.js';
import { asyncHandler } from '../middleware/http.js';
import {
  getCurrentOrganization,
  requireAuth,
  requireOrganizationMembership,
  requirePermission,
  tenantDb,
} from '../middleware/context.js';
import { requireTenantResource } from '../services/resource.service.js';
import { audit } from '../services/audit.service.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth, requireOrganizationMembership);

// ---- Notification rules ----
notificationsRouter.get(
  '/rules',
  requirePermission('notifications:read'),
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req, async (db) => (await db.query('SELECT * FROM notification_rules ORDER BY created_at DESC')).rows);
    res.json({ rules: rows });
  }),
);

notificationsRouter.post(
  '/rules',
  requirePermission('notifications:manage'),
  asyncHandler(async (req, res) => {
    const input = notificationRuleSchema.parse(req.body);
    const org = getCurrentOrganization(req);
    const row = await tenantDb(req, async (db) => {
      const r = await db.query(
        `INSERT INTO notification_rules(organization_id, name, channel, target, min_severity, enabled)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [org, input.name, input.channel, input.target, input.minSeverity, input.enabled],
      );
      await audit(db, org, { action: 'notification_rule.create', resource: 'notification_rule', resourceId: r.rows[0]!.id as string, ip: req.ip });
      return r.rows[0];
    });
    res.status(201).json({ rule: row });
  }),
);

notificationsRouter.delete(
  '/rules/:id',
  requirePermission('notifications:manage'),
  asyncHandler(async (req, res) => {
    const org = getCurrentOrganization(req);
    await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'notification_rules', req.params.id!);
      await db.query('DELETE FROM notification_rules WHERE id = $1', [req.params.id]);
      await audit(db, org, { action: 'notification_rule.delete', resource: 'notification_rule', resourceId: req.params.id!, ip: req.ip });
    });
    res.json({ ok: true });
  }),
);

// ---- Delivered notifications (in-app inbox) ----
notificationsRouter.get(
  '/',
  requirePermission('notifications:read'),
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req, async (db) =>
      (await db.query('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100')).rows,
    );
    res.json({ notifications: rows });
  }),
);

notificationsRouter.post(
  '/:id/read',
  requirePermission('notifications:read'),
  asyncHandler(async (req, res) => {
    await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'notifications', req.params.id!);
      await db.query('UPDATE notifications SET read_at = now() WHERE id = $1', [req.params.id]);
    });
    res.json({ ok: true });
  }),
);
