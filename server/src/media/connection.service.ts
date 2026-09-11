import type { TenantDb } from '../db/pool.js';
import { decryptSecret } from '../lib/crypto.js';
import { probeRtsp, type ProbeResult, type ProbeRunner } from './probe.js';
import { applyHealthUpdate, type CameraStatus } from './health.service.js';

/**
 * Server-side camera connection test. Fetches + decrypts credentials, builds
 * the RTSP target, runs an ffprobe probe, and updates camera status/health.
 * Returns a SAFE diagnostic (never credentials / raw URL). Runs on the
 * tenant-bound db handle so the camera must belong to the caller's org (RLS).
 *
 * `runner` is injectable for tests (so CI need not reach a real camera).
 */
export async function testCameraConnection(
  db: TenantDb,
  params: { organizationId: string; cameraId: string; actorUserId?: string | null },
  runner?: ProbeRunner,
): Promise<ProbeResult> {
  // Load non-secret connection metadata (RLS scopes to org).
  const camRes = await db.query<{
    id: string;
    site_id: string;
    rtsp_host: string | null;
    rtsp_path: string | null;
    rtsp_port: number;
  }>(
    `SELECT id, site_id, rtsp_host, rtsp_path, rtsp_port FROM cameras WHERE id = $1`,
    [params.cameraId],
  );
  const cam = camRes.rows[0];
  if (!cam) {
    // Not visible to this tenant.
    return { success: false, status: 'PROBE_ERROR', latencyMs: 0, message: 'Camera not found' };
  }
  if (!cam.rtsp_host) {
    return { success: false, status: 'INVALID_STREAM', latencyMs: 0, message: 'Camera has no RTSP host configured' };
  }

  // Decrypt credentials server-side ONLY.
  const credRes = await db.query<{ username_enc: string; password_enc: string }>(
    `SELECT username_enc, password_enc FROM camera_credentials WHERE camera_id = $1`,
    [cam.id],
  );
  let username: string | undefined;
  let password: string | undefined;
  if (credRes.rows[0]) {
    username = decryptSecret(credRes.rows[0].username_enc);
    password = decryptSecret(credRes.rows[0].password_enc);
  }

  const result = await probeRtsp(
    { host: cam.rtsp_host, port: cam.rtsp_port, path: cam.rtsp_path, username, password },
    runner,
  );

  // Map probe result -> camera status + health event (deduplicated).
  const status: CameraStatus = result.success
    ? 'ONLINE'
    : result.status === 'AUTH_FAILED'
      ? 'AUTH_FAILED'
      : result.status === 'INVALID_STREAM'
        ? 'INVALID_STREAM'
        : 'OFFLINE';

  await applyHealthUpdate(db, {
    organizationId: params.organizationId,
    cameraId: cam.id,
    siteId: cam.site_id,
    status,
    detail: result.message,
    resolution: result.resolution,
    codec: result.codec,
    sourceFps: result.fps,
    markConnected: result.success,
    actorUserId: params.actorUserId ?? null,
  });

  return result;
}
