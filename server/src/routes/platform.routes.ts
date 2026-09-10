import { Router } from 'express';
import { asyncHandler } from '../middleware/http.js';
import { platformDb, requireAuth, requirePlatformAdmin } from '../middleware/context.js';

/**
 * Platform admin routes. Reachable ONLY by users with users.is_platform_admin.
 * These use platformDb() which sets app.is_platform_admin='on', so RLS permits
 * cross-org aggregate reads — but this is gated behind requirePlatformAdmin and
 * is never reachable by a normal tenant admin.
 */
export const platformRouter = Router();
platformRouter.use(requireAuth, requirePlatformAdmin);

platformRouter.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const data = await platformDb(req, async (db) => {
      const orgs = (await db.query<{
        id: string;
        name: string;
        slug: string;
        is_demo: boolean;
        created_at: Date;
        plan: string | null;
        status: string | null;
        cameras: number;
      }>(
        `SELECT o.id, o.name, o.slug, o.is_demo, o.created_at,
                s.plan, s.status,
                (SELECT count(*) FROM cameras c WHERE c.organization_id = o.id)::int AS cameras
         FROM organizations o
         LEFT JOIN subscriptions s ON s.organization_id = o.id
         ORDER BY o.created_at DESC`,
      )).rows;
      const totals = (await db.query<{
        organizations: number;
        cameras: number;
        events: number;
        users: number;
      }>(
        `SELECT
          (SELECT count(*) FROM organizations)::int AS organizations,
          (SELECT count(*) FROM cameras)::int AS cameras,
          (SELECT count(*) FROM events)::int AS events,
          (SELECT count(*) FROM users)::int AS users`,
      )).rows[0];
      return { organizations: orgs, totals };
    });
    res.json(data);
  }),
);
