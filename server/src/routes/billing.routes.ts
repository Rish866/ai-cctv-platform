import { Router } from 'express';
import { asyncHandler } from '../middleware/http.js';
import {
  requireAuth,
  requireOrganizationMembership,
  requirePermission,
  tenantDb,
} from '../middleware/context.js';
import { requireTenantResource } from '../services/resource.service.js';

export const billingRouter = Router();
billingRouter.use(requireAuth, requireOrganizationMembership);

/** Subscription for the current org (there is exactly one). Tenant scoped. */
billingRouter.get(
  '/subscription',
  requirePermission('billing:read'),
  asyncHandler(async (req, res) => {
    const sub = await tenantDb(req, async (db) => {
      const r = await db.query(
        `SELECT s.*, (SELECT count(*) FROM cameras)::int AS cameras_used
         FROM subscriptions s LIMIT 1`,
      );
      return r.rows[0] ?? null;
    });
    res.json({ subscription: sub });
  }),
);

/** Invoices for the current org only. */
billingRouter.get(
  '/invoices',
  requirePermission('billing:read'),
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req, async (db) =>
      (await db.query('SELECT * FROM invoices ORDER BY created_at DESC')).rows,
    );
    res.json({ invoices: rows });
  }),
);

billingRouter.get(
  '/invoices/:id',
  requirePermission('billing:read'),
  asyncHandler(async (req, res) => {
    const row = await tenantDb(req, (db) => requireTenantResource(db, 'invoices', req.params.id!));
    res.json({ invoice: row });
  }),
);

/** Change plan (OWNER only). Adjusts camera limit accordingly. */
billingRouter.post(
  '/subscription/plan',
  requirePermission('billing:manage'),
  asyncHandler(async (req, res) => {
    const plan = String(req.body?.plan ?? '');
    const limits: Record<string, number> = { TRIAL: 5, STARTER: 10, GROWTH: 50, ENTERPRISE: 500 };
    if (!(plan in limits)) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'Unknown plan' });
      return;
    }
    const sub = await tenantDb(req, async (db) => {
      const r = await db.query(
        `UPDATE subscriptions SET plan = $1::subscription_plan, status = 'ACTIVE',
           camera_limit = $2, updated_at = now()
         RETURNING *`,
        [plan, limits[plan]],
      );
      return r.rows[0];
    });
    res.json({ subscription: sub });
  }),
);
