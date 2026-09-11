import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { buildResourceTree, resetDatabase, signupTenant, testApp, type TenantAgent } from './helpers.js';
import { closePools } from '../db/pool.js';

/**
 * CROSS-TENANT IDOR SUITE (spec sections 8, 9, 23, 50).
 *
 * Two independent tenants each build a full resource tree, then Tenant A tries
 * to reach EVERY one of Tenant B's resources through the API using B's ids —
 * across GET/POST/PATCH/PUT/DELETE. Every attempt MUST be denied (403/404) and
 * MUST NOT return B's data. Then the reverse direction is checked.
 */
describe('Cross-tenant IDOR protection', () => {
  let app: Express;
  let A: TenantAgent;
  let B: TenantAgent;
  let treeA: Awaited<ReturnType<typeof buildResourceTree>>;
  let treeB: Awaited<ReturnType<typeof buildResourceTree>>;

  beforeAll(async () => {
    await resetDatabase();
    app = testApp();
    A = await signupTenant(app, 'abc-logistics');
    B = await signupTenant(app, 'xyz-manufacturing');
    treeA = await buildResourceTree(A);
    treeB = await buildResourceTree(B);
  });

  afterAll(async () => {
    await closePools();
  });

  // Helper: assert that a response is a denial (403 or 404), never 2xx with data.
  const denied = (status: number) => status === 403 || status === 404;

  describe('A cannot READ B resources by id (GET)', () => {
    it('site', async () => {
      const r = await A.agent.get(`/api/sites/${treeB.siteId}`);
      expect(denied(r.status)).toBe(true);
      expect(JSON.stringify(r.body)).not.toContain(treeB.siteId);
    });
    it('camera', async () => {
      const r = await A.agent.get(`/api/cameras/${treeB.cameraId}`);
      expect(denied(r.status)).toBe(true);
      expect(JSON.stringify(r.body)).not.toContain(treeB.cameraId);
    });
    it('event', async () => {
      const r = await A.agent.get(`/api/events/${treeB.eventId}`);
      expect(denied(r.status)).toBe(true);
      expect(JSON.stringify(r.body)).not.toContain(treeB.eventId);
    });
    it('evidence signed URL', async () => {
      const r = await A.agent.get(`/api/events/${treeB.eventId}/evidence/${treeB.evidenceId}/url`);
      expect(denied(r.status)).toBe(true);
    });
  });

  describe('A cannot MUTATE B resources (PATCH/DELETE/POST)', () => {
    it('PATCH B site returns denial and does not change it', async () => {
      const r = await A.agent.patch(`/api/sites/${treeB.siteId}`).send({ name: 'HACKED' });
      expect(denied(r.status)).toBe(true);
      // Verify from B's side the name is unchanged.
      const check = await B.agent.get(`/api/sites/${treeB.siteId}`).expect(200);
      expect(check.body.site.name).not.toBe('HACKED');
    });
    it('PATCH B camera denied', async () => {
      const r = await A.agent.patch(`/api/cameras/${treeB.cameraId}`).send({ name: 'HACKED' });
      expect(denied(r.status)).toBe(true);
      const check = await B.agent.get(`/api/cameras/${treeB.cameraId}`).expect(200);
      expect(check.body.camera.name).not.toBe('HACKED');
    });
    it('PATCH B event status denied', async () => {
      const r = await A.agent.patch(`/api/events/${treeB.eventId}/status`).send({ status: 'RESOLVED' });
      expect(denied(r.status)).toBe(true);
    });
    it('DELETE B camera denied and camera still exists', async () => {
      const r = await A.agent.delete(`/api/cameras/${treeB.cameraId}`);
      expect(denied(r.status)).toBe(true);
      await B.agent.get(`/api/cameras/${treeB.cameraId}`).expect(200);
    });
    it('DELETE B site denied and site still exists', async () => {
      const r = await A.agent.delete(`/api/sites/${treeB.siteId}`);
      expect(denied(r.status)).toBe(true);
      await B.agent.get(`/api/sites/${treeB.siteId}`).expect(200);
    });
    it('A cannot create a camera under B site (parent ownership enforced)', async () => {
      const r = await A.agent.post('/api/cameras').send({ siteId: treeB.siteId, name: 'evil-cam' });
      expect(denied(r.status)).toBe(true);
    });
    it('A cannot create a zone under B site', async () => {
      const r = await A.agent.post('/api/zones').send({ siteId: treeB.siteId, name: 'evil-zone' });
      expect(denied(r.status)).toBe(true);
    });
    it('A cannot create an AI rule on B camera', async () => {
      const r = await A.agent.post('/api/ai-rules').send({ cameraId: treeB.cameraId, ruleType: 'PERSON_DETECTION' });
      expect(denied(r.status)).toBe(true);
    });
    it('A cannot ingest an event against B camera', async () => {
      const r = await A.agent.post('/api/events/ingest').send({ cameraId: treeB.cameraId, eventType: 'PERSON_DETECTION', confidence: 0.9 });
      expect(denied(r.status)).toBe(true);
    });
    it('A cannot open a stream on B camera', async () => {
      const r = await A.agent.post(`/api/cameras/${treeB.cameraId}/stream`);
      expect(denied(r.status)).toBe(true);
    });
  });

  describe('List endpoints never include the other tenant', () => {
    it('A site list excludes B site', async () => {
      const r = await A.agent.get('/api/sites').expect(200);
      const ids = r.body.sites.map((s: { id: string }) => s.id);
      expect(ids).toContain(treeA.siteId);
      expect(ids).not.toContain(treeB.siteId);
    });
    it('A camera list excludes B camera', async () => {
      const r = await A.agent.get('/api/cameras').expect(200);
      const ids = r.body.cameras.map((c: { id: string }) => c.id);
      expect(ids).toContain(treeA.cameraId);
      expect(ids).not.toContain(treeB.cameraId);
    });
    it('A event list excludes B event', async () => {
      const r = await A.agent.get('/api/events').expect(200);
      const ids = r.body.events.map((e: { id: string }) => e.id);
      expect(ids).not.toContain(treeB.eventId);
    });
  });

  describe('REVERSE: B cannot reach A resources', () => {
    it('B cannot read A camera', async () => {
      const r = await B.agent.get(`/api/cameras/${treeA.cameraId}`);
      expect(denied(r.status)).toBe(true);
      expect(JSON.stringify(r.body)).not.toContain(treeA.cameraId);
    });
    it('B cannot delete A site', async () => {
      const r = await B.agent.delete(`/api/sites/${treeA.siteId}`);
      expect(denied(r.status)).toBe(true);
      await A.agent.get(`/api/sites/${treeA.siteId}`).expect(200);
    });
    it('B cannot read A event evidence', async () => {
      const r = await B.agent.get(`/api/events/${treeA.eventId}/evidence/${treeA.evidenceId}/url`);
      expect(denied(r.status)).toBe(true);
    });
  });
});
