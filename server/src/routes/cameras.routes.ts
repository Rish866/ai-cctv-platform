import { Router } from 'express';
import { cameraSchema, cameraUpdateSchema } from '../lib/validation.js';
import { badRequest, forbidden } from '../lib/errors.js';
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
import { encryptSecret } from '../lib/crypto.js';
import { createStreamSession } from '../services/stream.service.js';
import { cacheInvalidate } from '../services/cache.service.js';

export const camerasRouter = Router();
camerasRouter.use(requireAuth, requireOrganizationMembership);

// NOTE: SELECT never includes rtsp credentials — those live encrypted in
// camera_credentials and are never returned to the browser.
const CAMERA_PUBLIC_COLS =
  'id, organization_id, site_id, zone_id, name, rtsp_host, rtsp_path, onvif_endpoint, status, last_seen_at, created_at, updated_at';

camerasRouter.get(
  '/',
  requirePermission('cameras:read'),
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req, async (db) =>
      (await db.query(`SELECT ${CAMERA_PUBLIC_COLS} FROM cameras ORDER BY created_at DESC`)).rows,
    );
    res.json({ cameras: rows });
  }),
);

camerasRouter.get(
  '/:id',
  requirePermission('cameras:read'),
  asyncHandler(async (req, res) => {
    const row = await tenantDb(req, (db) =>
      requireTenantResource(db, 'cameras', req.params.id!, CAMERA_PUBLIC_COLS),
    );
    res.json({ camera: row });
  }),
);

camerasRouter.post(
  '/',
  requirePermission('cameras:write'),
  asyncHandler(async (req, res) => {
    const input = cameraSchema.parse(req.body);
    const org = getCurrentOrganization(req);
    const user = getAuthenticatedUser(req);
    const row = await tenantDb(req, async (db) => {
      // Parent site must belong to this org.
      await requireTenantResource(db, 'sites', input.siteId);
      if (input.zoneId) await requireTenantResource(db, 'zones', input.zoneId);

      // Enforce subscription camera limit (billing-scoped, tenant only).
      const limitRes = await db.query<{ camera_limit: number; used: number }>(
        `SELECT s.camera_limit, (SELECT count(*) FROM cameras) AS used
         FROM subscriptions s LIMIT 1`,
      );
      const lim = limitRes.rows[0];
      if (lim && Number(lim.used) >= Number(lim.camera_limit)) {
        throw forbidden(`Camera limit reached for your plan (${lim.camera_limit}). Upgrade to add more.`);
      }

      const r = await db.query(
        `INSERT INTO cameras(organization_id, site_id, zone_id, name, rtsp_host, rtsp_path, onvif_endpoint)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${CAMERA_PUBLIC_COLS}`,
        [org, input.siteId, input.zoneId ?? null, input.name, input.rtspHost ?? null, input.rtspPath ?? null, input.onvifEndpoint ?? null],
      );
      const cameraId = r.rows[0]!.id as string;

      // Encrypt + store credentials if provided. Never store plaintext.
      if (input.username || input.password) {
        await db.query(
          `INSERT INTO camera_credentials(organization_id, camera_id, username_enc, password_enc)
           VALUES ($1,$2,$3,$4)`,
          [org, cameraId, encryptSecret(input.username ?? ''), encryptSecret(input.password ?? '')],
        );
      }
      await audit(db, org, { userId: user.id, action: 'camera.create', resource: 'camera', resourceId: cameraId, ip: req.ip });
      return r.rows[0];
    });
    cacheInvalidate(org, 'dashboard_stats');
    res.status(201).json({ camera: row });
  }),
);

camerasRouter.patch(
  '/:id',
  requirePermission('cameras:write'),
  asyncHandler(async (req, res) => {
    const input = cameraUpdateSchema.parse(req.body);
    const org = getCurrentOrganization(req);
    const row = await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'cameras', req.params.id!);
      const r = await db.query(
        `UPDATE cameras SET
           name = COALESCE($2, name),
           rtsp_host = COALESCE($3, rtsp_host),
           rtsp_path = COALESCE($4, rtsp_path),
           onvif_endpoint = COALESCE($5, onvif_endpoint),
           updated_at = now()
         WHERE id = $1 RETURNING ${CAMERA_PUBLIC_COLS}`,
        [req.params.id, input.name ?? null, input.rtspHost ?? null, input.rtspPath ?? null, input.onvifEndpoint ?? null],
      );
      if (input.username !== undefined || input.password !== undefined) {
        await db.query(
          `INSERT INTO camera_credentials(organization_id, camera_id, username_enc, password_enc)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (camera_id) DO UPDATE SET
             username_enc = EXCLUDED.username_enc,
             password_enc = EXCLUDED.password_enc,
             updated_at = now()`,
          [org, req.params.id, encryptSecret(input.username ?? ''), encryptSecret(input.password ?? '')],
        );
      }
      await audit(db, org, { action: 'camera.update', resource: 'camera', resourceId: req.params.id!, ip: req.ip });
      return r.rows[0];
    });
    res.json({ camera: row });
  }),
);

camerasRouter.delete(
  '/:id',
  requirePermission('cameras:write'),
  asyncHandler(async (req, res) => {
    const org = getCurrentOrganization(req);
    await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'cameras', req.params.id!);
      await db.query('DELETE FROM cameras WHERE id = $1', [req.params.id]);
      await audit(db, org, { action: 'camera.delete', resource: 'camera', resourceId: req.params.id!, ip: req.ip });
    });
    cacheInvalidate(org, 'dashboard_stats');
    res.json({ ok: true });
  }),
);

/**
 * Create an authenticated stream session. Validates user -> membership ->
 * camera ownership (RLS 404 otherwise) before minting a short-lived session
 * token. Raw RTSP URLs / credentials are NEVER exposed to the client.
 */
camerasRouter.post(
  '/:id/stream',
  requirePermission('cameras:stream'),
  asyncHandler(async (req, res) => {
    const org = getCurrentOrganization(req);
    const session = await tenantDb(req, async (db) => {
      const cam = await requireTenantResource<{ id: string; site_id: string; name: string }>(
        db,
        'cameras',
        req.params.id!,
        'id, site_id, name',
      );
      return createStreamSession({ organizationId: org, cameraId: cam.id, siteId: cam.site_id });
    });
    res.json({ stream: session });
  }),
);

/** "Test camera" during onboarding — validates ownership + reports reachability. */
camerasRouter.post(
  '/:id/test',
  requirePermission('cameras:write'),
  asyncHandler(async (req, res) => {
    const result = await tenantDb(req, async (db) => {
      const cam = await requireTenantResource<{ id: string; rtsp_host: string | null }>(
        db,
        'cameras',
        req.params.id!,
        'id, rtsp_host',
      );
      const hasCreds = (await db.query('SELECT 1 FROM camera_credentials WHERE camera_id = $1', [cam.id])).rowCount ?? 0;
      // Simulated reachability check (no real network egress to customer cameras
      // from this environment). Reports whether config is complete.
      const configured = Boolean(cam.rtsp_host) && hasCreds > 0;
      await db.query(`UPDATE cameras SET status = $2, last_seen_at = now() WHERE id = $1`, [
        cam.id,
        configured ? 'ONLINE' : 'DEGRADED',
      ]);
      return { reachable: configured, status: configured ? 'ONLINE' : 'DEGRADED' };
    });
    res.json(result);
  }),
);
