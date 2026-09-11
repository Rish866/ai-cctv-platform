import { Router } from 'express';
import { searchSchema } from '../lib/validation.js';
import { asyncHandler } from '../middleware/http.js';
import {
  getCurrentOrganization,
  requireAuth,
  requireOrganizationMembership,
  requirePermission,
  tenantDb,
} from '../middleware/context.js';
import { cacheGet, cacheSet } from '../services/cache.service.js';

// ---- Dashboard (tenant-scoped metrics) ----
export const dashboardRouter = Router();
dashboardRouter.use(requireAuth, requireOrganizationMembership);

dashboardRouter.get(
  '/',
  requirePermission('events:read'),
  asyncHandler(async (req, res) => {
    const org = getCurrentOrganization(req);
    const cached = cacheGet(org, 'dashboard_stats');
    if (cached) {
      res.json({ stats: cached, cached: true });
      return;
    }
    const stats = await tenantDb(req, async (db) => {
      const r = await db.query<{
        total_cameras: number;
        online_cameras: number;
        offline_cameras: number;
        events_today: number;
        critical_events: number;
        unresolved_events: number;
        site_count: number;
      }>(
        `SELECT
          (SELECT count(*) FROM cameras)::int AS total_cameras,
          (SELECT count(*) FROM cameras WHERE status = 'ONLINE')::int AS online_cameras,
          (SELECT count(*) FROM cameras WHERE status = 'OFFLINE')::int AS offline_cameras,
          (SELECT count(*) FROM events WHERE occurred_at >= date_trunc('day', now()))::int AS events_today,
          (SELECT count(*) FROM events WHERE severity = 'CRITICAL')::int AS critical_events,
          (SELECT count(*) FROM events WHERE status IN ('OPEN','ACKNOWLEDGED'))::int AS unresolved_events,
          (SELECT count(*) FROM sites)::int AS site_count`,
      );
      return r.rows[0];
    });
    // Cache is tenant-namespaced (tenant:{org}:dashboard_stats) — never shared.
    cacheSet(org, 'dashboard_stats', stats, 15);
    res.json({ stats, cached: false });
  }),
);

/**
 * Safety & Security dashboard widgets (ADD-ON). Separate endpoint so the
 * existing dashboard is untouched. All counts are tenant-scoped (RLS) and
 * cached under a tenant-namespaced key.
 */
dashboardRouter.get(
  '/security',
  requirePermission('events:read'),
  asyncHandler(async (req, res) => {
    const org = getCurrentOrganization(req);
    const cached = cacheGet(org, 'dashboard_security');
    if (cached) {
      res.json({ stats: cached, cached: true });
      return;
    }
    const stats = await tenantDb(req, async (db) => {
      const r = await db.query<Record<string, number>>(
        `SELECT
          (SELECT count(*) FROM events WHERE event_type IN ('FIRE','FIRE_AND_SMOKE') AND occurred_at >= date_trunc('day', now()))::int AS fire_today,
          (SELECT count(*) FROM events WHERE event_type IN ('SMOKE','FIRE_AND_SMOKE') AND occurred_at >= date_trunc('day', now()))::int AS smoke_today,
          (SELECT count(*) FROM events WHERE event_type IN ('UNAUTHORIZED_ENTRY','AFTER_HOURS_ACTIVITY','OBJECT_REMOVED','LOITERING_SECURITY','UNAUTHORIZED_VEHICLE','RESTRICTED_ZONE_ACTIVITY') AND occurred_at >= date_trunc('day', now()))::int AS security_today,
          (SELECT count(*) FROM events WHERE event_type = 'UNAUTHORIZED_ENTRY')::int AS unauthorized_entry,
          (SELECT count(*) FROM events WHERE event_type = 'AFTER_HOURS_ACTIVITY')::int AS after_hours,
          (SELECT count(*) FROM events WHERE event_type IN ('OBJECT_REMOVED','UNAUTHORIZED_VEHICLE','LOITERING_SECURITY','RESTRICTED_ZONE_ACTIVITY'))::int AS potential_theft,
          (SELECT count(*) FROM events WHERE severity = 'CRITICAL')::int AS critical_incidents,
          (SELECT count(*) FROM events WHERE status IN ('OPEN','ACKNOWLEDGED','INVESTIGATING'))::int AS open_incidents`,
      );
      return r.rows[0];
    });
    cacheSet(org, 'dashboard_security', stats, 15);
    res.json({ stats, cached: false });
  }),
);

// ---- Search (tenant scoped: only the current org's data) ----
export const searchRouter = Router();
searchRouter.use(requireAuth, requireOrganizationMembership);

searchRouter.get(
  '/',
  requirePermission('events:read'),
  asyncHandler(async (req, res) => {
    const { q } = searchSchema.parse({ q: req.query.q });
    const like = `%${q}%`;
    const results = await tenantDb(req, async (db) => {
      // All four queries run under RLS => automatically org-scoped.
      const cameras = (await db.query('SELECT id, name FROM cameras WHERE name ILIKE $1 LIMIT 20', [like])).rows;
      const sites = (await db.query('SELECT id, name FROM sites WHERE name ILIKE $1 LIMIT 20', [like])).rows;
      const events = (await db.query(`SELECT id, event_type, severity FROM events WHERE event_type::text ILIKE $1 LIMIT 20`, [like])).rows;
      const reports = (await db.query('SELECT id, name FROM reports WHERE name ILIKE $1 LIMIT 20', [like])).rows;
      return { cameras, sites, events, reports };
    });
    res.json({ query: q, results });
  }),
);

// ---- Audit logs (tenant scoped) ----
export const auditRouter = Router();
auditRouter.use(requireAuth, requireOrganizationMembership);

auditRouter.get(
  '/',
  requirePermission('audit:read'),
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req, async (db) =>
      (await db.query(
        `SELECT a.*, u.email AS user_email FROM audit_logs a
         LEFT JOIN users u ON u.id = a.user_id
         ORDER BY a.created_at DESC LIMIT 200`,
      )).rows,
    );
    res.json({ auditLogs: rows });
  }),
);
