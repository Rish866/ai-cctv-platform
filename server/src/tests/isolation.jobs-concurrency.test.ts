import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { buildResourceTree, resetDatabase, signupTenant, testApp, type TenantAgent } from './helpers.js';
import { closePools } from '../db/pool.js';
import { processAiJob } from '../jobs/worker.js';

/**
 * BACKGROUND JOB + CONCURRENCY isolation (spec 14, 15, 38, 39).
 * Pools are shared across both describe blocks; close them once at file end.
 */
afterAll(async () => {
  await closePools();
});

describe('Background job tenant validation', () => {
  let app: Express;
  let A: TenantAgent;
  let B: TenantAgent;
  let treeA: Awaited<ReturnType<typeof buildResourceTree>>;
  let treeB: Awaited<ReturnType<typeof buildResourceTree>>;

  beforeAll(async () => {
    await resetDatabase();
    app = testApp();
    A = await signupTenant(app, 'job-a');
    B = await signupTenant(app, 'job-b');
    treeA = await buildResourceTree(A);
    treeB = await buildResourceTree(B);
  });

  it('a valid job (camera belongs to org) creates an event', async () => {
    const res = await processAiJob({
      organizationId: A.organizationId,
      cameraId: treeA.cameraId,
      eventType: 'PERSON_DETECTION',
      confidence: 0.88,
      severity: 'HIGH',
    });
    expect(res.eventId).toBeTruthy();
    expect(res.organizationId).toBe(A.organizationId);
  });

  it('a forged job (A org id + B camera id) is REJECTED and creates nothing', async () => {
    await expect(
      processAiJob({
        organizationId: A.organizationId,
        cameraId: treeB.cameraId, // camera from the OTHER tenant
        eventType: 'PERSON_DETECTION',
        confidence: 0.99,
      }),
    ).rejects.toThrow();

    // Confirm no event referencing B's camera exists under A.
    const events = await A.agent.get('/api/events').expect(200);
    const leaked = events.body.events.some((e: { camera_id: string }) => e.camera_id === treeB.cameraId);
    expect(leaked).toBe(false);
  });

  it('a job cannot smuggle B camera even claiming B org but Aoperator has no say (RLS)', async () => {
    // Even a job with B's org + A's camera is rejected: A camera not visible under B org.
    await expect(
      processAiJob({ organizationId: B.organizationId, cameraId: treeA.cameraId, eventType: 'LOITERING', confidence: 0.7 }),
    ).rejects.toThrow();
  });
});

describe('Concurrency: tenant context cannot leak between simultaneous requests', () => {
  let A: TenantAgent;
  let B: TenantAgent;
  let treeA: Awaited<ReturnType<typeof buildResourceTree>>;
  let treeB: Awaited<ReturnType<typeof buildResourceTree>>;
  let server: import('node:http').Server;

  beforeAll(async () => {
    await resetDatabase();
    // Use ONE persistent listening server so concurrent requests share it,
    // instead of supertest spinning up an ephemeral listener per call.
    const { createServer } = await import('node:http');
    server = createServer(testApp());
    await new Promise<void>((resolve) => server.listen(0, resolve));
    A = await signupTenant(server, 'conc-a');
    B = await signupTenant(server, 'conc-b');
    treeA = await buildResourceTree(A);
    treeB = await buildResourceTree(B);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // Run promises in bounded batches so we exercise real interleaving without
  // exhausting sockets/pool (which would be a test-infra artifact, not a leak).
  async function inBatches(total: number, size: number, fn: (i: number) => Promise<void>): Promise<void> {
    for (let start = 0; start < total; start += size) {
      const batch: Promise<void>[] = [];
      for (let i = start; i < Math.min(start + size, total); i++) batch.push(fn(i));
      await Promise.all(batch);
    }
  }

  it('interleaved A/B camera reads never return the wrong tenant camera', async () => {
    // Each iteration fires an A read and a B read concurrently (true interleave).
    await inBatches(40, 8, async () => {
      const [ra, rb] = await Promise.all([A.agent.get('/api/cameras'), B.agent.get('/api/cameras')]);
      const aIds = ra.body.cameras.map((c: { id: string }) => c.id);
      const bIds = rb.body.cameras.map((c: { id: string }) => c.id);
      expect(aIds).toContain(treeA.cameraId);
      expect(aIds).not.toContain(treeB.cameraId);
      expect(bIds).toContain(treeB.cameraId);
      expect(bIds).not.toContain(treeA.cameraId);
    });
  });

  it('interleaved dashboards return each tenant its own counts', async () => {
    // Give A a second site so counts differ (A=2 sites, B=1 site).
    await A.agent.post('/api/sites').send({ name: 'A-second', timezone: 'UTC' }).expect(201);
    await inBatches(20, 8, async () => {
      const [ra, rb] = await Promise.all([A.agent.get('/api/dashboard'), B.agent.get('/api/dashboard')]);
      expect(ra.body.stats.site_count).toBe(2);
      expect(rb.body.stats.site_count).toBe(1);
    });
  });
});
