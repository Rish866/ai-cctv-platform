import type { TenantDb } from '../db/pool.js';
import { buildEvidenceKey, putObject } from '../services/storage.service.js';
import { dispatchNotifications } from '../services/notification.service.js';
import { audit } from '../services/audit.service.js';
import { publishTenantEvent } from '../realtime/hub.js';
import { DEFAULT_SEVERITY, isFireType, type EventSeverity } from './types.js';

/**
 * SAFETY & SECURITY DETECTION ENGINE
 * ==================================
 * A single entry point — `processDetection` — that turns a validated detection
 * into (or updates) an incident, reusing the EXISTING event pipeline:
 *
 *   camera (validated under RLS by caller)
 *     -> cooldown/dedup (per tenant, durable in alert_cooldowns)
 *     -> event create/update (events table, existing schema)
 *     -> fire+smoke correlation (upgrade to FIRE_AND_SMOKE)
 *     -> evidence (existing tenant-isolated storage + signed URLs)
 *     -> notification (existing dispatchNotifications — tenant recipients only)
 *     -> WebSocket publish (existing per-org channel)
 *     -> audit (existing audit system)
 *
 * Every DB operation runs on the tenant-bound `db` handle the caller passes, so
 * RLS is enforced. The caller (route/worker) MUST have already validated that
 * the camera belongs to the org (as the existing pipeline does).
 */

export interface DetectionSignal {
  organizationId: string;
  cameraId: string;
  siteId: string;
  zoneId?: string | null;
  eventType: string; // one of ai_rule_type (incl. new safety/security values)
  confidence: number;
  severity?: EventSeverity;
  /** ms the condition has been observed (for min-duration false-positive control). */
  durationMs?: number;
  aiRuleId?: string | null;
  metadata?: Record<string, unknown>;
  snapshot?: Buffer;
  actorUserId?: string | null;
  ip?: string | null;
}

export interface DetectionResult {
  eventId: string;
  eventType: string;
  severity: EventSeverity;
  cameraId: string;
  /** true when a NEW incident was created; false when an existing one was updated. */
  created: boolean;
  /** true when a notification alert was (re)sent this call. */
  alerted: boolean;
  notified: number;
  /** true when correlation upgraded the incident to FIRE_AND_SMOKE. */
  upgradedToFireAndSmoke: boolean;
}

const FIRE_SMOKE_CORRELATION_WINDOW_MS = 60_000;

function cooldownKey(cameraId: string, eventType: string): string {
  // Fire and smoke share a cooldown key so they group into one incident and can
  // be correlated/upgraded rather than spawning parallel storms.
  const bucket = isFireType(eventType) ? 'FIRE_SAFETY' : eventType;
  return `${cameraId}:${bucket}`;
}

/**
 * Look up the applicable ai_rule (if any) to source cooldown / severity /
 * channels / min-duration. All under RLS (tenant scoped).
 */
async function findRule(
  db: TenantDb,
  cameraId: string,
  eventType: string,
): Promise<{
  id: string;
  cooldown_seconds: number;
  min_duration_ms: number;
  severity: EventSeverity;
  min_confidence: number;
  enabled: boolean;
} | null> {
  const r = await db.query<{
    id: string;
    cooldown_seconds: number;
    min_duration_ms: number;
    severity: EventSeverity;
    min_confidence: number;
    enabled: boolean;
  }>(
    `SELECT id, cooldown_seconds, min_duration_ms, severity, min_confidence, enabled
     FROM ai_rules
     WHERE camera_id = $1 AND rule_type = $2::ai_rule_type
     ORDER BY updated_at DESC LIMIT 1`,
    [cameraId, eventType],
  );
  return r.rows[0] ?? null;
}

export async function processDetection(
  db: TenantDb,
  signal: DetectionSignal,
): Promise<DetectionResult> {
  const org = signal.organizationId;
  const rule = await findRule(db, signal.cameraId, signal.eventType);

  // Rule may disable the detection entirely.
  if (rule && !rule.enabled) {
    throw new Error('Detection rule is disabled for this camera/type');
  }

  // False-positive control: confidence threshold + minimum observed duration.
  const minConfidence = rule?.min_confidence ?? 0;
  if (signal.confidence < minConfidence) {
    return noResult(signal);
  }
  if (rule && rule.min_duration_ms > 0 && (signal.durationMs ?? 0) < rule.min_duration_ms) {
    return noResult(signal);
  }

  const severity: EventSeverity =
    signal.severity ?? rule?.severity ?? DEFAULT_SEVERITY[signal.eventType] ?? 'MEDIUM';
  const cooldownSeconds = rule?.cooldown_seconds ?? 30;
  const key = cooldownKey(signal.cameraId, signal.eventType);

  // --- Cooldown / dedup (durable, tenant-scoped via RLS on alert_cooldowns) ---
  const existing = await db.query<{ id: string; event_id: string | null; expires_at: Date }>(
    `SELECT id, event_id, expires_at FROM alert_cooldowns WHERE cooldown_key = $1`,
    [key],
  );
  const now = Date.now();
  const cd = existing.rows[0];
  const withinCooldown = cd ? cd.expires_at.getTime() > now : false;

  let eventId: string;
  let created = false;
  let upgradedToFireAndSmoke = false;

  if (withinCooldown && cd?.event_id) {
    // Update the existing incident instead of creating a new one.
    eventId = cd.event_id;

    // Fire+smoke correlation: if this signal is fire/smoke and the active
    // incident is the complementary type within the window, upgrade to
    // FIRE_AND_SMOKE (CRITICAL) — but never create duplicate incidents.
    if (isFireType(signal.eventType)) {
      const cur = await db.query<{ event_type: string; occurred_at: Date }>(
        `SELECT event_type, occurred_at FROM events WHERE id = $1`,
        [eventId],
      );
      const row = cur.rows[0];
      if (row) {
        const complementary =
          (row.event_type === 'FIRE' && signal.eventType === 'SMOKE') ||
          (row.event_type === 'SMOKE' && signal.eventType === 'FIRE');
        const recent = now - row.occurred_at.getTime() <= FIRE_SMOKE_CORRELATION_WINDOW_MS;
        if (complementary && recent && row.event_type !== 'FIRE_AND_SMOKE') {
          await db.query(
            `UPDATE events SET event_type = 'FIRE_AND_SMOKE', severity = 'CRITICAL',
               confidence = GREATEST(confidence, $2), updated_at = now()
             WHERE id = $1`,
            [eventId, signal.confidence],
          );
          upgradedToFireAndSmoke = true;
        }
      }
    }

    // Refresh evidence/metadata on the incident (add another snapshot).
    await maybeAttachEvidence(db, org, signal, eventId);
    await db.query(`UPDATE events SET updated_at = now() WHERE id = $1`, [eventId]);
  } else {
    // Create a NEW incident (first detection, or after cooldown expiry).
    const ins = await db.query<{ id: string }>(
      `INSERT INTO events(organization_id, site_id, camera_id, ai_rule_id, event_type, severity, confidence, metadata)
       VALUES ($1,$2,$3,$4,$5::ai_rule_type,$6::event_severity,$7,$8)
       RETURNING id`,
      [
        org,
        signal.siteId,
        signal.cameraId,
        signal.aiRuleId ?? rule?.id ?? null,
        signal.eventType,
        severity,
        signal.confidence,
        JSON.stringify(signal.metadata ?? {}),
      ],
    );
    eventId = ins.rows[0]!.id;
    created = true;
    await maybeAttachEvidence(db, org, signal, eventId);
  }

  // --- Upsert the cooldown window (tenant scoped) ---
  const expiresAt = new Date(now + cooldownSeconds * 1000);
  await db.query(
    `INSERT INTO alert_cooldowns(organization_id, cooldown_key, event_id, last_alert_at, expires_at)
     VALUES ($1,$2,$3, now(), $4)
     ON CONFLICT (organization_id, cooldown_key) DO UPDATE
       SET event_id = EXCLUDED.event_id,
           last_alert_at = CASE WHEN alert_cooldowns.expires_at <= now() THEN now() ELSE alert_cooldowns.last_alert_at END,
           expires_at = EXCLUDED.expires_at,
           updated_at = now()`,
    [org, key, eventId, expiresAt],
  );

  // --- Alert only on new incident (or correlation upgrade) — NOT every frame ---
  const alerted = created || upgradedToFireAndSmoke;
  let notified = 0;
  if (alerted) {
    notified = await dispatchNotifications(db, org, {
      id: eventId,
      severity: upgradedToFireAndSmoke ? 'CRITICAL' : severity,
      eventType: upgradedToFireAndSmoke ? 'FIRE_AND_SMOKE' : signal.eventType,
      cameraId: signal.cameraId,
    });
    await audit(db, org, {
      userId: signal.actorUserId ?? null,
      action: created ? 'incident.create' : 'incident.upgrade',
      resource: 'event',
      resourceId: eventId,
      metadata: { eventType: signal.eventType, severity, upgradedToFireAndSmoke },
      ip: signal.ip ?? null,
    });
  }

  const finalType = upgradedToFireAndSmoke ? 'FIRE_AND_SMOKE' : signal.eventType;
  const finalSeverity: EventSeverity = upgradedToFireAndSmoke ? 'CRITICAL' : severity;

  // --- Real-time publish to THIS org's channel only ---
  if (alerted) {
    publishTenantEvent(org, {
      type: realtimeTypeFor(finalType),
      payload: { id: eventId, eventType: finalType, severity: finalSeverity, cameraId: signal.cameraId },
    });
  }

  return {
    eventId,
    eventType: finalType,
    severity: finalSeverity,
    cameraId: signal.cameraId,
    created,
    alerted,
    notified,
    upgradedToFireAndSmoke,
  };
}

async function maybeAttachEvidence(
  db: TenantDb,
  org: string,
  signal: DetectionSignal,
  eventId: string,
): Promise<void> {
  if (!signal.snapshot) return;
  const key = buildEvidenceKey({
    organizationId: org,
    siteId: signal.siteId,
    cameraId: signal.cameraId,
    eventId,
    filename: `${signal.eventType.toLowerCase()}-${Date.now()}.jpg`,
  });
  await putObject(key, signal.snapshot, 'image/jpeg');
  await db.query(
    `INSERT INTO event_evidence(organization_id, event_id, kind, storage_key, content_type)
     VALUES ($1,$2,'SNAPSHOT',$3,'image/jpeg')`,
    [org, eventId, key],
  );
}

function noResult(signal: DetectionSignal): DetectionResult {
  return {
    eventId: '',
    eventType: signal.eventType,
    severity: signal.severity ?? 'MEDIUM',
    cameraId: signal.cameraId,
    created: false,
    alerted: false,
    notified: 0,
    upgradedToFireAndSmoke: false,
  };
}

/** Map an event type to its real-time WebSocket message type. */
export function realtimeTypeFor(eventType: string): string {
  switch (eventType) {
    case 'FIRE':
      return 'FIRE_DETECTED';
    case 'SMOKE':
      return 'SMOKE_DETECTED';
    case 'FIRE_AND_SMOKE':
      return 'FIRE_SMOKE_CRITICAL';
    case 'UNAUTHORIZED_ENTRY':
      return 'UNAUTHORIZED_ENTRY';
    case 'AFTER_HOURS_ACTIVITY':
      return 'AFTER_HOURS_ACTIVITY';
    case 'OBJECT_REMOVED':
      return 'OBJECT_REMOVED';
    case 'UNAUTHORIZED_VEHICLE':
      return 'UNAUTHORIZED_VEHICLE';
    case 'RESTRICTED_ZONE_ACTIVITY':
      return 'RESTRICTED_ZONE_ACTIVITY';
    case 'LOITERING_SECURITY':
      return 'RESTRICTED_ZONE_ACTIVITY';
    default:
      return 'event.created';
  }
}
