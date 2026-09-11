import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminPool, appPool, closePools, withTenant } from '../db/pool.js';
import { resetDatabase } from './helpers.js';

/**
 * DATABASE-LEVEL RLS SUITE (spec 4, 5). Proves isolation is enforced by
 * PostgreSQL itself, independent of application code — the deepest layer.
 */
describe('PostgreSQL Row Level Security (database layer)', () => {
  let orgA: string;
  let orgB: string;
  let userA: string;
  let userB: string;
  let siteB: string;
  let camB: string;

  beforeAll(async () => {
    await resetDatabase();
    orgA = (await adminPool.query<{ id: string }>(`INSERT INTO organizations(name,slug) VALUES('A','a') RETURNING id`)).rows[0]!.id;
    orgB = (await adminPool.query<{ id: string }>(`INSERT INTO organizations(name,slug) VALUES('B','b') RETURNING id`)).rows[0]!.id;
    userA = (await adminPool.query<{ id: string }>(`INSERT INTO users(email,password_hash,full_name) VALUES('a@a.com','x','A') RETURNING id`)).rows[0]!.id;
    userB = (await adminPool.query<{ id: string }>(`INSERT INTO users(email,password_hash,full_name) VALUES('b@b.com','x','B') RETURNING id`)).rows[0]!.id;
    await adminPool.query(`INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'OWNER')`, [orgA, userA]);
    await adminPool.query(`INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'OWNER')`, [orgB, userB]);
    const sA = (await adminPool.query<{ id: string }>(`INSERT INTO sites(organization_id,name) VALUES($1,'SA') RETURNING id`, [orgA])).rows[0]!.id;
    siteB = (await adminPool.query<{ id: string }>(`INSERT INTO sites(organization_id,name) VALUES($1,'SB') RETURNING id`, [orgB])).rows[0]!.id;
    await adminPool.query(`INSERT INTO cameras(organization_id,site_id,name) VALUES($1,$2,'CA')`, [orgA, sA]);
    camB = (await adminPool.query<{ id: string }>(`INSERT INTO cameras(organization_id,site_id,name) VALUES($1,$2,'CB') RETURNING id`, [orgB, siteB])).rows[0]!.id;
  });

  afterAll(async () => {
    await closePools();
  });

  it('app role has NOBYPASSRLS', async () => {
    const r = await appPool.query<{ b: boolean }>(`SELECT rolbypassrls AS b FROM pg_roles WHERE rolname=current_user`);
    expect(r.rows[0]!.b).toBe(false);
  });

  it('tenant A sees only its own sites', async () => {
    const rows = await withTenant({ userId: userA, organizationId: orgA, role: 'OWNER', isPlatformAdmin: false }, async (db) => (await db.query('SELECT name FROM sites')).rows);
    expect(rows.map((r) => (r as { name: string }).name)).toEqual(['SA']);
  });

  it('tenant A gets zero rows selecting B camera by id', async () => {
    const rows = await withTenant({ userId: userA, organizationId: orgA, role: 'OWNER', isPlatformAdmin: false }, async (db) => (await db.query('SELECT id FROM cameras WHERE id=$1', [camB])).rows);
    expect(rows.length).toBe(0);
  });

  it('tenant A UPDATE on B camera affects 0 rows', async () => {
    const count = await withTenant({ userId: userA, organizationId: orgA, role: 'OWNER', isPlatformAdmin: false }, async (db) => (await db.query(`UPDATE cameras SET name='hacked' WHERE id=$1`, [camB])).rowCount);
    expect(count).toBe(0);
  });

  it('tenant A DELETE on B site affects 0 rows', async () => {
    const count = await withTenant({ userId: userA, organizationId: orgA, role: 'OWNER', isPlatformAdmin: false }, async (db) => (await db.query(`DELETE FROM sites WHERE id=$1`, [siteB])).rowCount);
    expect(count).toBe(0);
  });

  it('tenant A INSERT into B org is blocked by WITH CHECK', async () => {
    await expect(
      withTenant({ userId: userA, organizationId: orgA, role: 'OWNER', isPlatformAdmin: false }, async (db) => {
        await db.query(`INSERT INTO sites(organization_id,name) VALUES($1,'evil')`, [orgB]);
      }),
    ).rejects.toThrow();
  });

  it('no tenant context => zero rows (fail closed)', async () => {
    const rows = await withTenant({ userId: '', organizationId: '', role: 'VIEWER', isPlatformAdmin: false }, async (db) => (await db.query('SELECT id FROM sites')).rows);
    expect(rows.length).toBe(0);
  });
});
