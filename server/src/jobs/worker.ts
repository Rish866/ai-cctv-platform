import { withTenant } from '../db/pool.js';
import { buildEvidenceKey, putObject } from '../services/storage.service.js';
import { dispatchNotifications } from '../services/notification.service.js';
import { publishTenantEvent } from '../realtime/hub.js';
import { notFound } from '../lib/errors.js';
import type { AiEventType, EventSeverity } from '../ai/types.js';
import { isSafetySecurityType } from '../ai/types.js';
import { processDetection } from '../ai/engine.js';

/**
 * Background job payload for the AI pipeline. Every job MUST carry full tenant
 * context. The worker NEVER trusts the ids blindly: it opens a tenant-scoped
 * (RLS) transaction for the job's organization and re-validates that the target
 * camera actually belongs to that org before creating anything. If the camera
 * is not visible under that org's RLS context, the job is rejected.
 */
export interface AiJob {
  organizationId: string;
  cameraId: string;
  // Accepts all AI event types, incl. the safety/security add-on values.
  eventType: AiEventType;
  confidence: number;
  severity?: EventSeverity;
  correlationId?: string;
  durationMs?: number;
  snapshot?: Buffer;
  metadata?: Record<string, unknown>;
}

export interface JobResult {
  eventId: string;
  organizationId: string;
  cameraId: string;
  notified: number;
}

/**
 * Process an AI job. The tenant context is taken from the JOB, but enforced by
 * RLS: withTenant sets app.current_org to job.organizationId, and the
 * camera-ownership lookup runs under that context. A forged job that references
 * another tenant's camera id will find ZERO rows (RLS) and be rejected.
 */
export async function processAiJob(job: AiJob): Promise<JobResult> {
  return withTenant(
    { userId: '', organizationId: job.organizationId, role: 'OPERATOR', isPlatformAdmin: false },
    async (db) => {
      // Validate relationship: camera must belong to job.organizationId.
      const cam = await db.query<{ id: string; site_id: string }>(
        'SELECT id, site_id FROM cameras WHERE id = $1',
        [job.cameraId],
      );
      const camera = cam.rows[0];
      if (!camera) {
        // Camera not visible under this org's RLS => cross-tenant / invalid job.
        throw notFound('Job references a camera not owned by its organization');
      }

      // Safety & Security jobs use the detection engine (cooldown/correlation),
      // still fully tenant-validated (camera confirmed above under RLS).
      if (isSafetySecurityType(job.eventType)) {
        const result = await processDetection(db, {
          organizationId: job.organizationId,
          cameraId: camera.id,
          siteId: camera.site_id,
          eventType: job.eventType,
          confidence: job.confidence,
          severity: job.severity,
          durationMs: job.durationMs,
          metadata: job.metadata,
          snapshot: job.snapshot,
        });
        return { eventId: result.eventId, organizationId: job.organizationId, cameraId: camera.id, notified: result.notified };
      }

      const severity = job.severity ?? 'MEDIUM';
      const ins = await db.query<{ id: string }>(
        `INSERT INTO events(organization_id, site_id, camera_id, event_type, severity, confidence, correlation_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (organization_id, correlation_id) WHERE correlation_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          job.organizationId,
          camera.site_id,
          camera.id,
          job.eventType,
          severity,
          job.confidence,
          job.correlationId ?? null,
          JSON.stringify(job.metadata ?? {}),
        ],
      );
      let eventId = ins.rows[0]?.id;
      if (!eventId && job.correlationId) {
        eventId = (await db.query<{ id: string }>('SELECT id FROM events WHERE correlation_id = $1', [job.correlationId])).rows[0]?.id;
      }
      if (!eventId) throw new Error('Failed to create event from job');

      if (job.snapshot) {
        const key = buildEvidenceKey({
          organizationId: job.organizationId,
          siteId: camera.site_id,
          cameraId: camera.id,
          eventId,
          filename: `job-snapshot-${Date.now()}.jpg`,
        });
        await putObject(key, job.snapshot, 'image/jpeg');
        await db.query(
          `INSERT INTO event_evidence(organization_id, event_id, kind, storage_key, content_type)
           VALUES ($1,$2,'SNAPSHOT',$3,'image/jpeg')`,
          [job.organizationId, eventId, key],
        );
      }

      const notified = await dispatchNotifications(db, job.organizationId, {
        id: eventId,
        severity,
        eventType: job.eventType,
        cameraId: camera.id,
      });

      publishTenantEvent(job.organizationId, {
        type: 'event.created',
        payload: { id: eventId, eventType: job.eventType, severity, cameraId: camera.id },
      });

      return { eventId, organizationId: job.organizationId, cameraId: camera.id, notified };
    },
  );
}
