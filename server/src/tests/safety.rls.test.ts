import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminPool, closePools, withTenant } from '../db/pool.js';
import { resetDatabase } from './helpers.js';

/**
 * DATABASE-LAYER RLS for the new Safety & Security tables. Proves isolation is
 * enforced by PostgreSQL itself (not just the API), matching the existing model.
 */
describe('RLS on new safety/security tables', () => {
  let orgA: string;
  let orgB: string;
  let userA: string;
  let camA: string;
  let siteA: string;
  let zoneA: string;
  let modelB: string;

  beforeAll(async () => {
    await resetDatabase();
    orgA = (await adminPool.query<{ id: string }>(`INSERT INTO organizations(name,slug) VALUES('A','sa') RETURNING id`)).rows[0]!.id;
    orgB = (await adminPool.query<{ id: string }>(`INSERT INTO organizations(name,slug) VALUES('B','sb') RETURNING id`)).rows[0]!.id;
    userA = (await adminPool.query<{ id: string }>(`INSERT INTO users(email,password_hash,full_name) VALUES('sa@a.com','x','A') RETURNING id`)).rows[0]!.id;
    await adminPool.query(`INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'OWNER')`, [orgA, userA]);
    siteA = (await adminPool.query<{ id: string }>(`INSERT INTO sites(organization_id,name) VALUES($1,'SA') RETURNING id`, [orgA])).rows[0]!.id;
    zoneA = (await adminPool.query<{ id: string }>(`INSERT INTO zones(organization_id,site_id,name) VALUES($1,$2,'ZA') RETURNING id`, [orgA, siteA])).rows[0]!.id;
    camA = (await adminPool.query<{ id: string }>(`INSERT INTO cameras(organization_id,site_id,name) VALUES($1,$2,'CA') RETURNING id`, [orgA, siteA])).rows[0]!.id;
    // A model belonging to B.
    const siteB = (await adminPool.query<{ id: string }>(`INSERT INTO sites(organization_id,name) VALUES($1,'SB') RETURNING id`, [orgB])).rows[0]!.id;
    void siteB;
    modelB = (await adminPool.query<{ id: string }>(`INSERT INTO ai_models(organization_id,model_type,name) VALUES($1,'FIRE','MB') RETURNING id`, [orgB])).rows[0]!.id;
    // Seed one of each new table for B so A must not see them.
    await adminPool.query(`INSERT INTO zone_schedules(organization_id,zone_id) VALUES($1,(SELECT id FROM zones WHERE organization_id=$1 LIMIT 1))`, [orgB]).catch(() => undefined);
  });

  afterAll(async () => {
    await closePools();
  });

  const asA = <T>(fn: Parameters<typeof withTenant>[1]) =>
    withTenant({ userId: userA, organizationId: orgA, role: 'OWNER', isPlatformAdmin: false }, fn) as Promise<T>;

  it('A can create + read its own ai_model / schedule / monitored_object', async () => {
    await asA(async (db) => {
      await db.query(`INSERT INTO ai_models(organization_id,model_type,name) VALUES($1,'FIRE','MA')`, [orgA]);
      await db.query(`INSERT INTO zone_schedules(organization_id,zone_id) VALUES($1,$2)`, [orgA, zoneA]);
      await db.query(`INSERT INTO monitored_objects(organization_id,camera_id,label) VALUES($1,$2,'Pallet')`, [orgA, camA]);
      const models = await db.query('SELECT id FROM ai_models');
      const scheds = await db.query('SELECT id FROM zone_schedules');
      const objs = await db.query('SELECT id FROM monitored_objects');
      expect(models.rows.length).toBe(1); // only A's, not B's
      expect(scheds.rows.length).toBe(1);
      expect(objs.rows.length).toBe(1);
    });
  });

  it('A sees ZERO of B ai_models (RLS SELECT)', async () => {
    await asA(async (db) => {
      const r = await db.query('SELECT id FROM ai_models WHERE id = $1', [modelB]);
      expect(r.rows.length).toBe(0);
    });
  });

  it('A UPDATE on B ai_model affects 0 rows', async () => {
    await asA(async (db) => {
      const r = await db.query(`UPDATE ai_models SET name='hacked' WHERE id=$1`, [modelB]);
      expect(r.rowCount).toBe(0);
    });
  });

  it('A DELETE on B ai_model affects 0 rows', async () => {
    await asA(async (db) => {
      const r = await db.query(`DELETE FROM ai_models WHERE id=$1`, [modelB]);
      expect(r.rowCount).toBe(0);
    });
  });

  it('A INSERT into B org (ai_models) blocked by WITH CHECK', async () => {
    await expect(
      asA(async (db) => {
        await db.query(`INSERT INTO ai_models(organization_id,model_type,name) VALUES($1,'FIRE','evil')`, [orgB]);
      }),
    ).rejects.toThrow();
  });

  it('no tenant context => zero rows on new tables (fail closed)', async () => {
    await withTenant({ userId: '', organizationId: '', role: 'VIEWER', isPlatformAdmin: false }, async (db) => {
      expect((await db.query('SELECT id FROM ai_models')).rows.length).toBe(0);
      expect((await db.query('SELECT id FROM zone_schedules')).rows.length).toBe(0);
      expect((await db.query('SELECT id FROM monitored_objects')).rows.length).toBe(0);
      expect((await db.query('SELECT id FROM alert_cooldowns')).rows.length).toBe(0);
      expect((await db.query('SELECT id FROM incident_notes')).rows.length).toBe(0);
    });
  });
});
