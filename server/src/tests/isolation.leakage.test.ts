import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { buildResourceTree, resetDatabase, signupTenant, testApp, type TenantAgent } from './helpers.js';
import { closePools } from '../db/pool.js';

/**
 * DATA-LEAKAGE SUITE (spec section 24).
 *
 * Collect every identifier + secret belonging to Tenant B, then walk ALL of
 * Tenant A's read endpoints and assert that no B identifier ever appears in any
 * A response body. Also asserts credentials are never present.
 */
describe('Data leakage: A responses contain zero B identifiers', () => {
  let app: Express;
  let A: TenantAgent;
  let B: TenantAgent;
  let treeB: Awaited<ReturnType<typeof buildResourceTree>>;
  let bIdentifiers: string[];

  beforeAll(async () => {
    await resetDatabase();
    app = testApp();
    A = await signupTenant(app, 'alpha');
    B = await signupTenant(app, 'beta');
    // Build data for both so A has legitimate content of its own too.
    await buildResourceTree(A);
    treeB = await buildResourceTree(B);
    bIdentifiers = [
      B.organizationId,
      B.user.id,
      B.user.email,
      treeB.siteId,
      treeB.cameraId,
      treeB.eventId,
      treeB.evidenceId,
    ].filter(Boolean);
  });

  afterAll(async () => {
    await closePools();
  });

  const A_ENDPOINTS = [
    '/api/dashboard',
    '/api/sites',
    '/api/cameras',
    '/api/events',
    '/api/ai-rules',
    '/api/notifications',
    '/api/notifications/rules',
    '/api/reports',
    '/api/billing/subscription',
    '/api/billing/invoices',
    '/api/members',
    '/api/audit-logs',
    '/api/search?q=a',
    '/api/auth/me',
  ];

  it('no B identifier leaks into any A endpoint response', async () => {
    for (const ep of A_ENDPOINTS) {
      const res = await A.agent.get(ep);
      expect(res.status, `endpoint ${ep} should be readable by A`).toBeLessThan(400);
      const body = JSON.stringify(res.body);
      for (const id of bIdentifiers) {
        expect(body.includes(id), `${ep} leaked B identifier ${id}`).toBe(false);
      }
    }
  });

  it('CSV export contains none of B ids', async () => {
    const res = await A.agent.get('/api/reports/export/events.csv').expect(200);
    const text = res.text ?? '';
    for (const id of bIdentifiers) {
      expect(text.includes(id), `CSV leaked ${id}`).toBe(false);
    }
  });

  it('no camera credential fields ever appear', async () => {
    const res = await A.agent.get('/api/cameras').expect(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('username_enc');
    expect(body).not.toContain('password_enc');
    expect(body.toLowerCase()).not.toContain('"password"');
  });
});
