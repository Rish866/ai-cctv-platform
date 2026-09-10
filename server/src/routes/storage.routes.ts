import { Router } from 'express';
import { asyncHandler } from '../middleware/http.js';
import { requireAuth } from '../middleware/context.js';
import { getMembership } from '../services/membership.service.js';
import {
  getObject,
  keyBelongsToOrg,
  objectExists,
  verifyEvidenceUrl,
} from '../services/storage.service.js';
import { verifyStreamToken } from '../services/stream.service.js';

/**
 * Signed-object endpoint. A signed evidence URL is only honored when:
 *   1. the caller is authenticated,
 *   2. the signature (org + key + expiry) is valid and unexpired,
 *   3. the caller is an ACTIVE member of the organization the key belongs to.
 * So even a leaked URL cannot be used by someone outside the owning tenant.
 */
export const storageRouter = Router();

storageRouter.get(
  '/object',
  requireAuth,
  asyncHandler(async (req, res) => {
    const key = String(req.query.key ?? '');
    const org = String(req.query.org ?? '');
    const exp = Number(req.query.exp ?? 0);
    const sig = String(req.query.sig ?? '');

    if (!key || !org || !exp || !sig) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'Missing signed URL params' });
      return;
    }
    // Signature must be valid AND key must belong to the claimed org.
    if (!verifyEvidenceUrl({ organizationId: org, storageKey: key, expiresAt: exp, token: sig })) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'Invalid or expired URL' });
      return;
    }
    if (!keyBelongsToOrg(key, org)) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'Key/org mismatch' });
      return;
    }
    // The authenticated caller must actually be a member of that org.
    const membership = await getMembership(req.ctx!.user.id, org);
    if (!membership || membership.status !== 'ACTIVE') {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Not found' });
      return;
    }
    if (!(await objectExists(key))) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Object not found' });
      return;
    }
    const data = await getObject(key);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(data);
  }),
);

/**
 * Stream playback endpoint — validates the signed stream token AND that the
 * caller is a member of the token's org before returning session info. A media
 * gateway would hand back an HLS manifest / WebRTC offer here.
 */
export const streamsRouter = Router();

streamsRouter.get(
  '/playback',
  requireAuth,
  asyncHandler(async (req, res) => {
    const cam = String(req.query.cam ?? '');
    const org = String(req.query.org ?? '');
    const sid = String(req.query.sid ?? '');
    const exp = Number(req.query.exp ?? 0);
    const sig = String(req.query.sig ?? '');

    // Token carries siteId implicitly via signature; we re-derive from camera.
    const membership = await getMembership(req.ctx!.user.id, org);
    if (!membership || membership.status !== 'ACTIVE') {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Not found' });
      return;
    }
    // We must know the camera's site to verify the token; do it under RLS.
    const { tenantDb } = await import('../middleware/context.js');
    // Temporarily bind membership so tenantDb has an org context.
    req.ctx!.membership = membership;
    const siteId = await tenantDb(req, async (db) => {
      const r = await db.query<{ site_id: string }>('SELECT site_id FROM cameras WHERE id = $1', [cam]);
      return r.rows[0]?.site_id ?? null;
    });
    if (!siteId) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Camera not found' });
      return;
    }
    if (!verifyStreamToken({ organizationId: org, cameraId: cam, siteId, sessionId: sid, expiresAt: exp, token: sig })) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'Invalid or expired stream token' });
      return;
    }
    res.json({
      // A real gateway returns an HLS/WebRTC descriptor. Credentials stay server-side.
      protocol: 'hls',
      manifest: `#EXTM3U\n#EXT-X-VERSION:3\n# session ${sid} for camera ${cam}\n`,
      expiresAt: exp,
    });
  }),
);
