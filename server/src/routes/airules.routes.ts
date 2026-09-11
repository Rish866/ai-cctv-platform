import { Router } from 'express';
import { aiRuleSchema } from '../lib/validation.js';
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

export const aiRulesRouter = Router();
aiRulesRouter.use(requireAuth, requireOrganizationMembership);

aiRulesRouter.get(
  '/',
  requirePermission('airules:read'),
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req, async (db) => (await db.query('SELECT * FROM ai_rules ORDER BY created_at DESC')).rows);
    res.json({ rules: rows });
  }),
);

aiRulesRouter.get(
  '/:id',
  requirePermission('airules:read'),
  asyncHandler(async (req, res) => {
    const row = await tenantDb(req, (db) => requireTenantResource(db, 'ai_rules', req.params.id!));
    res.json({ rule: row });
  }),
);

aiRulesRouter.post(
  '/',
  requirePermission('airules:write'),
  asyncHandler(async (req, res) => {
    const input = aiRuleSchema.parse(req.body);
    const org = getCurrentOrganization(req);
    const row = await tenantDb(req, async (db) => {
      // Camera must belong to this org.
      await requireTenantResource(db, 'cameras', input.cameraId);
      if (input.zoneId) await requireTenantResource(db, 'zones', input.zoneId);
      if (input.aiModelId) await requireTenantResource(db, 'ai_models', input.aiModelId);
      const r = await db.query(
        `INSERT INTO ai_rules(organization_id, camera_id, zone_id, rule_type, enabled, min_confidence, severity, config,
                              cooldown_seconds, min_duration_ms, notify_channels, ai_model_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
                 COALESCE($9, 30), COALESCE($10, 0), COALESCE($11::notify_channel[], '{}'::notify_channel[]), $12)
         RETURNING *`,
        [
          org, input.cameraId, input.zoneId ?? null, input.ruleType, input.enabled, input.minConfidence, input.severity, JSON.stringify(input.config),
          input.cooldownSeconds ?? null, input.minDurationMs ?? null, input.notifyChannels ?? null, input.aiModelId ?? null,
        ],
      );
      await audit(db, org, { action: 'ai_rule.create', resource: 'ai_rule', resourceId: r.rows[0]!.id as string, metadata: { ruleType: input.ruleType, severity: input.severity }, ip: req.ip });
      return r.rows[0];
    });
    res.status(201).json({ rule: row });
  }),
);

aiRulesRouter.patch(
  '/:id',
  requirePermission('airules:write'),
  asyncHandler(async (req, res) => {
    const input = aiRuleSchema.partial().parse(req.body);
    const org = getCurrentOrganization(req);
    await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'ai_rules', req.params.id!);
      await db.query(
        `UPDATE ai_rules SET
           enabled = COALESCE($2, enabled),
           min_confidence = COALESCE($3, min_confidence),
           severity = COALESCE($4::event_severity, severity),
           cooldown_seconds = COALESCE($5, cooldown_seconds),
           min_duration_ms = COALESCE($6, min_duration_ms),
           notify_channels = COALESCE($7::notify_channel[], notify_channels),
           updated_at = now()
         WHERE id = $1`,
        [
          req.params.id, input.enabled ?? null, input.minConfidence ?? null, input.severity ?? null,
          input.cooldownSeconds ?? null, input.minDurationMs ?? null, input.notifyChannels ?? null,
        ],
      );
      await audit(db, org, { action: 'ai_rule.update', resource: 'ai_rule', resourceId: req.params.id!, metadata: { changed: Object.keys(input) }, ip: req.ip });
    });
    const row = await tenantDb(req, (db) => requireTenantResource(db, 'ai_rules', req.params.id!));
    res.json({ rule: row });
  }),
);

aiRulesRouter.delete(
  '/:id',
  requirePermission('airules:write'),
  asyncHandler(async (req, res) => {
    const org = getCurrentOrganization(req);
    await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'ai_rules', req.params.id!);
      await db.query('DELETE FROM ai_rules WHERE id = $1', [req.params.id]);
      await audit(db, org, { action: 'ai_rule.delete', resource: 'ai_rule', resourceId: req.params.id!, ip: req.ip });
    });
    res.json({ ok: true });
  }),
);
