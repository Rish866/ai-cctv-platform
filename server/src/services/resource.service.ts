import type { TenantDb } from '../db/pool.js';
import { notFound } from '../lib/errors.js';

/**
 * requireTenantResource — fetch a single row by id from a tenant table under
 * RLS. Because the DB handle is RLS-bound to the caller's org, a row belonging
 * to another organization is INVISIBLE (zero rows) and we raise 404. This is the
 * generic IDOR guard: even if an attacker guesses another tenant's UUID, the
 * query cannot return it.
 *
 * `table` is validated against an allow-list so it can never be attacker
 * controlled (defense in depth against SQL injection via identifier).
 */
const TENANT_TABLES = new Set([
  'sites',
  'zones',
  'cameras',
  'ai_rules',
  'events',
  'event_detections',
  'event_evidence',
  'notification_rules',
  'notifications',
  'reports',
  'subscriptions',
  'invoices',
  'audit_logs',
  'organization_members',
  // Safety & Security add-on tenant tables.
  'ai_models',
  'zone_schedules',
  'monitored_objects',
  'incident_notes',
  'alert_cooldowns',
  // Real CCTV/RTSP add-on tenant tables.
  'camera_health_events',
  'inference_stats',
]);

export async function requireTenantResource<R extends Record<string, unknown>>(
  db: TenantDb,
  table: string,
  id: string,
  columns = '*',
): Promise<R> {
  if (!TENANT_TABLES.has(table)) {
    throw new Error(`requireTenantResource: unknown table ${table}`);
  }
  // UUID validation prevents malformed input from ever hitting the query.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw notFound();
  }
  const res = await db.query<R>(`SELECT ${columns} FROM ${table} WHERE id = $1`, [id]);
  const row = res.rows[0];
  if (!row) throw notFound();
  return row;
}
