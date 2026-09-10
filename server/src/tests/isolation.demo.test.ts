import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { buildResourceTree, resetDatabase, signupTenant, testApp, type TenantAgent } from './helpers.js';
import { adminPool, appPool, closePools } from '../db/pool.js';
import { config } from '../config.js';

/**
 * DEMO MODE isolation (spec 32). Demo data lives in its own is_demo org and must
 * never appear in a real customer's dashboard/queries.
 */
describe('Demo mode isolation', () => {
  let app: Express;
  let customer: TenantAgent;
  let demoOrgId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = testApp();
    customer = await signupTenant(app, 'real-customer');
    await buildResourceTree(customer);

    // Create a demo org with its own data (as the seed would).
    demoOrgId = (await adminPool.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
    const demoUser = (await adminPool.query<{ id: string }>(`INSERT INTO users(email,password_hash,full_name) VALUES('demo@sentriai.example','x','Demo') RETURNING id`)).rows[0]!.id;
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_org',$1,true), set_config('app.current_user',$2,true)`, [demoOrgId, demoUser]);
      await client.query(`INSERT INTO organizations(id,name,slug,is_demo) VALUES($1,'Demo Co',$2,true)`, [demoOrgId, config.demoOrgSlug]);
      await client.query(`INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'OWNER')`, [demoOrgId, demoUser]);
      await client.query(`INSERT INTO subscriptions(organization_id,plan,status) VALUES($1,'GROWTH','ACTIVE')`, [demoOrgId]);
      const s = (await client.query<{ id: string }>(`INSERT INTO sites(organization_id,name) VALUES($1,'Demo Site') RETURNING id`, [demoOrgId])).rows[0]!.id;
      await client.query(`INSERT INTO cameras(organization_id,site_id,name) VALUES($1,$2,'Demo Cam')`, [demoOrgId, s]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await closePools();
  });

  it('demo org is flagged is_demo', async () => {
    const r = await adminPool.query<{ is_demo: boolean }>('SELECT is_demo FROM organizations WHERE id=$1', [demoOrgId]);
    expect(r.rows[0]!.is_demo).toBe(true);
  });

  it("a real customer's dashboard/cameras never include demo data", async () => {
    const cams = await customer.agent.get('/api/cameras').expect(200);
    const names = cams.body.cameras.map((c: { name: string }) => c.name);
    expect(names).not.toContain('Demo Cam');
    const sites = await customer.agent.get('/api/sites').expect(200);
    expect(sites.body.sites.map((s: { name: string }) => s.name)).not.toContain('Demo Site');
    // No demo org id leaks anywhere.
    expect(JSON.stringify(cams.body)).not.toContain(demoOrgId);
  });
});
