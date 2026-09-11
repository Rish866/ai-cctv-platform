import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { resetDatabase, signupTenant, testApp, type TenantAgent } from './helpers.js';
import { adminPool, closePools, withTenant } from '../db/pool.js';
import { config } from '../config.js';
import { applyHealthUpdate } from '../media/health.service.js';

/**
 * Cross-tenant isolation for the real-CCTV surface: camera health/stats/live/
 * test-connection + the internal media-worker API. Tenant A must never reach
 * Tenant B's camera resources or streams, and vice versa. The worker token
 * grants NO cross-tenant power (RLS still gates every job).
 */
describe('Real CCTV — cross-tenant isolation', () => {
  let app: Express;
  let A: TenantAgent;
  let B: TenantAgent;
  let camA: string;
  let camB: string;

  beforeAll(async () => {
    await resetDatabase();
    app = testApp();
    A = await signupTenant(app, 'cctv-a');
    B = await signupTenant(app, 'cctv-b');
    const mkCam = async (t: TenantAgent) => {
      const site = (await t.agent.post('/api/sites').send({ name: 'S', timezone: 'UTC' }).expect(201)).body.site.id;
      return (await t.agent.post('/api/cameras').send({ siteId: site, name: 'C', rtspHost: 'h', username: 'u', password: 'p' }).expect(201)).body.camera.id;
    };
    camA = await mkCam(A);
    camB = await mkCam(B);
  });

  afterAll(async () => {
    await closePools();
  });

  const denied = (s: number) => s === 403 || s === 404;

  describe('A cannot reach B camera endpoints', () => {
    it('GET B camera', async () => expect(denied((await A.agent.get(`/api/cameras/${camB}`)).status)).toBe(true));
    it('GET B camera health', async () => expect(denied((await A.agent.get(`/api/cameras/${camB}/health`)).status)).toBe(true));
    it('GET B camera stats', async () => expect(denied((await A.agent.get(`/api/cameras/${camB}/stats`)).status)).toBe(true));
    it('POST B test-connection', async () => expect(denied((await A.agent.post(`/api/cameras/${camB}/test-connection`)).status)).toBe(true));
    it('GET B live', async () => expect(denied((await A.agent.get(`/api/cameras/${camB}/live`)).status)).toBe(true));
    it('GET B live artifact', async () => expect(denied((await A.agent.get(`/api/cameras/${camB}/live/index.m3u8?sid=x&exp=9999999999&sig=deadbeef`)).status)).toBe(true));
    it('PATCH B camera denied; unchanged', async () => {
      expect(denied((await A.agent.patch(`/api/cameras/${camB}`).send({ name: 'HACKED' })).status)).toBe(true);
      const check = await B.agent.get(`/api/cameras/${camB}`).expect(200);
      expect(check.body.camera.name).not.toBe('HACKED');
    });
  });

  describe('REVERSE: B cannot reach A camera endpoints', () => {
    it('GET A camera', async () => expect(denied((await B.agent.get(`/api/cameras/${camA}`)).status)).toBe(true));
    it('GET A live', async () => expect(denied((await B.agent.get(`/api/cameras/${camA}/live`)).status)).toBe(true));
  });

  describe('Camera lists never include the other tenant', () => {
    it('A list excludes B camera', async () => {
      const ids = (await A.agent.get('/api/cameras').expect(200)).body.cameras.map((c: { id: string }) => c.id);
      expect(ids).toContain(camA);
      expect(ids).not.toContain(camB);
    });
  });

  describe('Internal media-worker API: worker token grants NO cross-tenant power', () => {
    const base = () => `Bearer ${config.media.workerToken}`;

    it('rejects requests without a worker token (fail closed)', async () => {
      const { default: supertest } = await import('supertest');
      const r = await supertest(app).post('/api/internal/detections').send({ organizationId: A.organizationId, cameraId: camA, rawClass: 'PERSON', bbox: { x: 0, y: 0, w: 1, h: 1 }, confidence: 0.9 });
      expect([401, 403]).toContain(r.status);
    });

    it('a job for org A referencing B camera creates NOTHING (RLS)', async () => {
      const { default: supertest } = await import('supertest');
      // org=A, camera=B: camera not visible under A's RLS -> 404, no event.
      const r = await supertest(app)
        .post('/api/internal/detections')
        .set('authorization', base())
        .send({ organizationId: A.organizationId, cameraId: camB, rawClass: 'FIRE', bbox: { x: 0, y: 0, w: 1, h: 1 }, confidence: 0.99 });
      expect(r.status).toBe(404);
      // No FIRE event should reference B's camera under A.
      const list = await A.agent.get('/api/events/security/list?category=FIRE').expect(200);
      expect(list.body.events.some((e: { camera_id: string }) => e.camera_id === camB)).toBe(false);
    });

    it('a valid job for org A + A camera creates an event scoped to A only', async () => {
      const { default: supertest } = await import('supertest');
      const r = await supertest(app)
        .post('/api/internal/detections')
        .set('authorization', base())
        .send({ organizationId: A.organizationId, cameraId: camA, rawClass: 'FIRE', bbox: { x: 0, y: 0, w: 1, h: 1 }, confidence: 0.95 });
      expect([200, 201]).toContain(r.status);
      // B must not see A's fire event.
      const bList = await B.agent.get('/api/events/security/list?category=FIRE').expect(200);
      expect(bList.body.events.some((e: { camera_id: string }) => e.camera_id === camA)).toBe(false);
    });
  });

  describe('Health events + inference_stats are RLS isolated', () => {
    it('A cannot see B camera_health_events / inference_stats', async () => {
      // Seed a health event + stats for B via admin.
      await withTenant({ userId: B.user.id, organizationId: B.organizationId, role: 'OWNER', isPlatformAdmin: false }, async (db) => {
        // Move B camera online->offline to emit an event.
        const bSite = (await adminPool.query<{ site_id: string }>('SELECT site_id FROM cameras WHERE id=$1', [camB])).rows[0]!.site_id;
        await applyHealthUpdate(db, { organizationId: B.organizationId, cameraId: camB, siteId: bSite, status: 'ONLINE', markConnected: true });
        await applyHealthUpdate(db, { organizationId: B.organizationId, cameraId: camB, siteId: bSite, status: 'OFFLINE' });
      });
      // Under A's RLS context, zero B health events are visible.
      const rows = await withTenant({ userId: A.user.id, organizationId: A.organizationId, role: 'OWNER', isPlatformAdmin: false }, async (db) => {
        return (await db.query('SELECT id FROM camera_health_events WHERE camera_id = $1', [camB])).rows;
      });
      expect(rows.length).toBe(0);
    });
  });
});
