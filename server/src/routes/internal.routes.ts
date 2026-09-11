import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { asyncHandler } from '../middleware/http.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { withTenant } from '../db/pool.js';
import { requireTenantResource } from '../services/resource.service.js';
import { processDetection } from '../ai/engine.js';
import { applyHealthUpdate, type CameraStatus } from '../media/health.service.js';
import { ALL_AI_TYPES } from '../ai/types.js';
import { evaluateDetection } from '../ai/rule-eval.js';
import { sessionTracker } from '../ai/tracker.js';

/**
 * INTERNAL media-worker API.
 *
 * These endpoints are called ONLY by the trusted media worker (a server-side
 * process), authenticated with a shared MEDIA_WORKER_TOKEN. They are NOT part of
 * the browser-facing surface. Even so, tenant isolation is still enforced by
 * RLS: every job carries organizationId + cameraId, and the handler opens a
 * tenant-scoped transaction (withTenant) and re-validates that the camera
 * belongs to that org before doing anything — a forged job referencing another
 * org's camera finds ZERO rows and is rejected.
 */
export const internalRouter = Router();

// Bearer-token gate. Fails closed if the token is missing/incorrect.
internalRouter.use((req, _res, next) => {
  try {
    const header = req.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    const expected = config.media.workerToken;
    if (!provided || !expected) throw unauthorized('Worker token required');
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw forbidden('Invalid worker token');
    next();
  } catch (err) {
    next(err);
  }
});

const bboxSchema = z.object({
  x: z.number(), y: z.number(), w: z.number(), h: z.number(),
});

const detectionJobSchema = z.object({
  organizationId: z.string().uuid(),
  cameraId: z.string().uuid(),
  // Either a pre-mapped eventType (legacy/direct) ...
  eventType: z.enum(ALL_AI_TYPES).optional(),
  // ... or a raw detection class + bbox to be rule-evaluated.
  rawClass: z.enum(['PERSON', 'VEHICLE', 'FIRE', 'SMOKE']).optional(),
  bbox: bboxSchema.optional(),
  trackId: z.string().max(80).optional(),
  dwellMs: z.number().int().min(0).optional(),
  confidence: z.number().min(0).max(1),
  severity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  durationMs: z.number().int().min(0).max(600000).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  snapshotBase64: z.string().optional(),
});

/**
 * Submit a detection produced by the worker/inference pipeline.
 *
 * Two modes:
 *   * `eventType` given  -> raised directly (still tenant/camera validated).
 *   * `rawClass` + bbox  -> run through the rule engine (zone polygon, schedule,
 *     dwell) to derive the correct security/safety event type(s).
 *
 * All resulting events flow through the EXISTING processDetection engine
 * (cooldown, FIRE+SMOKE correlation, evidence, notify, WebSocket, audit) under
 * the job's tenant context. Camera ownership is re-validated under RLS.
 */
internalRouter.post(
  '/detections',
  asyncHandler(async (req, res) => {
    const job = detectionJobSchema.parse(req.body);
    const snapshot = job.snapshotBase64 ? Buffer.from(job.snapshotBase64, 'base64') : undefined;

    const results = await withTenant(
      { userId: '', organizationId: job.organizationId, role: 'OPERATOR', isPlatformAdmin: false },
      async (db) => {
        // Validate camera belongs to job org (RLS => not found otherwise).
        const cam = await requireTenantResource<{ id: string; site_id: string }>(
          db,
          'cameras',
          job.cameraId,
          'id, site_id',
        );

        // Determine the event types to raise.
        let eventTypes: Array<{ eventType: string; confidence: number; metadata: Record<string, unknown> }> = [];
        if (job.rawClass && job.bbox) {
          // Update the session tracker to compute dwell time for loitering-style
          // rules (ephemeral trackId, per {org,camera}, no biometrics).
          const tracked = sessionTracker.update(job.organizationId, cam.id, [
            { label: job.rawClass, bbox: job.bbox },
          ]);
          const dwellMs = job.dwellMs ?? tracked[0]?.dwellMs ?? 0;
          const evaluated = await evaluateDetection(db, cam.id, {
            rawClass: job.rawClass,
            confidence: job.confidence,
            bbox: job.bbox,
            dwellMs,
          });
          eventTypes = evaluated.map((e) => ({ eventType: e.eventType, confidence: e.confidence, metadata: e.metadata }));
        } else if (job.eventType) {
          eventTypes = [{ eventType: job.eventType, confidence: job.confidence, metadata: {} }];
        }

        const out = [];
        for (const et of eventTypes) {
          out.push(
            await processDetection(db, {
              organizationId: job.organizationId,
              cameraId: cam.id,
              siteId: cam.site_id,
              eventType: et.eventType,
              confidence: et.confidence,
              severity: job.severity,
              durationMs: job.durationMs,
              metadata: { ...job.metadata, ...et.metadata, source: 'media-worker', trackId: job.trackId },
              snapshot,
            }),
          );
        }
        return out;
      },
    );

    const created = results.some((r) => r.created);
    res.status(created ? 201 : 200).json({ events: results });
  }),
);

const healthJobSchema = z.object({
  organizationId: z.string().uuid(),
  cameraId: z.string().uuid(),
  status: z.enum([
    'ONLINE', 'OFFLINE', 'CONNECTING', 'RECONNECTING', 'DEGRADED', 'AUTH_FAILED', 'INVALID_STREAM', 'DISABLED', 'UNKNOWN',
  ]),
  detail: z.string().max(500).optional(),
  resolution: z.string().max(32).optional(),
  codec: z.string().max(32).optional(),
  sourceFps: z.number().optional(),
  incrementReconnect: z.boolean().optional(),
  markFrame: z.boolean().optional(),
  markInference: z.boolean().optional(),
  markConnected: z.boolean().optional(),
});

/** Report camera health/telemetry from the worker (tenant scoped, RLS enforced). */
internalRouter.post(
  '/camera-health',
  asyncHandler(async (req, res) => {
    const job = healthJobSchema.parse(req.body);
    const result = await withTenant(
      { userId: '', organizationId: job.organizationId, role: 'OPERATOR', isPlatformAdmin: false },
      async (db) => {
        const cam = await requireTenantResource<{ id: string; site_id: string }>(db, 'cameras', job.cameraId, 'id, site_id');
        return applyHealthUpdate(db, {
          organizationId: job.organizationId,
          cameraId: cam.id,
          siteId: cam.site_id,
          status: job.status as CameraStatus,
          detail: job.detail,
          resolution: job.resolution,
          codec: job.codec,
          sourceFps: job.sourceFps,
          incrementReconnect: job.incrementReconnect,
          markFrame: job.markFrame,
          markInference: job.markInference,
          markConnected: job.markConnected,
        });
      },
    );
    res.json({ ok: true, emitted: result.emitted });
  }),
);

/** Update rolling inference stats (tenant scoped). */
const statsJobSchema = z.object({
  organizationId: z.string().uuid(),
  cameraId: z.string().uuid(),
  framesProcessed: z.number().int().min(0).default(0),
  detections: z.number().int().min(0).default(0),
  inferenceFailures: z.number().int().min(0).default(0),
  avgLatencyMs: z.number().min(0).default(0),
  model: z.string().max(64).optional(),
  modelVersion: z.string().max(64).optional(),
});

internalRouter.post(
  '/inference-stats',
  asyncHandler(async (req, res) => {
    const job = statsJobSchema.parse(req.body);
    await withTenant(
      { userId: '', organizationId: job.organizationId, role: 'OPERATOR', isPlatformAdmin: false },
      async (db) => {
        await requireTenantResource(db, 'cameras', job.cameraId, 'id');
        await db.query(
          `INSERT INTO inference_stats(organization_id, camera_id, frames_processed, detections_total, inference_failures, avg_latency_ms, last_model, last_model_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (camera_id) DO UPDATE SET
             frames_processed = inference_stats.frames_processed + EXCLUDED.frames_processed,
             detections_total = inference_stats.detections_total + EXCLUDED.detections_total,
             inference_failures = inference_stats.inference_failures + EXCLUDED.inference_failures,
             avg_latency_ms = EXCLUDED.avg_latency_ms,
             last_model = COALESCE(EXCLUDED.last_model, inference_stats.last_model),
             last_model_version = COALESCE(EXCLUDED.last_model_version, inference_stats.last_model_version),
             updated_at = now()`,
          [job.organizationId, job.cameraId, job.framesProcessed, job.detections, job.inferenceFailures, job.avgLatencyMs, job.model ?? null, job.modelVersion ?? null],
        );
      },
    );
    res.json({ ok: true });
  }),
);
