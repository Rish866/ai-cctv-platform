import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import supertest from 'supertest';
import { resetDatabase, signupTenant, testApp, type TenantAgent } from './helpers.js';
import { closePools } from '../db/pool.js';
import { roleHasPermission } from '../lib/rbac.js';

/**
 * RBAC SUITE (spec 7). Owner invites members with lower roles; each role is
 * restricted to its permissions. A VIEWER cannot write; an OPERATOR cannot
 * manage members; only OWNER can manage billing.
 */
describe('RBAC role enforcement', () => {
  let app: Express;
  let owner: TenantAgent;

  beforeAll(async () => {
    await resetDatabase();
    app = testApp();
    owner = await signupTenant(app, 'rbac-org');
  });

  afterAll(async () => {
    await closePools();
  });

  // Helper: create a member with a given role and return a logged-in agent.
  async function memberAgent(role: string): Promise<supertest.Agent> {
    const email = `${role.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    // Owner invites (creates user w/ random password), then we set a known
    // password via admin so we can log in. Simpler: invite, then use the
    // membership + a fresh password by re-inviting is not possible, so we sign
    // the member in by directly creating a password through signup of a new org
    // is wrong. Instead: create the user through invite, then set password.
    await owner.agent.post('/api/members').send({ email, role }).expect(201);
    // Activate + set password via a small admin action through the DB.
    const { adminPool } = await import('../db/pool.js');
    const { hashPassword } = await import('../lib/crypto.js');
    await adminPool.query('UPDATE users SET password_hash=$2 WHERE lower(email)=$1', [email, await hashPassword('member-pass-123')]);
    await adminPool.query(`UPDATE organization_members SET status='ACTIVE' WHERE user_id=(SELECT id FROM users WHERE lower(email)=$1)`, [email]);
    const agent = supertest.agent(app);
    await agent.post('/api/auth/login').send({ email, password: 'member-pass-123' }).expect(200);
    return agent;
  }

  it('permission matrix sanity (unit)', () => {
    expect(roleHasPermission('VIEWER', 'sites:read')).toBe(true);
    expect(roleHasPermission('VIEWER', 'sites:write')).toBe(false);
    expect(roleHasPermission('OPERATOR', 'events:handle')).toBe(true);
    expect(roleHasPermission('OPERATOR', 'members:manage')).toBe(false);
    expect(roleHasPermission('ADMIN', 'cameras:write')).toBe(true);
    expect(roleHasPermission('ADMIN', 'billing:manage')).toBe(false);
    expect(roleHasPermission('OWNER', 'billing:manage')).toBe(true);
  });

  it('VIEWER can read but cannot create a site', async () => {
    const viewer = await memberAgent('VIEWER');
    await viewer.get('/api/sites').expect(200);
    const r = await viewer.post('/api/sites').send({ name: 'nope', timezone: 'UTC' });
    expect(r.status).toBe(403);
  });

  it('OPERATOR cannot manage members', async () => {
    const op = await memberAgent('OPERATOR');
    const r = await op.post('/api/members').send({ email: 'x@y.com', role: 'VIEWER' });
    expect(r.status).toBe(403);
  });

  it('ADMIN can create sites but cannot change billing plan', async () => {
    const admin = await memberAgent('ADMIN');
    await admin.post('/api/sites').send({ name: 'admin-site', timezone: 'UTC' }).expect(201);
    const r = await admin.post('/api/billing/subscription/plan').send({ plan: 'GROWTH' });
    expect(r.status).toBe(403);
  });

  it('OWNER can change billing plan', async () => {
    await owner.agent.post('/api/billing/subscription/plan').send({ plan: 'GROWTH' }).expect(200);
  });

  it('unauthenticated requests are denied (fail closed)', async () => {
    await supertest(app).get('/api/sites').expect(401);
    await supertest(app).get('/api/dashboard').expect(401);
  });
});
