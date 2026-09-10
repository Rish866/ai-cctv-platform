/**
 * Role-Based Access Control.
 *
 * Org roles (stored in organization_members.role):
 *   OWNER    — full control of the organization, including billing + user mgmt.
 *   ADMIN    — operational management (sites, cameras, rules, users except owners).
 *   OPERATOR — camera monitoring + incident handling (ack/resolve events).
 *   VIEWER   — read-only.
 *
 * PLATFORM_ADMIN is a separate global flag on users (users.is_platform_admin)
 * and is NOT an org role — it grants controlled platform-level access only.
 */
export type OrgRole = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';

export const ORG_ROLES: OrgRole[] = ['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'];

// Ordered privilege ranking (higher index = more privilege).
const RANK: Record<OrgRole, number> = {
  VIEWER: 0,
  OPERATOR: 1,
  ADMIN: 2,
  OWNER: 3,
};

export function roleAtLeast(role: OrgRole, minimum: OrgRole): boolean {
  return RANK[role] >= RANK[minimum];
}

/**
 * Fine-grained permissions. Keeping this explicit avoids scattering role checks.
 * Each permission maps to the minimum org role that holds it.
 */
export type Permission =
  | 'org:read'
  | 'org:update'
  | 'org:delete'
  | 'members:read'
  | 'members:manage'
  | 'sites:read'
  | 'sites:write'
  | 'zones:read'
  | 'zones:write'
  | 'cameras:read'
  | 'cameras:write'
  | 'cameras:stream'
  | 'credentials:write'
  | 'airules:read'
  | 'airules:write'
  | 'events:read'
  | 'events:handle' // acknowledge / resolve / dismiss
  | 'evidence:read'
  | 'notifications:read'
  | 'notifications:manage'
  | 'reports:read'
  | 'reports:write'
  | 'billing:read'
  | 'billing:manage'
  | 'audit:read';

const PERMISSION_MIN_ROLE: Record<Permission, OrgRole> = {
  'org:read': 'VIEWER',
  'org:update': 'ADMIN',
  'org:delete': 'OWNER',
  'members:read': 'OPERATOR',
  'members:manage': 'ADMIN',
  'sites:read': 'VIEWER',
  'sites:write': 'ADMIN',
  'zones:read': 'VIEWER',
  'zones:write': 'ADMIN',
  'cameras:read': 'VIEWER',
  'cameras:write': 'ADMIN',
  'cameras:stream': 'OPERATOR',
  'credentials:write': 'ADMIN',
  'airules:read': 'VIEWER',
  'airules:write': 'ADMIN',
  'events:read': 'VIEWER',
  'events:handle': 'OPERATOR',
  'evidence:read': 'VIEWER',
  'notifications:read': 'VIEWER',
  'notifications:manage': 'ADMIN',
  'reports:read': 'VIEWER',
  'reports:write': 'OPERATOR',
  'billing:read': 'ADMIN',
  'billing:manage': 'OWNER',
  'audit:read': 'ADMIN',
};

export function roleHasPermission(role: OrgRole, permission: Permission): boolean {
  const min = PERMISSION_MIN_ROLE[permission];
  return roleAtLeast(role, min);
}
