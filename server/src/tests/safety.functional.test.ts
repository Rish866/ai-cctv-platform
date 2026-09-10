import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { resetDatabase, signupTenant, testApp, type TenantAgent } from './helpers.js';
import { closePools } from '../db/pool.js';
import { registerDemoAdapters } from '../ai/model.js';

/**
 * Functional tests for the Safety & Security add-on. Verifies fire/smoke event
 * creation, fire+smoke correlation, alert cooldown/dedup, security event types,
 * incident lifecycle, schedules, monitored objects, and AI models — all through
 * the same tenant-scoped API + event pipeline.
 */
describe('Safety & Security — functional', () => {
  let server: Server;
  let t: TenantAgent;

  beforeAll(async () => {
    registerDemoAdapters();
    await resetDatabase();
    server = createServer(testApp());
    await new Promise<void>((r) => server.listen(0, r));
    t = await signupTenant(server, 'safety-fn');
    // This suite creates many cameras; upgrade off the 5-camera TRIAL limit.
    await t.agent.post('/api/billing/subscription/plan').send({ plan: 'ENTERPRISE' }).expect(200);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await closePools();
  });

  async function setup() {
    const site = (await t.agent.post('/api/sites').send({ name: 'S', timezone: 'UTC' }).expect(201)).body.site.id;
    const cam = (await t.agent.post('/api/cameras').send({ siteId: site, name: 'C', rtspHost: 'x', username: 'u', password: 'p' }).expect(201)).body.camera.id;
    return { site, cam };
  }

  it('creates a FIRE incident with CRITICAL severity + evidence', async () => {
    const { cam } = await setup();
    const snap = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64').toString('base64');
    const res = await t.agent.post('/api/events/ingest').send({ cameraId: cam, eventType: 'FIRE', confidence: 0.95, snapshotBase64: snap }).expect(201);
    expect(res.body.event.created).toBe(true);
    expect(res.body.event.severity).toBe('CRITICAL');
    expect(res.body.event.alerted).toBe(true);
    const detail = await t.agent.get(`/api/events/${res.body.event.eventId}`).expect(200);
    expect(detail.body.event.event_type).toBe('FIRE');
    expect(detail.body.evidence.length).toBeGreaterThan(0);
  });

  it('creates a SMOKE incident with HIGH default severity', async () => {
    const { cam } = await setup();
    const res = await t.agent.post('/api/events/ingest').send({ cameraId: cam, eventType: 'SMOKE', confidence: 0.8 }).expect(201);
    expect(res.body.event.severity).toBe('HIGH');
  });

  it('cooldown: continuous fire does NOT create a new incident every call', async () => {
    const { cam } = await setup();
    const first = await t.agent.post('/api/events/ingest').send({ cameraId: cam, eventType: 'FIRE', confidence: 0.9 }).expect(201);
    expect(first.body.event.created).toBe(true);
    // Subsequent detections within cooldown update the SAME incident, no new alert.
    const second = await t.agent.post('/api/events/ingest').send({ cameraId: cam, eventType: 'FIRE', confidence: 0.9 }).expect(200);
    expect(second.body.event.created).toBe(false);
    expect(second.body.event.eventId).toBe(first.body.event.eventId);
    expect(second.body.event.alerted).toBe(false);
    // Only one FIRE event should exist for this camera.
    const events = await t.agent.get('/api/events/security/list?category=FIRE').expect(200);
    const fireForCam = events.body.events.filter((e: { camera_id: string; event_type: string }) => e.camera_id === cam && e.event_type === 'FIRE');
    expect(fireForCam.length).toBe(1);
  });

  it('fire+smoke correlation upgrades the incident to FIRE_AND_SMOKE (CRITICAL)', async () => {
    const { cam } = await setup();
    const fire = await t.agent.post('/api/events/ingest').send({ cameraId: cam, eventType: 'FIRE', confidence: 0.9 }).expect(201);
    // Smoke on the same camera within the window + cooldown group => upgrade.
    const smoke = await t.agent.post('/api/events/ingest').send({ cameraId: cam, eventType: 'SMOKE', confidence: 0.85 });
    expect([200, 201]).toContain(smoke.status);
    expect(smoke.body.event.eventId).toBe(fire.body.event.eventId);
    expect(smoke.body.event.upgradedToFireAndSmoke).toBe(true);
    expect(smoke.body.event.eventType).toBe('FIRE_AND_SMOKE');
    const detail = await t.agent.get(`/api/events/${fire.body.event.eventId}`).expect(200);
    expect(detail.body.event.event_type).toBe('FIRE_AND_SMOKE');
    expect(detail.body.event.severity).toBe('CRITICAL');
  });

  it('security events: unauthorized entry / after-hours / object removed / unauthorized vehicle', async () => {
    const { cam } = await setup();
    for (const type of ['UNAUTHORIZED_ENTRY', 'AFTER_HOURS_ACTIVITY', 'OBJECT_REMOVED', 'UNAUTHORIZED_VEHICLE', 'RESTRICTED_ZONE_ACTIVITY']) {
      const res = await t.agent.post('/api/events/ingest').send({ cameraId: cam, eventType: type, confidence: 0.88 });
      expect([200, 201]).toContain(res.status);
      expect(res.body.event.eventType).toBe(type);
    }
    const list = await t.agent.get('/api/events/security/list?category=SECURITY').expect(200);
    const types = new Set(list.body.events.map((e: { event_type: string }) => e.event_type));
    expect(types.has('UNAUTHORIZED_ENTRY')).toBe(true);
    expect(types.has('OBJECT_REMOVED')).toBe(true);
  });

  it('false-positive control: below rule confidence threshold creates nothing', async () => {
    const { cam } = await setup();
    // Configure a rule requiring >= 0.8 confidence.
    await t.agent.post('/api/ai-rules').send({ cameraId: cam, ruleType: 'FIRE', minConfidence: 0.8, severity: 'CRITICAL' }).expect(201);
    const res = await t.agent.post('/api/events/ingest').send({ cameraId: cam, eventType: 'FIRE', confidence: 0.5 }).expect(200);
    expect(res.body.event.created).toBe(false);
    expect(res.body.event.eventId).toBe('');
  });

  it('incident lifecycle: acknowledge -> investigate -> resolve, with notes', async () => {
    const { cam } = await setup();
    const fire = (await t.agent.post('/api/events/ingest').send({ cameraId: cam, eventType: 'FIRE', confidence: 0.95 }).expect(201)).body.event;
    for (const status of ['ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED']) {
      const r = await t.agent.patch(`/api/events/${fire.eventId}/status`).send({ status }).expect(200);
      expect(r.body.event.status).toBe(status);
    }
    await t.agent.post(`/api/events/${fire.eventId}/notes`).send({ note: 'Sprinklers activated' }).expect(201);
    const notes = await t.agent.get(`/api/events/${fire.eventId}/notes`).expect(200);
    expect(notes.body.notes.length).toBeGreaterThan(0);
    // FALSE_POSITIVE status is accepted (new).
    await t.agent.patch(`/api/events/${fire.eventId}/status`).send({ status: 'FALSE_POSITIVE' }).expect(200);
  });

  it('config CRUD: ai-models, zone-schedules, monitored-objects', async () => {
    const site = (await t.agent.post('/api/sites').send({ name: 'CfgSite', timezone: 'UTC' }).expect(201)).body.site.id;
    const zone = (await t.agent.post('/api/zones').send({ siteId: site, name: 'Z', geometry: {} }).expect(201)).body.zone.id;
    const cam = (await t.agent.post('/api/cameras').send({ siteId: site, zoneId: zone, name: 'CfgCam' }).expect(201)).body.camera.id;

    const model = await t.agent.post('/api/ai-models').send({ modelType: 'FIRE', name: 'M', confidenceThreshold: 0.7, isDemoAdapter: true }).expect(201);
    expect(model.body.model.model_type).toBe('FIRE');

    const sched = await t.agent.post('/api/zone-schedules').send({ zoneId: zone, openMinute: 540, closeMinute: 1080 }).expect(201);
    expect(sched.body.schedule.zone_id).toBe(zone);

    const mo = await t.agent.post('/api/monitored-objects').send({ cameraId: cam, zoneId: zone, label: 'Asset' }).expect(201);
    expect(mo.body.object.present).toBe(true);

    // Lists return the created rows.
    expect((await t.agent.get('/api/ai-models').expect(200)).body.models.length).toBeGreaterThan(0);
    expect((await t.agent.get('/api/zone-schedules').expect(200)).body.schedules.length).toBeGreaterThan(0);
    expect((await t.agent.get('/api/monitored-objects').expect(200)).body.objects.length).toBeGreaterThan(0);
  });

  it('reports: fire-safety and security report data are available + tenant scoped', async () => {
    const fire = await t.agent.get('/api/reports/fire-safety/data').expect(200);
    expect(fire.body.totals).toHaveProperty('fire_events');
    const sec = await t.agent.get('/api/reports/security/data').expect(200);
    expect(sec.body.totals).toHaveProperty('unauthorized_entries');
    const dash = await t.agent.get('/api/dashboard/security').expect(200);
    expect(dash.body.stats).toHaveProperty('fire_today');
  });
});
