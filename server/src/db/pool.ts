import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

// Ensure numeric(4,3) etc. come back as JS numbers, not strings, where safe.
// (confidence values). We keep bigints as strings to avoid precision loss.
pg.types.setTypeParser(1700 /* numeric */, (v) => (v === null ? null : parseFloat(v)));

/**
 * APP pool — every runtime request uses this. Connects as the NOSUPERUSER,
 * NOBYPASSRLS role `sentriai_app`, so PostgreSQL RLS is always enforced.
 */
export const appPool = new Pool({
  connectionString: config.appDatabaseUrl,
  max: 10,
  idleTimeoutMillis: 10_000,
});

/**
 * ADMIN pool — superuser, used ONLY for:
 *   - running migrations
 *   - the narrow, pre-authentication session lookup (resolving a cookie to a
 *     user before we know current_user). This never returns tenant data.
 * It must never be used to serve tenant resource queries.
 */
export const adminPool = new Pool({
  connectionString: config.adminDatabaseUrl,
  max: 4,
  idleTimeoutMillis: 10_000,
});

export interface TenantContext {
  userId: string;
  organizationId: string;
  role: string;
  isPlatformAdmin: boolean;
}

/**
 * A database handle already bound to a tenant context via SET LOCAL GUCs.
 * All queries executed through it are subject to RLS for that org/user.
 */
export interface TenantDb {
  query: <R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ) => Promise<pg.QueryResult<R>>;
}

/**
 * Run `fn` inside a single transaction on the APP pool with the tenant context
 * applied via SET LOCAL. Because SET LOCAL is transaction-scoped, the GUCs
 * cannot leak to another request even if connections are pooled/reused — this
 * is what makes concurrency safe and forbids any global mutable tenant state.
 *
 * If ctx.organizationId is empty/undefined, current_org is left unset => RLS
 * fails closed (zero rows, no writes).
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (db: TenantDb) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    // set_config(name, value, is_local=true) => transaction-scoped GUCs.
    await client.query(
      `SELECT
         set_config('app.current_org', $1, true),
         set_config('app.current_user', $2, true),
         set_config('app.is_platform_admin', $3, true)`,
      [
        ctx.organizationId ?? '',
        ctx.userId ?? '',
        ctx.isPlatformAdmin ? 'on' : 'off',
      ],
    );
    const db: TenantDb = {
      query: (text, params) => client.query(text, params as unknown[]),
    };
    const result = await fn(db);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run a query on the APP pool WITHOUT any tenant context. Used only for
 * operations that legitimately have no org yet AND carry no tenant data,
 * e.g. creating a user during signup, or looking up a user by email at login.
 * RLS still applies (users_insert allows insert; users_select only self/members).
 */
export async function withAppRole<T>(
  fn: (db: TenantDb) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    // Explicitly clear any context — defensive; a fresh connection has none.
    await client.query(
      `SELECT set_config('app.current_org','',true),
              set_config('app.current_user',$1,true),
              set_config('app.is_platform_admin','off',true)`,
      [''],
    );
    const db: TenantDb = {
      query: (text, params) => client.query(text, params as unknown[]),
    };
    const result = await fn(db);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Set the current_user GUC (but not org) for a self-scoped operation like
 * reading/writing one's own user row or sessions before an org is selected.
 */
export async function withUser<T>(
  userId: string,
  fn: (db: TenantDb) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_org','',true),
              set_config('app.current_user',$1,true),
              set_config('app.is_platform_admin','off',true)`,
      [userId],
    );
    const db: TenantDb = {
      query: (text, params) => client.query(text, params as unknown[]),
    };
    const result = await fn(db);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function closePools(): Promise<void> {
  await Promise.allSettled([appPool.end(), adminPool.end()]);
}
