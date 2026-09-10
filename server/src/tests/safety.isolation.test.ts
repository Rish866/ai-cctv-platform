import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { afterAll as fileAfterAll } from 'vitest';
import { buildSafetyTree, resetDatabase, signupTenant, testApp, type TenantAgent } from './helpers.js';
import { closePools } from '../db/pool.js';
import { registerDemoAdapters } from '../ai/model.js';

// Pools are module-level singletons shared by both describe blocks — close once.
fileAfterAll(async () => {
  await closePools();
});

/**
 * CROSS-TENANT ATTACK SUITE for the Safety & Security add-on (spec §27, §34).
 * Two tenants each build fire/security resources; Tenant A attacks EVERY one of
 * Tenant B's new resources (and vice versa). Every attempt must be denied
 * (403/404) with no data leakage.
 */
describe('Safety & Security — cross-tenant isolation', () => {
  let app: Express;
  let A: TenantAgent;
  let B: TenantAgent;
  let treeA: Awaited<ReturnType<typeof buildSafetyTree>>;
  let treeB: Awaited<ReturnType<typeof buildSafetyTree>>;

  beforeAll(async () => {
    registerDemoAdapters();
    await resetDatabase();
    app = testApp();
    A = await signupTenant(app, 'safety-a');
    B = await signupTenant(app, 'safety-b');
    treeA = await buildSafetyTree(A);
    treeB = await buildSafetyTree(B);
  });

  const denied = (s: number) => s === 403 || s === 404;

  describe('A cannot READ B safety/security resources', () => {
    it('B fire event by id', async () => {
      const r = await A.agent.get(`/api/events/${treeB.fireEventId}`);
      expect(denied(r.status)).toBe(true);
      expect(JSON.stringify(r.body)).not.toContain(treeB.fireEventId);
    });
    it('B fire evidence signed URL', async () => {
      const r = await A.agent.get(`/api/events/${treeB.fireEventId}/evidence/${treeB.fireEvidenceId}/url`);
      expect(denied(r.status)).toBe(true);
    });
    it('B incident notes', async () => {
      const r = await A.agent.get(`/api/events/${treeB.fireEventId}/notes`);
      expect(denied(r.status)).toBe(true);
    });
    it('B ai-model by id', async () => {
      // No GET :id for models; verify list excludes B model + IDOR via rule create.
      const list = await A.agent.get('/api/ai-models').expect(200);
      expect(JSON.stringify(list.body)).not.toContain(treeB.modelId);
    });
  });

  describe('A security-events feed excludes B events', () => {
    it('security list has none of B ids', async () => {
      const r = await A.agent.get('/api/events/security/list').expect(200);
      const body = JSON.stringify(r.body);
      expect(body).not.toContain(treeB.fireEventId);
      expect(body).not.toContain(treeB.cameraId);
      expect(body).not.toContain(treeB.siteId);
    });
    it('A only sees its own fire event', async () => {
      const r = await A.agent.get('/api/events/security/list?category=FIRE').expect(200);
      const ids = r.body.events.map((e: { id: string }) => e.id);
      expect(ids).toContain(treeA.fireEventId);
      expect(ids).not.toContain(treeB.fireEventId);
    });
  });

  describe('A cannot MUTATE B safety/security resources', () => {
    it('PATCH B fire event status denied; B event unchanged', async () => {
      const r = await A.agent.patch(`/api/events/${treeB.fireEventId}/status`).send({ status: 'FALSE_POSITIVE' });
      expect(denied(r.status)).toBe(true);
      const check = await B.agent.get(`/api/events/${treeB.fireEventId}`).expect(200);
      expect(check.body.event.status).not.toBe('FALSE_POSITIVE');
    });
    it('POST note on B incident denied', async () => {
      const r = await A.agent.post(`/api/events/${treeB.fireEventId}/notes`).send({ note: 'intrusion' });
      expect(denied(r.status)).toBe(true);
    });
    it('DELETE B ai-model denied; model still exists for B', async () => {
      const r = await A.agent.delete(`/api/ai-models/${treeB.modelId}`);
      expect(denied(r.status)).toBe(true);
      const bModels = await B.agent.get('/api/ai-models').expect(200);
      expect(bModels.body.models.map((m: { id: string }) => m.id)).toContain(treeB.modelId);
    });
    it('DELETE B zone-schedule denied', async () => {
      const r = await A.agent.delete(`/api/zone-schedules/${treeB.scheduleId}`);
      expect(denied(r.status)).toBe(true);
    });
    it('DELETE B monitored-object denied', async () => {
      const r = await A.agent.delete(`/api/monitored-objects/${treeB.monitoredObjectId}`);
      expect(denied(r.status)).toBe(true);
    });
    it('DELETE B ai-rule denied; rule still exists for B', async () => {
      const r = await A.agent.delete(`/api/ai-rules/${treeB.ruleId}`);
      expect(denied(r.status)).toBe(true);
      const bRules = await B.agent.get('/api/ai-rules').expect(200);
      expect(bRules.body.rules.map((x: { id: string }) => x.id)).toContain(treeB.ruleId);
    });
    it('A cannot create a rule referencing B camera', async () => {
      const r = await A.agent.post('/api/ai-rules').send({ cameraId: treeB.cameraId, ruleType: 'FIRE' });
      expect(denied(r.status)).toBe(true);
    });
    it('A cannot create a schedule on B zone', async () => {
      const r = await A.agent.post('/api/zone-schedules').send({ zoneId: treeB.zoneId, openMinute: 0, closeMinute: 100 });
      expect(denied(r.status)).toBe(true);
    });
    it('A cannot create a monitored-object on B camera', async () => {
      const r = await A.agent.post('/api/monitored-objects').send({ cameraId: treeB.cameraId, label: 'x' });
      expect(denied(r.status)).toBe(true);
    });
    it('A cannot ingest a FIRE event against B camera', async () => {
      const r = await A.agent.post('/api/events/ingest').send({ cameraId: treeB.cameraId, eventType: 'FIRE', confidence: 0.99 });
      expect(denied(r.status)).toBe(true);
    });
    it('A cannot attach an A rule to a B ai-model', async () => {
      const r = await A.agent.post('/api/ai-rules').send({ cameraId: treeA.cameraId, ruleType: 'SMOKE', aiModelId: treeB.modelId });
      expect(denied(r.status)).toBe(true);
    });
  });

  describe('Data leakage: A safety endpoints contain zero B identifiers', () => {
    const endpoints = [
      '/api/ai-models',
      '/api/zone-schedules',
      '/api/monitored-objects',
      '/api/ai-rules',
      '/api/events/security/list',
      '/api/dashboard/security',
      '/api/reports/fire-safety/data',
      '/api/reports/security/data',
    ];
    it('no B id leaks into any A safety endpoint', async () => {
      const bIds = [treeB.modelId, treeB.scheduleId, treeB.monitoredObjectId, treeB.ruleId, treeB.fireEventId, treeB.cameraId, treeB.siteId, treeB.zoneId, B.organizationId];
      for (const ep of endpoints) {
        const r = await A.agent.get(ep).expect(200);
        const body = JSON.stringify(r.body);
        for (const id of bIds) expect(body.includes(id), `${ep} leaked ${id}`).toBe(false);
      }
    });
  });

  describe('REVERSE: B cannot reach A safety/security resources', () => {
    it('B cannot read A fire event', async () => {
      const r = await B.agent.get(`/api/events/${treeA.fireEventId}`);
      expect(denied(r.status)).toBe(true);
    });
    it('B cannot delete A ai-rule', async () => {
      const r = await B.agent.delete(`/api/ai-rules/${treeA.ruleId}`);
      expect(denied(r.status)).toBe(true);
      const aRules = await A.agent.get('/api/ai-rules').expect(200);
      expect(aRules.body.rules.map((x: { id: string }) => x.id)).toContain(treeA.ruleId);
    });
    it('B cannot obtain A fire evidence URL', async () => {
      const r = await B.agent.get(`/api/events/${treeA.fireEventId}/evidence/${treeA.fireEvidenceId}/url`);
      expect(denied(r.status)).toBe(true);
    });
  });
});


describe('Safety & Security — background job tenant validation', () => {
  let app: Express;
  let A: TenantAgent;
  let B: TenantAgent;
  let treeA: Awaited<ReturnType<typeof buildSafetyTree>>;
  let treeB: Awaited<ReturnType<typeof buildSafetyTree>>;

  beforeAll(async () => {
    registerDemoAdapters();
    await resetDatabase();
    app = testApp();
    A = await signupTenant(app, 'safejob-a');
    B = await signupTenant(app, 'safejob-b');
    treeA = await buildSafetyTree(A);
    treeB = await buildSafetyTree(B);
  });

  it('a valid FIRE job (camera belongs to org) creates a critical incident', async () => {
    const { processAiJob } = await import('../jobs/worker.js');
    const r = await processAiJob({ organizationId: A.organizationId, cameraId: treeA.cameraId, eventType: 'FIRE', confidence: 0.95 });
    expect(r.eventId).toBeTruthy();
    expect(r.organizationId).toBe(A.organizationId);
  });

  it('a forged FIRE job (A org + B camera) is REJECTED and creates nothing', async () => {
    const { processAiJob } = await import('../jobs/worker.js');
    await expect(
      processAiJob({ organizationId: A.organizationId, cameraId: treeB.cameraId, eventType: 'FIRE', confidence: 0.99 }),
    ).rejects.toThrow();
    // No fire event referencing B's camera should exist under A.
    const list = await A.agent.get('/api/events/security/list?category=FIRE').expect(200);
    expect(list.body.events.some((e: { camera_id: string }) => e.camera_id === treeB.cameraId)).toBe(false);
  });
});
