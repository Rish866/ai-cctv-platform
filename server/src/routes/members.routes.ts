import { Router } from 'express';
import { inviteMemberSchema, updateMemberSchema } from '../lib/validation.js';
import { badRequest, conflict } from '../lib/errors.js';
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
import { adminPool } from '../db/pool.js';
import { hashPassword, randomToken } from '../lib/crypto.js';

export const membersRouter = Router();
membersRouter.use(requireAuth, requireOrganizationMembership);

/**
 * List members of the CURRENT org. The join to users is safe: RLS on
 * organization_members restricts to this org, and users_select only exposes
 * users who are co-members of the current org — so no cross-tenant user leaks.
 */
membersRouter.get(
  '/',
  requirePermission('members:read'),
  asyncHandler(async (req, res) => {
    const rows = await tenantDb(req, async (db) => {
      const r = await db.query(
        `SELECT m.id, m.user_id, m.role, m.status, m.created_at,
                u.email, u.full_name
         FROM organization_members m
         JOIN users u ON u.id = m.user_id
         ORDER BY m.created_at`,
      );
      return r.rows;
    });
    res.json({ members: rows });
  }),
);

/**
 * Invite/add a member. If the user exists (global), link them to THIS org only.
 * If not, create the user with a random password (they reset via forgot-password).
 * The new membership is always scoped to the current org.
 */
membersRouter.post(
  '/',
  requirePermission('members:manage'),
  asyncHandler(async (req, res) => {
    const input = inviteMemberSchema.parse(req.body);
    const org = getCurrentOrganization(req);
    const actor = getAuthenticatedUser(req);
    const email = input.email.trim().toLowerCase();

    // Resolve or create the global user (admin conn — user table is global).
    const existing = await adminPool.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = $1', [email]);
    let userId = existing.rows[0]?.id;
    if (!userId) {
      const created = await adminPool.query<{ id: string }>(
        `INSERT INTO users(email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING id`,
        [email, await hashPassword(randomToken(16)), email.split('@')[0]],
      );
      userId = created.rows[0]!.id;
    }

    const row = await tenantDb(req, async (db) => {
      // Guard: is this user already a member of THIS org?
      const dup = await db.query('SELECT 1 FROM organization_members WHERE user_id = $1', [userId]);
      if (dup.rowCount && dup.rowCount > 0) throw conflict('User is already a member of this organization');
      const r = await db.query(
        `INSERT INTO organization_members(organization_id, user_id, role, status)
         VALUES ($1,$2,$3,'INVITED') RETURNING id, user_id, role, status, created_at`,
        [org, userId, input.role],
      );
      await audit(db, org, { userId: actor.id, action: 'member.invite', resource: 'member', resourceId: r.rows[0]!.id as string, metadata: { email, role: input.role }, ip: req.ip });
      return r.rows[0];
    });
    res.status(201).json({ member: row });
  }),
);

membersRouter.patch(
  '/:id',
  requirePermission('members:manage'),
  asyncHandler(async (req, res) => {
    const input = updateMemberSchema.parse(req.body);
    const org = getCurrentOrganization(req);
    const row = await tenantDb(req, async (db) => {
      await requireTenantResource(db, 'organization_members', req.params.id!);
      const r = await db.query(
        `UPDATE organization_members SET
           role = COALESCE($2::org_role, role),
           status = COALESCE($3::member_status, status),
           updated_at = now()
         WHERE id = $1 RETURNING id, user_id, role, status`,
        [req.params.id, input.role ?? null, input.status ?? null],
      );
      await audit(db, org, { action: 'member.update', resource: 'member', resourceId: req.params.id!, ip: req.ip });
      return r.rows[0];
    });
    res.json({ member: row });
  }),
);

membersRouter.delete(
  '/:id',
  requirePermission('members:manage'),
  asyncHandler(async (req, res) => {
    const org = getCurrentOrganization(req);
    const actor = getAuthenticatedUser(req);
    await tenantDb(req, async (db) => {
      const m = await requireTenantResource<{ id: string; user_id: string; role: string }>(
        db,
        'organization_members',
        req.params.id!,
        'id, user_id, role',
      );
      if (m.user_id === actor.id) throw badRequest('You cannot remove yourself');
      await db.query('DELETE FROM organization_members WHERE id = $1', [req.params.id]);
      await audit(db, org, { userId: actor.id, action: 'member.remove', resource: 'member', resourceId: req.params.id!, ip: req.ip });
    });
    res.json({ ok: true });
  }),
);
