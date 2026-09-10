import { adminPool, appPool, closePools } from './pool.js';
import { hashPassword } from '../lib/crypto.js';
import { config } from '../config.js';

/**
 * Seed a clearly-isolated DEMO organization for sales demonstrations. Demo data
 * lives in its own org (slug from DEMO_ORG_SLUG, is_demo=true) and therefore can
 * never appear in a real customer dashboard — RLS scopes every query to the
 * caller's org, and demo is just another tenant.
 */
async function seed(): Promise<void> {
  const email = 'demo@sentriai.example';
  const passwordHash = await hashPassword('demo-password-123');

  const existing = await adminPool.query('SELECT id FROM organizations WHERE slug = $1', [config.demoOrgSlug]);
  if (existing.rowCount && existing.rowCount > 0) {
    process.stdout.write('[seed] demo org already exists; skipping\n');
    await closePools();
    return;
  }

  const existingUser = await adminPool.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = $1', [email]);
  const userId =
    existingUser.rows[0]?.id ??
    (
      await adminPool.query<{ id: string }>(
        `INSERT INTO users(email, password_hash, full_name)
         VALUES ($1,$2,'Demo Operator') RETURNING id`,
        [email, passwordHash],
      )
    ).rows[0]!.id;

  const orgId = (await adminPool.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;

  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_org',$1,true), set_config('app.current_user',$2,true)`,
      [orgId, userId],
    );
    await client.query(`INSERT INTO organizations(id,name,slug,is_demo) VALUES ($1,'SentriAI Demo Co',$2,true)`, [orgId, config.demoOrgSlug]);
    await client.query(`INSERT INTO organization_members(organization_id,user_id,role,status) VALUES ($1,$2,'OWNER','ACTIVE')`, [orgId, userId]);
    await client.query(`INSERT INTO subscriptions(organization_id,plan,status,camera_limit) VALUES ($1,'GROWTH','ACTIVE',50)`, [orgId]);
    const site = (await client.query<{ id: string }>(`INSERT INTO sites(organization_id,name,address) VALUES ($1,'Demo Warehouse','123 Demo St') RETURNING id`, [orgId])).rows[0]!.id;
    const cam = (await client.query<{ id: string }>(`INSERT INTO cameras(organization_id,site_id,name,rtsp_host,rtsp_path,status) VALUES ($1,$2,'Loading Bay Cam','demo.local','/stream1','ONLINE') RETURNING id`, [orgId, site])).rows[0]!.id;
    await client.query(
      `INSERT INTO events(organization_id,site_id,camera_id,event_type,severity,confidence,status)
       VALUES ($1,$2,$3,'PERSON_DETECTION','HIGH',0.94,'OPEN'),
              ($1,$2,$3,'HELMET_DETECTION','MEDIUM',0.81,'ACKNOWLEDGED')`,
      [orgId, site, cam],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  process.stdout.write(`[seed] demo org created: slug=${config.demoOrgSlug} login=${email} / demo-password-123\n`);
  await closePools();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
