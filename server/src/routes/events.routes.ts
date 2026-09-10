import { Router } from 'express';
import { eventStatusSchema } from '../lib/validation.js';
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
import { buildEvidenceKey, signEvidenceUrl } from '../services/storage.service.js';
import { publishTenantEvent } from '../realtime/hub.js';
import { dispatchNotifications } from '../services/notification.service.js';

export const eventsRouter = Router();
eventsRouter.use(requireAuth, requireOrganizationMembership);

eventsRouter.get(
  '/',
  requirePermission('events:read'),
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const severity = typeof req.query.severity === 'string' ? req.query.severity : null;
    const rows = await tenantDb(req, async (db) => {
      const r = await db.query(
        `SELECT e.*, c.name AS camera_name, s.name AS site_name
         FROM events e
         JOIN cameras c ON c.id = e.camera_id
         JOIN sites s ON s.id = e.site_id
         WHERE ($1::text IS NULL OR e.status = $1::event_status)
           AND ($2::text IS NULL OR e.severity = $2::event_severity)
         ORDER BY e.occurred_at DESC
         LIMIT 200`,
        [status, severity],
      );
      return r.rows;
    });
    res.json({ events: rows });
  }),
);

eventsRouter.get(
  '/:id',
  requirePermission('events:read'),
  asyncHandler(async (req, res) => {
    const data = await tenantDb(req, async (db) => {
      const event = await requireTenantResource(db, 'events', req.params.id!);
      const detections = (await db.query('SELECT * FROM event_detections WHERE event_id = $1', [req.params.id])).rows;
      const evidence = (await db.query('SELECT id, kind, content_type, size_bytes, created_at FROM event_evidence WHERE event_id = $1', [req.params.id])).rows;
      return { event, detections, evidence };
    });
    res.json(data);
  }),
);

/** Update event status (acknowledge/resolve/dismiss). OPERATOR+. */
eventsRouter.patch(
  '/:id/status',
  requirePermission('events:handle'),
  asyncHandler(async (req, res) => {
    const { status } = eventStatusSchema.parse(req.body);
    const org = getCurrentOrganization(req);
    const row = await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'events', req.params.id!);
      const r = await db.query(
        `UPDATE events SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [req.params.id, status],
      );
      await audit(db, org, { action: 'event.status', resource: 'event', resourceId: req.params.id!, metadata: { status }, ip: req.ip });
      return r.rows[0];
    });
    res.json({ event: row });
  }),
);

/**
 * Generate a short-lived signed URL for a piece of evidence. Ownership chain is
 * enforced end-to-end: event belongs to org (RLS) -> evidence belongs to event
 * (RLS + join). Tenant A can never obtain tenant B's evidence URL.
 */
eventsRouter.get(
  '/:id/evidence/:evidenceId/url',
  requirePermission('evidence:read'),
  asyncHandler(async (req, res) => {
    const org = getCurrentOrganization(req);
    const signed = await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'events', req.params.id!);
      const ev = await db.query<{ id: string; storage_key: string }>(
        `SELECT id, storage_key FROM event_evidence WHERE id = $1 AND event_id = $2`,
        [req.params.evidenceId, req.params.id],
      );
      const row = ev.rows[0];
      if (!row) return null;
      return signEvidenceUrl(org, row.storage_key);
    });
    if (!signed) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Evidence not found' });
      return;
    }
    res.json({ evidence: signed });
  }),
);

/**
 * AI event ingestion (represents the Camera -> Media -> AI -> rule-engine
 * pipeline arriving at the API). Tenant context is preserved: the event is
 * written against the caller's org, and the target camera is validated to
 * belong to that org before any event/evidence is created. See also the
 * background-job worker which performs the same validation for queued jobs.
 */
import { ingestEventSchema } from '../lib/validation.js';
import { putObject } from '../services/storage.service.js';

eventsRouter.post(
  '/ingest',
  requirePermission('events:handle'),
  asyncHandler(async (req, res) => {
    const input = ingestEventSchema.parse(req.body);
    const org = getCurrentOrganization(req);
    const user = getAuthenticatedUser(req);
    const created = await tenantDb(req, async (db) => {
      // Validate camera ownership BEFORE creating the event (never trust ids).
      const cam = await requireTenantResource<{ id: string; site_id: string }>(
        db,
        'cameras',
        input.cameraId,
        'id, site_id',
      );
      const severity = input.severity ?? 'MEDIUM';
      const ev = await db.query<{ id: string }>(
        `INSERT INTO events(organization_id, site_id, camera_id, event_type, severity, confidence, correlation_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (organization_id, correlation_id) WHERE correlation_id IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [org, cam.site_id, cam.id, input.eventType, severity, input.confidence, input.correlationId ?? null, JSON.stringify(input.metadata)],
      );
      // If a duplicate correlation_id collided, fetch the existing one.
      let eventId = ev.rows[0]?.id;
      if (!eventId && input.correlationId) {
        const existing = await db.query<{ id: string }>(
          `SELECT id FROM events WHERE correlation_id = $1`,
          [input.correlationId],
        );
        eventId = existing.rows[0]?.id;
      }
      if (!eventId) throw new Error('Failed to create event');

      // Store snapshot evidence in a tenant-scoped, private object path.
      if (input.snapshotBase64) {
        const key = buildEvidenceKey({
          organizationId: org,
          siteId: cam.site_id,
          cameraId: cam.id,
          eventId,
          filename: `snapshot-${Date.now()}.jpg`,
        });
        await putObject(key, Buffer.from(input.snapshotBase64, 'base64'), 'image/jpeg');
        await db.query(
          `INSERT INTO event_evidence(organization_id, event_id, kind, storage_key, content_type)
           VALUES ($1,$2,'SNAPSHOT',$3,'image/jpeg')`,
          [org, eventId, key],
        );
      }
      // Dispatch notifications to THIS org's recipients only (tenant scoped).
      const notified = await dispatchNotifications(db, org, {
        id: eventId,
        severity,
        eventType: input.eventType,
        cameraId: cam.id,
      });
      await audit(db, org, { userId: user.id, action: 'event.ingest', resource: 'event', resourceId: eventId, ip: req.ip });
      return { id: eventId, eventType: input.eventType, severity, cameraId: cam.id, notified };
    });

    // Publish to the tenant's real-time channel ONLY (no global broadcast).
    publishTenantEvent(org, { type: 'event.created', payload: created });
    res.status(201).json({ event: created });
  }),
);
