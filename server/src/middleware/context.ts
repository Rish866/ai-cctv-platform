import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { verifySessionId } from '../lib/crypto.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import type { OrgRole, Permission } from '../lib/rbac.js';
import { roleHasPermission } from '../lib/rbac.js';
import { resolveSession, type AuthUser } from '../services/auth.service.js';
import { getMembership, type Membership } from '../services/membership.service.js';
import { withTenant, type TenantContext, type TenantDb } from '../db/pool.js';

/**
 * Per-request tenant context. Attached to req.ctx by requireAuth. There is NO
 * global/mutable tenant state anywhere: every request resolves its own context
 * from its own authenticated session, so concurrent users cannot leak into each
 * other (see the concurrency test).
 */
export interface RequestContext {
  user: AuthUser;
  sessionId: string;
  /** The active organization + role, if the user has selected/loaded one. */
  membership: Membership | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx?: RequestContext;
    }
  }
}

function readSessionCookie(req: Request): string | null {
  const raw = req.cookies?.[config.session.cookieName];
  if (!raw || typeof raw !== 'string') return null;
  return verifySessionId(raw);
}

/**
 * getAuthenticatedUser — resolves the session cookie to a user. FAILS CLOSED:
 * if there is no valid session, access is denied (401).
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = readSessionCookie(req);
    if (!sessionId) throw unauthorized();
    const resolved = await resolveSession(sessionId);
    if (!resolved) throw unauthorized('Session expired or invalid');

    let membership: Membership | null = null;
    // The active org is derived from the SERVER-side session, then re-validated
    // against live membership. The client cannot switch tenants by editing a
    // header/body/param — those are ignored here entirely.
    if (resolved.activeOrgId) {
      membership = await getMembership(resolved.user.id, resolved.activeOrgId);
      // If the stored active org is no longer a valid membership, drop it.
      if (membership && membership.status !== 'ACTIVE') membership = null;
    }

    req.ctx = {
      user: resolved.user,
      sessionId: resolved.sessionId,
      membership,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/** getAuthenticatedUser accessor — throws (fail closed) if unauthenticated. */
export function getAuthenticatedUser(req: Request): AuthUser {
  if (!req.ctx?.user) throw unauthorized();
  return req.ctx.user;
}

/**
 * requireOrganizationMembership — ensures the request has an ACTIVE membership
 * in the active organization. Without it, deny (403). This is what establishes
 * the tenant for RLS.
 */
export function requireOrganizationMembership(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  try {
    const ctx = req.ctx;
    if (!ctx?.user) throw unauthorized();
    if (!ctx.membership) {
      throw forbidden('No active organization membership for this request');
    }
    if (ctx.membership.status !== 'ACTIVE') {
      throw forbidden('Organization membership is not active');
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** getCurrentOrganization — the active org id, or throws (fail closed). */
export function getCurrentOrganization(req: Request): string {
  const org = req.ctx?.membership?.organizationId;
  if (!org) throw forbidden('No active organization');
  return org;
}

export function getCurrentRole(req: Request): OrgRole {
  const role = req.ctx?.membership?.role;
  if (!role) throw forbidden('No active organization');
  return role;
}

/**
 * requireRole — middleware factory. Denies (403) unless the caller's role in
 * the active org satisfies the permission. Platform admins bypass org-role
 * checks for read operations only when explicitly allowed by the route.
 */
export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const ctx = req.ctx;
      if (!ctx?.user) throw unauthorized();
      if (!ctx.membership) throw forbidden('No active organization membership');
      if (!roleHasPermission(ctx.membership.role, permission)) {
        throw forbidden(`Your role (${ctx.membership.role}) lacks permission: ${permission}`);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** requirePlatformAdmin — for platform-level routes only. */
export function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction): void {
  try {
    const user = req.ctx?.user;
    if (!user) throw unauthorized();
    if (!user.isPlatformAdmin) throw forbidden('Platform administrator access required');
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * tenantDb — run a callback with a DB handle bound to the request's tenant
 * context (org + user + platform-admin flag). All queries are RLS-enforced.
 * This is the ONLY way route handlers touch tenant data.
 */
export async function tenantDb<T>(
  req: Request,
  fn: (db: TenantDb) => Promise<T>,
): Promise<T> {
  const ctx = req.ctx;
  if (!ctx?.user) throw unauthorized();
  if (!ctx.membership) throw forbidden('No active organization');
  const tc: TenantContext = {
    userId: ctx.user.id,
    organizationId: ctx.membership.organizationId,
    role: ctx.membership.role,
    // Platform-admin bypass is opt-in per request; for normal tenant routes we
    // keep it OFF so even a platform admin operating inside an org is scoped to
    // that org. Dedicated platform-admin routes use platformDb() below.
    isPlatformAdmin: false,
  };
  return withTenant(tc, fn);
}

/**
 * platformDb — RLS handle with platform-admin bypass ON. Only reachable through
 * requirePlatformAdmin-protected routes.
 */
export async function platformDb<T>(
  req: Request,
  fn: (db: TenantDb) => Promise<T>,
): Promise<T> {
  const user = req.ctx?.user;
  if (!user?.isPlatformAdmin) throw forbidden('Platform administrator access required');
  return withTenant(
    { userId: user.id, organizationId: '', role: 'OWNER', isPlatformAdmin: true },
    fn,
  );
}
