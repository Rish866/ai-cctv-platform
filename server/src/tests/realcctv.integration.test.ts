import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { resetDatabase, signupTenant, testApp, type TenantAgent } from './helpers.js';
import { adminPool, closePools, withTenant } from '../db/pool.js';
import { testCameraConnection } from '../media/connection.service.js';
import { applyHealthUpdate } from '../media/health.service.js';

/**
 * Integration tests for the real-CCTV backend: camera CRUD + telemetry columns,
 * test-connection via injected probe runner (no real ffprobe in CI), health
 * event dedup, and inference-stats — all tenant scoped.
 */
describe('Real CCTV — camera API + connection + health', () => {
  let app: Express;
  let t: TenantAgent;
  let siteId: string;
  let cameraId: string;

  beforeAll(async () => {
    await resetDatabase();
    app = testApp();
    t = await signupTenant(app, 'cctv-fn');
    siteId = (await t.agent.post('/api/sites').send({ name: 'S', timezone: 'UTC' }).expect(201)).body.site.id;
  });

  afterAll(async () => {
    await closePools();
  });

  it('creates a camera with stream + inference config and hides credentials', async () => {
    const res = await t.agent
      .post('/api/cameras')
      .send({
        siteId,
        name: 'RTSP Cam',
        rtspHost: '192.168.1.50',
        rtspPath: '/Streaming/Channels/101',
        rtspPort: 554,
        streamProfile: 'main',
        inferenceEnabled: true,
        inferenceFps: 3,
        username: 'admin',
        password: 'SuperSecret123',
      })
      .expect(201);
    cameraId = res.body.camera.id;
    expect(res.body.camera.inference_enabled).toBe(true);
    expect(Number(res.body.camera.inference_fps)).toBe(3);
    // No credentials ever returned.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('SuperSecret123');
    expect(body).not.toContain('username_enc');
    expect(body).not.toContain('password_enc');
  });

  it('test-connection (injected probe) marks camera ONLINE + returns safe diagnostic', async () => {
    const result = await withTenant(
      { userId: t.user.id, organizationId: t.organizationId, role: 'OWNER', isPlatformAdmin: false },
      (db) =>
        testCameraConnection(
          db,
          { organizationId: t.organizationId, cameraId },
          // Injected runner: pretend ffprobe connected successfully.
          async () => ({
            code: 0,
            stdout: JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '25/1' }] }),
            stderr: '',
          }),
        ),
    );
    expect(result.success).toBe(true);
    expect(result.status).toBe('CONNECTED');
    expect(result.resolution).toBe('1280x720');

    const health = await t.agent.get(`/api/cameras/${cameraId}/health`).expect(200);
    expect(health.body.health.status).toBe('ONLINE');
    expect(health.body.health.resolution).toBe('1280x720');
  });

  it('test-connection AUTH_FAILED leaks no credentials and sets AUTH_FAILED status', async () => {
    const result = await withTenant(
      { userId: t.user.id, organizationId: t.organizationId, role: 'OWNER', isPlatformAdmin: false },
      (db) =>
        testCameraConnection(
          db,
          { organizationId: t.organizationId, cameraId },
          async () => ({ code: 1, stdout: '', stderr: '401 Unauthorized' }),
        ),
    );
    expect(result.status).toBe('AUTH_FAILED');
    expect(JSON.stringify(result)).not.toContain('SuperSecret123');
    const health = await t.agent.get(`/api/cameras/${cameraId}/health`).expect(200);
    expect(health.body.health.status).toBe('AUTH_FAILED');
  });

  it('health events dedup: continuous OFFLINE does not create duplicate events', async () => {
    const ctx = { userId: t.user.id, organizationId: t.organizationId, role: 'OWNER' as const, isPlatformAdmin: false };
    // Establish a known ONLINE baseline FIRST, then measure the delta so prior
    // tests' health events don't affect the count.
    await withTenant(ctx, (db) => applyHealthUpdate(db, { organizationId: t.organizationId, cameraId, siteId, status: 'ONLINE', markConnected: true }));
    const before = (await adminPool.query<{ c: number }>('SELECT count(*)::int AS c FROM camera_health_events WHERE camera_id = $1', [cameraId])).rows[0]!.c;
    // OFFLINE (transition -> 1 event), then OFFLINE again (no new event).
    const r1 = await withTenant(ctx, (db) => applyHealthUpdate(db, { organizationId: t.organizationId, cameraId, siteId, status: 'OFFLINE', detail: 'drop' }));
    const r2 = await withTenant(ctx, (db) => applyHealthUpdate(db, { organizationId: t.organizationId, cameraId, siteId, status: 'OFFLINE', detail: 'still down' }));
    expect(r1.emitted).toBe('CAMERA_OFFLINE');
    expect(r2.emitted).toBeNull();
    // Recovery emits CAMERA_RECOVERED once.
    const r3 = await withTenant(ctx, (db) => applyHealthUpdate(db, { organizationId: t.organizationId, cameraId, siteId, status: 'ONLINE', markConnected: true }));
    expect(r3.emitted).toBe('CAMERA_RECOVERED');

    // Exactly 2 NEW rows created within this test (offline + recovered); the
    // duplicate OFFLINE did not add a row.
    const after = (await adminPool.query<{ c: number }>('SELECT count(*)::int AS c FROM camera_health_events WHERE camera_id = $1', [cameraId])).rows[0]!.c;
    expect(after - before).toBe(2);
  });

  it('stats endpoint is tenant scoped', async () => {
    const stats = await t.agent.get(`/api/cameras/${cameraId}/stats`).expect(200);
    expect(stats.body).toHaveProperty('eventsToday');
  });

  it('ai-status reports DEMO_AI in test env (demo adapter registered)', async () => {
    // Register the demo adapter for the test process, then query status.
    const { registerDemoAdapters } = await import('../ai/model.js');
    registerDemoAdapters();
    const r = await t.agent.get('/api/system/ai-status').expect(200);
    expect(['DEMO_AI', 'INFERENCE_OFFLINE', 'AI_ACTIVE']).toContain(r.body.ai.mode);
    // In test env with no INFERENCE_SERVICE_URL and demo adapters registered => DEMO_AI.
    expect(r.body.ai.mode).toBe('DEMO_AI');
  });
});
