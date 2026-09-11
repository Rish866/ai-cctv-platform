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
import { encryptSecret, decryptSecret } from '../lib/crypto.js';
import { createStreamSession, verifyStreamToken } from '../services/stream.service.js';
import { cacheInvalidate } from '../services/cache.service.js';
import { testCameraConnection } from '../media/connection.service.js';
import { hlsManager } from '../media/hls.service.js';

export const camerasRouter = Router();
camerasRouter.use(requireAuth, requireOrganizationMembership);

// NOTE: SELECT never includes rtsp credentials — those live encrypted in
// camera_credentials and are never returned to the browser. rtsp_host/path/port
// are non-secret connection metadata; the assembled rtsp:// URL (with password)
// is only ever built inside the trusted media path.
const CAMERA_PUBLIC_COLS =
  'id, organization_id, site_id, zone_id, name, rtsp_host, rtsp_path, rtsp_port, onvif_endpoint, ' +
  'stream_profile, enabled, inference_enabled, inference_fps, resolution, codec, source_fps, ' +
  'reconnect_count, last_connected_at, last_frame_at, last_inference_at, health, downtime_seconds, ' +
  'source_kind, status, last_seen_at, created_at, updated_at';

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
        `INSERT INTO cameras(organization_id, site_id, zone_id, name, rtsp_host, rtsp_path, rtsp_port,
                             onvif_endpoint, stream_profile, enabled, inference_enabled, inference_fps, source_kind)
         VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7,554), $8,
                 COALESCE($9,'main'), COALESCE($10,true), COALESCE($11,false), COALESCE($12,2.0), COALESCE($13,'RTSP'))
         RETURNING ${CAMERA_PUBLIC_COLS}`,
        [
          org, input.siteId, input.zoneId ?? null, input.name, input.rtspHost ?? null, input.rtspPath ?? null,
          input.rtspPort ?? null, input.onvifEndpoint ?? null, input.streamProfile ?? null,
          input.enabled ?? null, input.inferenceEnabled ?? null, input.inferenceFps ?? null, input.sourceKind ?? null,
        ],
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
           rtsp_port = COALESCE($6, rtsp_port),
           stream_profile = COALESCE($7, stream_profile),
           enabled = COALESCE($8, enabled),
           inference_enabled = COALESCE($9, inference_enabled),
           inference_fps = COALESCE($10, inference_fps),
           updated_at = now()
         WHERE id = $1 RETURNING ${CAMERA_PUBLIC_COLS}`,
        [
          req.params.id, input.name ?? null, input.rtspHost ?? null, input.rtspPath ?? null, input.onvifEndpoint ?? null,
          input.rtspPort ?? null, input.streamProfile ?? null, input.enabled ?? null, input.inferenceEnabled ?? null, input.inferenceFps ?? null,
        ],
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

/**
 * REAL camera connection test. Decrypts credentials server-side, probes the
 * RTSP stream with ffprobe, updates camera health, and returns a SAFE
 * diagnostic (never credentials or the raw URL).
 *
 *   POST /api/cameras/:id/test-connection
 *   -> { success, status, latencyMs, message, resolution?, codec?, fps? }
 */
camerasRouter.post(
  '/:id/test-connection',
  requirePermission('cameras:write'),
  asyncHandler(async (req, res) => {
    const org = getCurrentOrganization(req);
    const user = getAuthenticatedUser(req);
    const result = await tenantDb(req, async (db) => {
      // Ownership check (404 if not our org). Then run the real probe.
      await requireTenantResource(db, 'cameras', req.params.id!, 'id');
      return testCameraConnection(db, { organizationId: org, cameraId: req.params.id!, actorUserId: user.id });
    });
    await tenantDb(req, (db) => audit(db, org, { userId: user.id, action: 'camera.test_connection', resource: 'camera', resourceId: req.params.id!, metadata: { status: result.status }, ip: req.ip }));
    res.json(result);
  }),
);

// Backward-compatible alias for the original onboarding "Test" button.
camerasRouter.post(
  '/:id/test',
  requirePermission('cameras:write'),
  asyncHandler(async (req, res) => {
    const org = getCurrentOrganization(req);
    const user = getAuthenticatedUser(req);
    const result = await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'cameras', req.params.id!, 'id');
      return testCameraConnection(db, { organizationId: org, cameraId: req.params.id!, actorUserId: user.id });
    });
    res.json({ reachable: result.success, status: result.success ? 'ONLINE' : result.status, message: result.message });
  }),
);

/** Camera health snapshot + recent health events (tenant scoped). */
camerasRouter.get(
  '/:id/health',
  requirePermission('cameras:read'),
  asyncHandler(async (req, res) => {
    const data = await tenantDb(req, async (db) => {
      const cam = await requireTenantResource<Record<string, unknown>>(
        db,
        'cameras',
        req.params.id!,
        'id, status, health, resolution, codec, source_fps, reconnect_count, last_connected_at, last_frame_at, last_inference_at, downtime_seconds, inference_enabled, inference_fps, enabled',
      );
      const events = (await db.query(
        `SELECT status, health, detail, created_at FROM camera_health_events WHERE camera_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [req.params.id],
      )).rows;
      return { health: cam, recentEvents: events };
    });
    res.json(data);
  }),
);

/**
 * Start (or reuse) a browser-compatible HLS live session for a camera and return
 * a SIGNED manifest URL. Verifies user -> membership -> camera ownership (RLS)
 * before starting the RTSP->HLS transcode. The raw RTSP URL / credentials are
 * decrypted server-side inside the HLS service and NEVER returned to the client.
 *
 *   GET /api/cameras/:id/live
 *   -> { live: { manifestUrl, expiresAt, protocol: 'hls' } }
 */
camerasRouter.get(
  '/:id/live',
  requirePermission('cameras:stream'),
  asyncHandler(async (req, res) => {
    const org = getCurrentOrganization(req);
    const info = await tenantDb(req, async (db) => {
      const cam = await requireTenantResource<{ id: string; site_id: string; rtsp_host: string | null; rtsp_path: string | null; rtsp_port: number; source_kind: string }>(
        db,
        'cameras',
        req.params.id!,
        'id, site_id, rtsp_host, rtsp_path, rtsp_port, source_kind',
      );
      if (!cam.rtsp_host && cam.source_kind !== 'VIDEO_FILE_TEST_SOURCE') {
        return { error: 'Camera has no stream source configured' as const, siteId: cam.site_id };
      }
      // Decrypt credentials server-side ONLY (used by the HLS transcoder).
      const cr = await db.query<{ username_enc: string; password_enc: string }>(
        'SELECT username_enc, password_enc FROM camera_credentials WHERE camera_id = $1',
        [cam.id],
      );
      let username: string | undefined;
      let password: string | undefined;
      if (cr.rows[0]) {
        username = decryptSecret(cr.rows[0].username_enc);
        password = decryptSecret(cr.rows[0].password_enc);
      }
      return { cam, username, password, siteId: cam.site_id };
    });

    if ('error' in info) {
      res.status(400).json({ error: 'BAD_REQUEST', message: info.error });
      return;
    }

    // Ensure the HLS transcode is running (server-side). Never blocks on frames.
    await hlsManager.ensureSession(org, info.cam.id, {
      host: info.cam.rtsp_host ?? '',
      port: info.cam.rtsp_port,
      path: info.cam.rtsp_path,
      username: info.username,
      password: info.password,
    });

    // Sign a short-lived session so segment requests can be authorized.
    const session = createStreamSession({ organizationId: org, cameraId: info.cam.id, siteId: info.siteId });
    const q = new URLSearchParams({ sid: session.sessionId, exp: String(session.expiresAt), sig: session.token });
    res.json({
      live: {
        protocol: 'hls',
        manifestUrl: `/api/cameras/${info.cam.id}/live/index.m3u8?${q.toString()}`,
        expiresAt: session.expiresAt,
      },
    });
  }),
);

/**
 * Serve an HLS artifact (manifest or .ts segment). Authorization chain:
 *   authenticated -> ACTIVE member of camera's org -> camera belongs to org (RLS)
 *   -> valid + unexpired signed session token. Only then is the private segment
 *   returned. A leaked URL cannot be used outside the owning tenant.
 */
camerasRouter.get(
  '/:id/live/:artifact',
  requirePermission('cameras:stream'),
  asyncHandler(async (req, res) => {
    const org = getCurrentOrganization(req);
    const sid = String(req.query.sid ?? '');
    const exp = Number(req.query.exp ?? 0);
    const sig = String(req.query.sig ?? '');

    const siteId = await tenantDb(req, async (db) => {
      const cam = await requireTenantResource<{ id: string; site_id: string }>(db, 'cameras', req.params.id!, 'id, site_id');
      return cam.site_id;
    });
    if (!verifyStreamToken({ organizationId: org, cameraId: req.params.id!, siteId, sessionId: sid, expiresAt: exp, token: sig })) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'Invalid or expired stream token' });
      return;
    }
    try {
      const data = await hlsManager.readArtifact(org, req.params.id!, req.params.artifact!);
      const isManifest = req.params.artifact!.endsWith('.m3u8');
      res.setHeader('Content-Type', isManifest ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(data);
    } catch {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Stream artifact not ready' });
    }
  }),
);

/** Camera inference stats (tenant scoped). */
camerasRouter.get(
  '/:id/stats',
  requirePermission('cameras:read'),
  asyncHandler(async (req, res) => {
    const data = await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'cameras', req.params.id!, 'id');
      const stats = (await db.query('SELECT * FROM inference_stats WHERE camera_id = $1', [req.params.id])).rows[0] ?? null;
      const eventsToday = (await db.query(
        `SELECT count(*)::int AS c FROM events WHERE camera_id = $1 AND occurred_at >= date_trunc('day', now())`,
        [req.params.id],
      )).rows[0];
      return { stats, eventsToday: eventsToday?.c ?? 0 };
    });
    res.json(data);
  }),
);
