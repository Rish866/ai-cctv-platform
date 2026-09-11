import { adminPool, withUser } from '../db/pool.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { badRequest, conflict, unauthorized } from '../lib/errors.js';
import { config } from '../config.js';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  isPlatformAdmin: boolean;
}

export interface ResolvedSession {
  sessionId: string;
  user: AuthUser;
  activeOrgId: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Sign up a NEW customer: creates a user, a fresh organization (unique immutable
 * id), an OWNER membership, and a default TRIAL subscription — all atomically.
 *
 * Tenant isolation note: the whole thing runs on the APP role. We set the
 * transaction's current_org to the freshly-generated org id so the
 * organizations_insert / *_insert WITH CHECK policies pass for exactly that org
 * and nothing else. The client supplies NO organization_id.
 */
export async function signUp(input: {
  email: string;
  password: string;
  fullName: string;
  organizationName: string;
}): Promise<{ user: AuthUser; organizationId: string }> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw badRequest('Invalid email address');
  if (input.password.length < 8) throw badRequest('Password must be at least 8 characters');
  if (!input.fullName.trim()) throw badRequest('Full name is required');
  if (!input.organizationName.trim()) throw badRequest('Organization name is required');

  const passwordHash = await hashPassword(input.password);

  // Pre-check email uniqueness with the app role (users_select allows self only,
  // so we cannot see others; use admin for the existence check to give a clean
  // 409 rather than a raw unique-violation).
  const existing = await adminPool.query('SELECT 1 FROM users WHERE lower(email) = $1', [email]);
  if (existing.rowCount && existing.rowCount > 0) {
    throw conflict('An account with this email already exists');
  }

  // Generate the user id up front so we can set app.current_user before the
  // INSERT ... RETURNING — otherwise the RETURNING clause is filtered by the
  // users_select policy (id = current_user_id()) and would fail closed.
  const newUserId = (await adminPool.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
  const created = await withUser(newUserId, async (db) => {
    const u = await db.query<{ id: string; email: string; full_name: string; is_platform_admin: boolean }>(
      `INSERT INTO users(id, email, password_hash, full_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, full_name, is_platform_admin`,
      [newUserId, email, passwordHash, input.fullName.trim()],
    );
    return u.rows[0]!;
  });

  // Generate the org id up front so we can scope the insert transaction to it.
  const orgId = (await adminPool.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
  const slug = await uniqueSlug(input.organizationName);

  const client = await (await import('../db/pool.js')).appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_org', $1, true),
              set_config('app.current_user', $2, true),
              set_config('app.is_platform_admin','off', true)`,
      [orgId, created.id],
    );
    await client.query(
      `INSERT INTO organizations(id, name, slug) VALUES ($1, $2, $3)`,
      [orgId, input.organizationName.trim(), slug],
    );
    await client.query(
      `INSERT INTO organization_members(organization_id, user_id, role, status)
       VALUES ($1, $2, 'OWNER', 'ACTIVE')`,
      [orgId, created.id],
    );
    await client.query(
      `INSERT INTO subscriptions(organization_id, plan, status, camera_limit)
       VALUES ($1, 'TRIAL', 'TRIALING', 5)`,
      [orgId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  return {
    user: {
      id: created.id,
      email: created.email,
      fullName: created.full_name,
      isPlatformAdmin: created.is_platform_admin,
    },
    organizationId: orgId,
  };
}

async function uniqueSlug(name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'org';
  let candidate = base;
  let n = 1;
  // Uniqueness check needs to see all orgs -> use admin (no tenant data leaks: slug only).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await adminPool.query('SELECT 1 FROM organizations WHERE slug = $1', [candidate]);
    if (!res.rowCount) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
}

/**
 * Verify email + password and return the user. Uses admin connection for the
 * credential lookup (must find the user by email before any user context
 * exists). Returns only non-secret fields; never returns the password hash.
 */
export async function login(email: string, password: string): Promise<AuthUser> {
  const normalized = email.trim().toLowerCase();
  const res = await adminPool.query<{
    id: string;
    email: string;
    full_name: string;
    is_platform_admin: boolean;
    password_hash: string;
  }>(
    `SELECT id, email, full_name, is_platform_admin, password_hash
     FROM users WHERE lower(email) = $1`,
    [normalized],
  );
  const row = res.rows[0];
  // Constant-ish behavior: always run a verify to reduce user-enumeration timing.
  const hash = row?.password_hash ?? '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const ok = await verifyPassword(hash, password);
  if (!row || !ok) throw unauthorized('Invalid email or password');
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    isPlatformAdmin: row.is_platform_admin,
  };
}

/**
 * Create a server-side session bound to a user + active org. Returns session id.
 */
export async function createSession(
  userId: string,
  activeOrgId: string | null,
  meta: { ip?: string; userAgent?: string },
): Promise<string> {
  const expires = new Date(Date.now() + config.session.ttlHours * 3600 * 1000);
  return withUser(userId, async (db) => {
    const res = await db.query<{ id: string }>(
      `INSERT INTO sessions(user_id, active_org_id, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userId, activeOrgId, expires, meta.ip ?? null, meta.userAgent ?? null],
    );
    return res.rows[0]!.id;
  });
}

/**
 * Resolve a session id to a user + active org. Uses the admin connection in a
 * narrow, read-only way: sessions must be resolvable BEFORE we know
 * current_user. This returns no tenant resource data — only the session owner
 * and the selected org id, which are then re-validated against membership.
 */
export async function resolveSession(sessionId: string): Promise<ResolvedSession | null> {
  const res = await adminPool.query<{
    session_id: string;
    active_org_id: string | null;
    user_id: string;
    email: string;
    full_name: string;
    is_platform_admin: boolean;
    expires_at: Date;
  }>(
    `SELECT s.id AS session_id, s.active_org_id, s.expires_at,
            u.id AS user_id, u.email, u.full_name, u.is_platform_admin
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1`,
    [sessionId],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (row.expires_at.getTime() < Date.now()) {
    await adminPool.query('DELETE FROM sessions WHERE id = $1', [sessionId]).catch(() => undefined);
    return null;
  }
  return {
    sessionId: row.session_id,
    activeOrgId: row.active_org_id,
    user: {
      id: row.user_id,
      email: row.email,
      fullName: row.full_name,
      isPlatformAdmin: row.is_platform_admin,
    },
  };
}

export async function destroySession(sessionId: string): Promise<void> {
  await adminPool.query('DELETE FROM sessions WHERE id = $1', [sessionId]).catch(() => undefined);
}

export async function setActiveOrg(sessionId: string, orgId: string): Promise<void> {
  await adminPool.query('UPDATE sessions SET active_org_id = $1 WHERE id = $2', [orgId, sessionId]);
}
