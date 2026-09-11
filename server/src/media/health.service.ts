import type { TenantDb } from '../db/pool.js';
import { audit } from '../services/audit.service.js';
import { publishTenantEvent } from '../realtime/hub.js';

/**
 * Camera health service. Records status transitions and emits CAMERA_OFFLINE /
 * CAMERA_RECOVERED events — deduplicated so a flapping/continuously-offline
 * camera does NOT create thousands of duplicate events. All operations run on
 * the tenant-bound `db` handle (RLS enforced); health rows carry organization_id.
 */

export type CameraStatus =
  | 'ONLINE'
  | 'OFFLINE'
  | 'CONNECTING'
  | 'RECONNECTING'
  | 'DEGRADED'
  | 'AUTH_FAILED'
  | 'INVALID_STREAM'
  | 'DISABLED'
  | 'UNKNOWN';

export type CameraHealth = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY' | 'UNKNOWN';

function healthFor(status: CameraStatus): CameraHealth {
  switch (status) {
    case 'ONLINE':
      return 'HEALTHY';
    case 'DEGRADED':
    case 'CONNECTING':
    case 'RECONNECTING':
      return 'DEGRADED';
    case 'OFFLINE':
    case 'AUTH_FAILED':
    case 'INVALID_STREAM':
      return 'UNHEALTHY';
    default:
      return 'UNKNOWN';
  }
}

const OFFLINE_STATUSES = new Set<CameraStatus>(['OFFLINE', 'AUTH_FAILED', 'INVALID_STREAM']);

export interface HealthUpdate {
  organizationId: string;
  cameraId: string;
  siteId: string;
  status: CameraStatus;
  detail?: string;
  resolution?: string;
  codec?: string;
  sourceFps?: number;
  incrementReconnect?: boolean;
  markFrame?: boolean;
  markInference?: boolean;
  markConnected?: boolean;
  actorUserId?: string | null;
}

/**
 * Apply a health update to a camera. Returns whether a health EVENT was emitted
 * (only on OFFLINE<->ONLINE transitions, deduplicated).
 */
export async function applyHealthUpdate(db: TenantDb, u: HealthUpdate): Promise<{ emitted: 'CAMERA_OFFLINE' | 'CAMERA_RECOVERED' | null }> {
  // Read prior status (under RLS — only our org's camera is visible).
  const prior = await db.query<{ status: CameraStatus }>(
    `SELECT status FROM cameras WHERE id = $1`,
    [u.cameraId],
  );
  if (prior.rowCount === 0) {
    // Camera not visible to this tenant => nothing to do (fail closed).
    return { emitted: null };
  }
  const prevStatus = prior.rows[0]!.status;
  const health = healthFor(u.status);

  await db.query(
    `UPDATE cameras SET
       status = $2::camera_status,
       health = $3::camera_health,
       resolution = COALESCE($4, resolution),
       codec = COALESCE($5, codec),
       source_fps = COALESCE($6, source_fps),
       reconnect_count = reconnect_count + CASE WHEN $7 THEN 1 ELSE 0 END,
       last_frame_at = CASE WHEN $8 THEN now() ELSE last_frame_at END,
       last_inference_at = CASE WHEN $9 THEN now() ELSE last_inference_at END,
       last_connected_at = CASE WHEN $10 THEN now() ELSE last_connected_at END,
       last_seen_at = now(),
       updated_at = now()
     WHERE id = $1`,
    [
      u.cameraId,
      u.status,
      health,
      u.resolution ?? null,
      u.codec ?? null,
      u.sourceFps ?? null,
      Boolean(u.incrementReconnect),
      Boolean(u.markFrame),
      Boolean(u.markInference),
      Boolean(u.markConnected),
    ],
  );

  const wasOffline = OFFLINE_STATUSES.has(prevStatus);
  const isOffline = OFFLINE_STATUSES.has(u.status);
  let emitted: 'CAMERA_OFFLINE' | 'CAMERA_RECOVERED' | null = null;

  // Dedup: emit OFFLINE only on the online->offline transition; RECOVERED only
  // on offline->online. Continuous offline/online never re-emits.
  if (!wasOffline && isOffline) emitted = 'CAMERA_OFFLINE';
  else if (wasOffline && u.status === 'ONLINE') emitted = 'CAMERA_RECOVERED';

  if (emitted) {
    await db.query(
      `INSERT INTO camera_health_events(organization_id, camera_id, status, health, detail)
       VALUES ($1,$2,$3::camera_status,$4::camera_health,$5)`,
      [u.organizationId, u.cameraId, u.status, health, u.detail ?? null],
    );
    // Record a system event in the existing events table so it appears in
    // dashboards/reports (tenant scoped).
    await db.query(
      `INSERT INTO events(organization_id, site_id, camera_id, event_type, severity, confidence, status, metadata)
       VALUES ($1,$2,$3,$4::ai_rule_type,$5::event_severity,0,'OPEN',$6)`,
      [
        u.organizationId,
        u.siteId,
        u.cameraId,
        emitted,
        emitted === 'CAMERA_OFFLINE' ? 'HIGH' : 'INFO',
        JSON.stringify({ status: u.status, detail: u.detail ?? null }),
      ],
    );
    await audit(db, u.organizationId, {
      userId: u.actorUserId ?? null,
      action: emitted === 'CAMERA_OFFLINE' ? 'camera.offline' : 'camera.recovered',
      resource: 'camera',
      resourceId: u.cameraId,
      metadata: { status: u.status },
    });
    publishTenantEvent(u.organizationId, {
      type: emitted,
      payload: { cameraId: u.cameraId, status: u.status, health },
    });
  }

  return { emitted };
}

export { healthFor };
