import type { TenantDb } from '../db/pool.js';

/**
 * Append an audit log entry. Runs through the tenant-bound DB handle, so the
 * organization_id is fixed by RLS/context and cannot be forged. Audit logs are
 * themselves tenant-isolated (RLS) — a tenant can only read its own.
 */
export async function audit(
  db: TenantDb,
  organizationId: string,
  entry: {
    userId?: string | null;
    action: string;
    resource: string;
    resourceId?: string | null;
    ip?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs(organization_id, user_id, action, resource, resource_id, ip, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      organizationId,
      entry.userId ?? null,
      entry.action,
      entry.resource,
      entry.resourceId ?? null,
      entry.ip ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
}
