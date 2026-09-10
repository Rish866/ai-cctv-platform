import { adminPool } from '../db/pool.js';
import type { OrgRole } from '../lib/rbac.js';

export interface Membership {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: OrgRole;
  status: 'ACTIVE' | 'INVITED' | 'SUSPENDED';
}

/**
 * Resolve a user's membership in a specific org. This is the AUTHORITATIVE
 * source of tenant context: the caller's role/org is derived from the database,
 * never from anything the client sends.
 *
 * Uses the admin connection because membership must be resolvable to establish
 * the tenant context itself (chicken/egg with RLS). It returns only the caller's
 * OWN membership row (filtered by user_id), so it leaks nothing cross-tenant.
 */
export async function getMembership(
  userId: string,
  organizationId: string,
): Promise<Membership | null> {
  const res = await adminPool.query<{
    organization_id: string;
    name: string;
    slug: string;
    role: OrgRole;
    status: 'ACTIVE' | 'INVITED' | 'SUSPENDED';
  }>(
    `SELECT m.organization_id, o.name, o.slug, m.role, m.status
     FROM organization_members m
     JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = $1 AND m.organization_id = $2`,
    [userId, organizationId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    organizationId: row.organization_id,
    organizationName: row.name,
    organizationSlug: row.slug,
    role: row.role,
    status: row.status,
  };
}

/** List all orgs a user belongs to (for the org switcher). Scoped to the user. */
export async function listMemberships(userId: string): Promise<Membership[]> {
  const res = await adminPool.query<{
    organization_id: string;
    name: string;
    slug: string;
    role: OrgRole;
    status: 'ACTIVE' | 'INVITED' | 'SUSPENDED';
  }>(
    `SELECT m.organization_id, o.name, o.slug, m.role, m.status
     FROM organization_members m
     JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = $1
     ORDER BY o.name`,
    [userId],
  );
  return res.rows.map((row) => ({
    organizationId: row.organization_id,
    organizationName: row.name,
    organizationSlug: row.slug,
    role: row.role,
    status: row.status,
  }));
}
