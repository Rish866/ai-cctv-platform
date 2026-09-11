import { Router } from 'express';
import { config } from '../config.js';
import { asyncHandler } from '../middleware/http.js';
import { requireAuth, requireOrganizationMembership, requirePermission, tenantDb } from '../middleware/context.js';
import { aiModelRegistry } from '../ai/model.js';

/**
 * System/observability status for the UI. Reports the REAL AI mode so the
 * frontend can show "AI ACTIVE" vs "DEMO AI" vs "INFERENCE OFFLINE" from backend
 * state (spec §46) — never a hardcoded value. Also reports tenant-scoped camera
 * counts + active-inference cameras.
 */
export const systemRouter = Router();
systemRouter.use(requireAuth, requireOrganizationMembership);

systemRouter.get(
  '/ai-status',
  requirePermission('cameras:read'),
  asyncHandler(async (req, res) => {
    // Determine AI mode from actual adapter registration + reachability.
    const hasFire = aiModelRegistry.has('FIRE');
    const fireAdapter = hasFire ? aiModelRegistry.resolve('FIRE', { allowDemo: true }) : null;
    let mode: 'AI_ACTIVE' | 'DEMO_AI' | 'INFERENCE_OFFLINE';
    let reachable = false;

    if (config.inference.serviceUrl && fireAdapter && !fireAdapter.isDemo) {
      // Production adapter present — check the service is actually reachable.
      try {
        const r = await fetch(`${config.inference.serviceUrl.replace(/\/$/, '')}/ready`, {
          signal: AbortSignal.timeout(config.inference.timeoutMs),
        });
        reachable = r.ok;
      } catch {
        reachable = false;
      }
      mode = reachable ? 'AI_ACTIVE' : 'INFERENCE_OFFLINE';
    } else if (fireAdapter && fireAdapter.isDemo) {
      mode = 'DEMO_AI';
    } else {
      mode = 'INFERENCE_OFFLINE';
    }

    const counts = await tenantDb(req, async (db) => {
      const r = await db.query<{ total: number; online: number; offline: number; inference: number }>(
        `SELECT
           (SELECT count(*) FROM cameras)::int AS total,
           (SELECT count(*) FROM cameras WHERE status = 'ONLINE')::int AS online,
           (SELECT count(*) FROM cameras WHERE status IN ('OFFLINE','AUTH_FAILED','INVALID_STREAM'))::int AS offline,
           (SELECT count(*) FROM cameras WHERE inference_enabled = true)::int AS inference`,
      );
      return r.rows[0];
    });

    res.json({
      ai: { mode, inferenceConfigured: Boolean(config.inference.serviceUrl), reachable, model: config.inference.model },
      cameras: counts,
    });
  }),
);
