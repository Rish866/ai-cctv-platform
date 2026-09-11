import { Router } from 'express';
import { siteSchema, zoneSchema } from '../lib/validation.js';
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
import { audit } from '../services/audit.service.js';
import { cacheInvalidate } from '../services/cache.service.js';

export const sitesRouter = Router();
sitesRouter.use(requireAuth, requireOrganizationMembership);

// ---- Sites ----
sitesRouter.get(
  '/',
  requirePermission('sites:read'),
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req, async (db) => {
      const r = await db.query(
        `SELECT s.*,
                (SELECT count(*) FROM cameras c WHERE c.site_id = s.id) AS camera_count
         FROM sites s ORDER BY s.created_at DESC`,
      );
      return r.rows;
    });
    res.json({ sites: rows });
  }),
);

sitesRouter.get(
  '/:id',
  requirePermission('sites:read'),
  asyncHandler(async (req, res) => {
    const row = await tenantDb(req, (db) => requireTenantResource(db, 'sites', req.params.id!));
    res.json({ site: row });
  }),
);

sitesRouter.post(
  '/',
  requirePermission('sites:write'),
  asyncHandler(async (req, res) => {
    const input = siteSchema.parse(req.body);
    const org = getCurrentOrganization(req);
    const user = getAuthenticatedUser(req);
    const row = await tenantDb(req, async (db) => {
      const r = await db.query(
        `INSERT INTO sites(organization_id, name, address, timezone)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [org, input.name, input.address ?? null, input.timezone],
      );
      await audit(db, org, {
        userId: user.id,
        action: 'site.create',
        resource: 'site',
        resourceId: r.rows[0]!.id as string,
        ip: req.ip,
      });
      return r.rows[0];
    });
    cacheInvalidate(org, 'dashboard_stats');
    res.status(201).json({ site: row });
  }),
);

sitesRouter.patch(
  '/:id',
  requirePermission('sites:write'),
  asyncHandler(async (req, res) => {
    const input = siteSchema.partial().parse(req.body);
    const org = getCurrentOrganization(req);
    const row = await tenantDb(req, async (db) => {
      // Ensures the site is in our org (else 404) before update.
      await requireTenantResource(db, 'sites', req.params.id!);
      const r = await db.query(
        `UPDATE sites SET
           name = COALESCE($2, name),
           address = COALESCE($3, address),
           timezone = COALESCE($4, timezone),
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [req.params.id, input.name ?? null, input.address ?? null, input.timezone ?? null],
      );
      await audit(db, org, { action: 'site.update', resource: 'site', resourceId: req.params.id!, ip: req.ip });
      return r.rows[0];
    });
    res.json({ site: row });
  }),
);

sitesRouter.delete(
  '/:id',
  requirePermission('sites:write'),
  asyncHandler(async (req, res) => {
    const org = getCurrentOrganization(req);
    await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'sites', req.params.id!);
      // FK ON DELETE CASCADE removes this org's zones/cameras/events/evidence for
      // this site only — RLS guarantees the cascade cannot reach another tenant.
      await db.query('DELETE FROM sites WHERE id = $1', [req.params.id]);
      await audit(db, org, { action: 'site.delete', resource: 'site', resourceId: req.params.id!, ip: req.ip });
    });
    cacheInvalidate(org, 'dashboard_stats');
    res.json({ ok: true });
  }),
);

// ---- Zones (nested under sites conceptually; scoped by org via RLS) ----
sitesRouter.get(
  '/:id/zones',
  requirePermission('zones:read'),
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'sites', req.params.id!);
      const r = await db.query('SELECT * FROM zones WHERE site_id = $1 ORDER BY created_at DESC', [req.params.id]);
      return r.rows;
    });
    res.json({ zones: rows });
  }),
);

export const zonesRouter = Router();
zonesRouter.use(requireAuth, requireOrganizationMembership);

zonesRouter.get(
  '/',
  requirePermission('zones:read'),
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req, async (db) => (await db.query('SELECT * FROM zones ORDER BY created_at DESC')).rows);
    res.json({ zones: rows });
  }),
);

zonesRouter.get(
  '/:id',
  requirePermission('zones:read'),
  asyncHandler(async (req, res) => {
    const row = await tenantDb(req, (db) => requireTenantResource(db, 'zones', req.params.id!));
    res.json({ zone: row });
  }),
);

zonesRouter.post(
  '/',
  requirePermission('zones:write'),
  asyncHandler(async (req, res) => {
    const input = zoneSchema.parse(req.body);
    const org = getCurrentOrganization(req);
    const row = await tenantDb(req, async (db) => {
      // Verify the parent site belongs to this org (RLS => 404 otherwise).
      await requireTenantResource(db, 'sites', input.siteId);
      const r = await db.query(
        `INSERT INTO zones(organization_id, site_id, name, geometry)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [org, input.siteId, input.name, JSON.stringify(input.geometry)],
      );
      await audit(db, org, { action: 'zone.create', resource: 'zone', resourceId: r.rows[0]!.id as string, ip: req.ip });
      return r.rows[0];
    });
    res.status(201).json({ zone: row });
  }),
);

zonesRouter.delete(
  '/:id',
  requirePermission('zones:write'),
  asyncHandler(async (req, res) => {
    const org = getCurrentOrganization(req);
    await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'zones', req.params.id!);
      await db.query('DELETE FROM zones WHERE id = $1', [req.params.id]);
      await audit(db, org, { action: 'zone.delete', resource: 'zone', resourceId: req.params.id!, ip: req.ip });
    });
    res.json({ ok: true });
  }),
);
