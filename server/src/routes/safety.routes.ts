import { Router } from 'express';
import { aiModelSchema, monitoredObjectSchema, zoneScheduleSchema } from '../lib/validation.js';
import { asyncHandler } from '../middleware/http.js';
import {
  getCurrentOrganization,
  requireAuth,
  requireOrganizationMembership,
  requirePermission,
  tenantDb,
} from '../middleware/context.js';
import { requireTenantResource } from '../services/resource.service.js';
import { audit } from '../services/audit.service.js';

/**
 * Safety & Security configuration routes. Every handler enforces
 * authentication + org membership + RBAC + resource ownership (via RLS), exactly
 * like the existing resource routes. All rows carry organization_id.
 */

// ---- AI Models (model abstraction config) ----
export const aiModelsRouter = Router();
aiModelsRouter.use(requireAuth, requireOrganizationMembership);

aiModelsRouter.get(
  '/',
  requirePermission('airules:read'),
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req, async (db) => (await db.query('SELECT * FROM ai_models ORDER BY created_at DESC')).rows);
    res.json({ models: rows });
  }),
);

aiModelsRouter.post(
  '/',
  requirePermission('airules:write'),
  asyncHandler(async (req, res) => {
    const input = aiModelSchema.parse(req.body);
    const org = getCurrentOrganization(req);
    const row = await tenantDb(req, async (db) => {
      const r = await db.query(
        `INSERT INTO ai_models(organization_id, model_type, name, version, backend_ref, confidence_threshold, is_demo_adapter, enabled, config)
         VALUES ($1,$2::ai_model_type,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [org, input.modelType, input.name, input.version, input.backendRef ?? null, input.confidenceThreshold, input.isDemoAdapter, input.enabled, JSON.stringify(input.config)],
      );
      await audit(db, org, { action: 'ai_model.create', resource: 'ai_model', resourceId: r.rows[0]!.id as string, ip: req.ip });
      return r.rows[0];
    });
    res.status(201).json({ model: row });
  }),
);

aiModelsRouter.patch(
  '/:id',
  requirePermission('airules:write'),
  asyncHandler(async (req, res) => {
    const input = aiModelSchema.partial().parse(req.body);
    const org = getCurrentOrganization(req);
    const row = await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'ai_models', req.params.id!);
      const r = await db.query(
        `UPDATE ai_models SET
           name = COALESCE($2, name),
           version = COALESCE($3, version),
           backend_ref = COALESCE($4, backend_ref),
           confidence_threshold = COALESCE($5, confidence_threshold),
           enabled = COALESCE($6, enabled),
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [req.params.id, input.name ?? null, input.version ?? null, input.backendRef ?? null, input.confidenceThreshold ?? null, input.enabled ?? null],
      );
      await audit(db, org, { action: 'ai_model.update', resource: 'ai_model', resourceId: req.params.id!, ip: req.ip });
      return r.rows[0];
    });
    res.json({ model: row });
  }),
);

aiModelsRouter.delete(
  '/:id',
  requirePermission('airules:write'),
  asyncHandler(async (req, res) => {
    const org = getCurrentOrganization(req);
    await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'ai_models', req.params.id!);
      await db.query('DELETE FROM ai_models WHERE id = $1', [req.params.id]);
      await audit(db, org, { action: 'ai_model.delete', resource: 'ai_model', resourceId: req.params.id!, ip: req.ip });
    });
    res.json({ ok: true });
  }),
);

// ---- Zone schedules (after-hours) ----
export const schedulesRouter = Router();
schedulesRouter.use(requireAuth, requireOrganizationMembership);

schedulesRouter.get(
  '/',
  requirePermission('zones:read'),
  asyncHandler(async (req, res) => {
    const zoneId = typeof req.query.zoneId === 'string' ? req.query.zoneId : null;
    const rows = await tenantDb(req, async (db) => {
      const r = await db.query(
        `SELECT * FROM zone_schedules WHERE ($1::uuid IS NULL OR zone_id = $1::uuid) ORDER BY created_at DESC`,
        [zoneId],
      );
      return r.rows;
    });
    res.json({ schedules: rows });
  }),
);

schedulesRouter.post(
  '/',
  requirePermission('zones:write'),
  asyncHandler(async (req, res) => {
    const input = zoneScheduleSchema.parse(req.body);
    const org = getCurrentOrganization(req);
    const row = await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'zones', input.zoneId); // ownership
      const r = await db.query(
        `INSERT INTO zone_schedules(organization_id, zone_id, weekday, open_minute, close_minute, timezone)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [org, input.zoneId, input.weekday ?? null, input.openMinute, input.closeMinute, input.timezone],
      );
      await audit(db, org, { action: 'zone_schedule.create', resource: 'zone_schedule', resourceId: r.rows[0]!.id as string, ip: req.ip });
      return r.rows[0];
    });
    res.status(201).json({ schedule: row });
  }),
);

schedulesRouter.delete(
  '/:id',
  requirePermission('zones:write'),
  asyncHandler(async (req, res) => {
    const org = getCurrentOrganization(req);
    await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'zone_schedules', req.params.id!);
      await db.query('DELETE FROM zone_schedules WHERE id = $1', [req.params.id]);
      await audit(db, org, { action: 'zone_schedule.delete', resource: 'zone_schedule', resourceId: req.params.id!, ip: req.ip });
    });
    res.json({ ok: true });
  }),
);

// ---- Monitored objects (object-removed) ----
export const monitoredObjectsRouter = Router();
monitoredObjectsRouter.use(requireAuth, requireOrganizationMembership);

monitoredObjectsRouter.get(
  '/',
  requirePermission('cameras:read'),
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req, async (db) => (await db.query('SELECT * FROM monitored_objects ORDER BY created_at DESC')).rows);
    res.json({ objects: rows });
  }),
);

monitoredObjectsRouter.post(
  '/',
  requirePermission('cameras:write'),
  asyncHandler(async (req, res) => {
    const input = monitoredObjectSchema.parse(req.body);
    const org = getCurrentOrganization(req);
    const row = await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'cameras', input.cameraId);
      if (input.zoneId) await requireTenantResource(db, 'zones', input.zoneId);
      const r = await db.query(
        `INSERT INTO monitored_objects(organization_id, camera_id, zone_id, label, region, confirm_ms, present, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,true, now()) RETURNING *`,
        [org, input.cameraId, input.zoneId ?? null, input.label, JSON.stringify(input.region), input.confirmMs],
      );
      await audit(db, org, { action: 'monitored_object.create', resource: 'monitored_object', resourceId: r.rows[0]!.id as string, ip: req.ip });
      return r.rows[0];
    });
    res.status(201).json({ object: row });
  }),
);

monitoredObjectsRouter.delete(
  '/:id',
  requirePermission('cameras:write'),
  asyncHandler(async (req, res) => {
    const org = getCurrentOrganization(req);
    await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'monitored_objects', req.params.id!);
      await db.query('DELETE FROM monitored_objects WHERE id = $1', [req.params.id]);
      await audit(db, org, { action: 'monitored_object.delete', resource: 'monitored_object', resourceId: req.params.id!, ip: req.ip });
    });
    res.json({ ok: true });
  }),
);
