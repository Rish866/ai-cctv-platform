import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { buildResourceTree, resetDatabase, signupTenant, testApp } from './helpers.js';
import { closePools } from '../db/pool.js';

describe('smoke: full stack end-to-end', () => {
  let app: Express;

  beforeAll(async () => {
    await resetDatabase();
    app = testApp();
  });

  afterAll(async () => {
    await closePools();
  });

  it('health check works', async () => {
    const { default: supertest } = await import('supertest');
    const res = await supertest(app).get('/api/health').expect(200);
    expect(res.body.ok).toBe(true);
  });

  it('a tenant can sign up, build a resource tree, and read its own data', async () => {
    const t = await signupTenant(app, 'smoke');
    const tree = await buildResourceTree(t);

    expect(tree.siteId).toBeTruthy();
    expect(tree.cameraId).toBeTruthy();
    expect(tree.eventId).toBeTruthy();
    expect(tree.evidenceId).toBeTruthy();

    // Dashboard reflects the tenant's own counts.
    const dash = await t.agent.get('/api/dashboard').expect(200);
    expect(dash.body.stats.total_cameras).toBe(1);
    expect(dash.body.stats.site_count).toBe(1);

    // Camera response must NOT include credentials.
    const cam = await t.agent.get(`/api/cameras/${tree.cameraId}`).expect(200);
    expect(cam.body.camera).not.toHaveProperty('username_enc');
    expect(cam.body.camera).not.toHaveProperty('password_enc');
    expect(JSON.stringify(cam.body)).not.toContain('password');

    // Evidence signed URL works for the owner.
    const url = await t.agent
      .get(`/api/events/${tree.eventId}/evidence/${tree.evidenceId}/url`)
      .expect(200);
    expect(url.body.evidence.url).toContain('/api/storage/object');

    // The signed object is fetchable by the owner.
    await t.agent.get(url.body.evidence.url).expect(200);
  });
});
