import { Router } from 'express';
import { config } from '../config.js';
import { signSessionId } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';
import { forgotPasswordSchema, loginSchema, signupSchema } from '../lib/validation.js';
import { asyncHandler } from '../middleware/http.js';
import { getAuthenticatedUser, requireAuth } from '../middleware/context.js';
import {
  createSession,
  destroySession,
  login,
  setActiveOrg,
  signUp,
} from '../services/auth.service.js';
import { getMembership, listMemberships } from '../services/membership.service.js';

export const authRouter = Router();

function setSessionCookie(res: import('express').Response, sessionId: string): void {
  res.cookie(config.session.cookieName, signSessionId(sessionId), {
    httpOnly: true,
    secure: config.session.cookieSecure,
    sameSite: 'lax',
    maxAge: config.session.ttlHours * 3600 * 1000,
    path: '/',
  });
}

function clientMeta(req: import('express').Request) {
  return {
    ip: (req.headers['x-forwarded-for'] as string) || req.ip,
    userAgent: req.headers['user-agent'],
  };
}

/** Sign up a new customer + organization + owner. Starts an isolated tenant. */
authRouter.post(
  '/signup',
  asyncHandler(async (req, res) => {
    const input = signupSchema.parse(req.body);
    const { user, organizationId } = await signUp(input);
    const sessionId = await createSession(user.id, organizationId, clientMeta(req));
    setSessionCookie(res, sessionId);
    const membership = await getMembership(user.id, organizationId);
    res.status(201).json({ user, organization: membership });
  }),
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = await login(email, password);
    const memberships = await listMemberships(user.id);
    const activeOrg = memberships.find((m) => m.status === 'ACTIVE') ?? null;
    const sessionId = await createSession(user.id, activeOrg?.organizationId ?? null, clientMeta(req));
    setSessionCookie(res, sessionId);
    res.json({ user, organizations: memberships, activeOrganizationId: activeOrg?.organizationId ?? null });
  }),
);

authRouter.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    await destroySession(req.ctx!.sessionId);
    res.clearCookie(config.session.cookieName, { path: '/' });
    res.json({ ok: true });
  }),
);

/**
 * Forgot password — always returns 200 to avoid leaking which emails exist.
 * (Email delivery is out of scope for this build; a real deployment would send
 * a signed, single-use reset token.)
 */
authRouter.post(
  '/forgot-password',
  asyncHandler(async (req, res) => {
    forgotPasswordSchema.parse(req.body);
    res.json({ ok: true, message: 'If an account exists, a reset link has been sent.' });
  }),
);

/** Current user + memberships. */
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = getAuthenticatedUser(req);
    const memberships = await listMemberships(user.id);
    res.json({
      user,
      organizations: memberships,
      activeOrganization: req.ctx?.membership ?? null,
    });
  }),
);

/**
 * Switch the active organization. The server VERIFIES membership before
 * switching — a user cannot activate an org they do not belong to.
 */
authRouter.post(
  '/switch-org',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = getAuthenticatedUser(req);
    const orgId = typeof req.body?.organizationId === 'string' ? req.body.organizationId : '';
    const membership = await getMembership(user.id, orgId);
    if (!membership || membership.status !== 'ACTIVE') {
      // Do not reveal whether the org exists — treat as bad request.
      throw badRequest('You are not a member of that organization');
    }
    await setActiveOrg(req.ctx!.sessionId, orgId);
    res.json({ activeOrganization: membership });
  }),
);
