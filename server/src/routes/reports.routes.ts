import { Router } from 'express';
import { reportSchema } from '../lib/validation.js';
import { asyncHandler } from '../middleware/http.js';
import {
  getAuthenticatedUser,
  getCurrentOrganization,
  requireAuth,
  requireOrganizationMembership,
  requirePermission,
  tenantDb,
} from '../middleware/context.js';
import { requireTenantResource } from '../services/resource.service.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth, requireOrganizationMembership);

reportsRouter.get(
  '/',
  requirePermission('reports:read'),
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req, async (db) => (await db.query('SELECT * FROM reports ORDER BY created_at DESC')).rows);
    res.json({ reports: rows });
  }),
);

reportsRouter.post(
  '/',
  requirePermission('reports:write'),
  asyncHandler(async (req, res) => {
    const input = reportSchema.parse(req.body);
    const org = getCurrentOrganization(req);
    const user = getAuthenticatedUser(req);
    const row = await tenantDb(req, async (db) => {
      const r = await db.query(
        `INSERT INTO reports(organization_id, name, kind, params, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [org, input.name, input.kind, JSON.stringify(input.params), user.id],
      );
      return r.rows[0];
    });
    res.status(201).json({ report: row });
  }),
);

/**
 * Generate report data (analytics) — ALWAYS tenant scoped. Every aggregate is
 * computed under RLS, so a report can only ever contain the current org's data.
 */
reportsRouter.get(
  '/:id/data',
  requirePermission('reports:read'),
  asyncHandler(async (req, res) => {
    const data = await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'reports', req.params.id!);
      const byType = (await db.query(
        `SELECT event_type, count(*)::int AS count FROM events GROUP BY event_type ORDER BY count DESC`,
      )).rows;
      const bySeverity = (await db.query(
        `SELECT severity, count(*)::int AS count FROM events GROUP BY severity`,
      )).rows;
      const totals = (await db.query(
        `SELECT
           (SELECT count(*) FROM events)::int AS total_events,
           (SELECT count(*) FROM events WHERE status = 'OPEN')::int AS open_events,
           (SELECT count(*) FROM cameras)::int AS cameras,
           (SELECT count(*) FROM sites)::int AS sites`,
      )).rows[0];
      return { byType, bySeverity, totals };
    });
    res.json(data);
  }),
);

/** CSV export — tenant scoped. Only the current org's events are exported. */
reportsRouter.get(
  '/export/events.csv',
  requirePermission('reports:read'),
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req, async (db) => {
      const r = await db.query<{
        id: string;
        event_type: string;
        severity: string;
        status: string;
        confidence: number;
        occurred_at: Date;
        camera_name: string;
        site_name: string;
      }>(
        `SELECT e.id, e.event_type, e.severity, e.status, e.confidence, e.occurred_at,
                c.name AS camera_name, s.name AS site_name
         FROM events e JOIN cameras c ON c.id = e.camera_id JOIN sites s ON s.id = e.site_id
         ORDER BY e.occurred_at DESC LIMIT 5000`,
      );
      return r.rows;
    });
    const header = 'id,event_type,severity,status,confidence,occurred_at,camera,site\n';
    const body = rows
      .map((r) =>
        [r.id, r.event_type, r.severity, r.status, r.confidence, r.occurred_at.toISOString(), csv(r.camera_name), csv(r.site_name)].join(','),
      )
      .join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="events.csv"');
    res.send(header + body);
  }),
);

function csv(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
