import type { Server } from 'node:http';
import supertest from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { adminPool } from '../db/pool.js';

/** A supertest target can be an Express app or a live http.Server. */
export type TestTarget = Express | Server;

export function testApp(): Express {
  return createApp();
}

/** Truncate all data between suites so tests are independent. */
export async function resetDatabase(): Promise<void> {
  await adminPool.query(`
    TRUNCATE TABLE
      audit_logs, invoices, subscriptions, reports, notifications, notification_rules,
      event_evidence, event_detections, events, ai_rules, camera_credentials, cameras,
      zones, sites, organization_members, sessions, organizations, users
    RESTART IDENTITY CASCADE
  `);
}

export interface TenantAgent {
  agent: supertest.Agent;
  user: { id: string; email: string };
  organizationId: string;
}

let counter = 0;

/**
 * Sign up a fresh tenant (org + owner) and return a supertest agent that carries
 * the session cookie, plus ids for the created user + org.
 */
export async function signupTenant(app: TestTarget, label: string): Promise<TenantAgent> {
  counter += 1;
  const email = `${label}-${counter}-${Date.now()}@example.com`.toLowerCase();
  const agent = supertest.agent(app);
  const res = await agent
    .post('/api/auth/signup')
    .send({
      email,
      password: 'password-123',
      fullName: `${label} Owner`,
      organizationName: `${label} Org ${counter}`,
    })
    .expect(201);
  return {
    agent,
    user: { id: res.body.user.id, email: res.body.user.email },
    organizationId: res.body.organization.organizationId,
  };
}

/** Create a full resource tree (site -> camera -> event -> evidence) for a tenant. */
export async function buildResourceTree(t: TenantAgent): Promise<{
  siteId: string;
  cameraId: string;
  eventId: string;
  evidenceId: string;
}> {
  const site = await t.agent.post('/api/sites').send({ name: 'Site', timezone: 'UTC' }).expect(201);
  const siteId = site.body.site.id;

  const cam = await t.agent
    .post('/api/cameras')
    .send({ siteId, name: 'Cam', rtspHost: 'cam.local', rtspPath: '/s1', username: 'u', password: 'p' })
    .expect(201);
  const cameraId = cam.body.camera.id;

  // 1x1 transparent PNG as fake snapshot.
  const snapshot = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ).toString('base64');

  const ev = await t.agent
    .post('/api/events/ingest')
    .send({ cameraId, eventType: 'PERSON_DETECTION', confidence: 0.9, severity: 'HIGH', snapshotBase64: snapshot })
    .expect(201);
  const eventId = ev.body.event.id;

  const detail = await t.agent.get(`/api/events/${eventId}`).expect(200);
  const evidenceId = detail.body.evidence[0]?.id;

  return { siteId, cameraId, eventId, evidenceId };
}


const SNAPSHOT_B64 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
).toString('base64');

/**
 * Build a full SAFETY & SECURITY resource set for a tenant, exercising the
 * add-on endpoints: an AI model, a zone + schedule, a camera, a monitored
 * object, an AI rule, a fire incident (via engine ingestion) + its evidence,
 * and an incident note.
 */
export async function buildSafetyTree(t: TenantAgent): Promise<{
  siteId: string;
  zoneId: string;
  cameraId: string;
  modelId: string;
  scheduleId: string;
  monitoredObjectId: string;
  ruleId: string;
  fireEventId: string;
  fireEvidenceId: string;
  noteId: string;
}> {
  const site = await t.agent.post('/api/sites').send({ name: 'Safety Site', timezone: 'UTC' }).expect(201);
  const siteId = site.body.site.id;

  const zone = await t.agent.post('/api/zones').send({ siteId, name: 'Chemical Storage', geometry: {} }).expect(201);
  const zoneId = zone.body.zone.id;

  const cam = await t.agent
    .post('/api/cameras')
    .send({ siteId, zoneId, name: 'Warehouse Cam 04', rtspHost: 'cam.local', rtspPath: '/s4', username: 'u', password: 'p' })
    .expect(201);
  const cameraId = cam.body.camera.id;

  const model = await t.agent
    .post('/api/ai-models')
    .send({ modelType: 'FIRE', name: 'Fire Model', version: 'v1', confidenceThreshold: 0.7, isDemoAdapter: true })
    .expect(201);
  const modelId = model.body.model.id;

  const schedule = await t.agent
    .post('/api/zone-schedules')
    .send({ zoneId, weekday: null, openMinute: 540, closeMinute: 1080, timezone: 'UTC' })
    .expect(201);
  const scheduleId = schedule.body.schedule.id;

  const mobj = await t.agent
    .post('/api/monitored-objects')
    .send({ cameraId, zoneId, label: 'Pallet', region: {}, confirmMs: 3000 })
    .expect(201);
  const monitoredObjectId = mobj.body.object.id;

  const rule = await t.agent
    .post('/api/ai-rules')
    .send({
      cameraId,
      zoneId,
      ruleType: 'FIRE',
      severity: 'CRITICAL',
      minConfidence: 0.7,
      cooldownSeconds: 30,
      minDurationMs: 0,
      notifyChannels: ['IN_APP', 'EMAIL'],
      aiModelId: modelId,
    })
    .expect(201);
  const ruleId = rule.body.rule.id;

  // Fire detection via the engine (creates a CRITICAL incident + evidence).
  const fire = await t.agent
    .post('/api/events/ingest')
    .send({ cameraId, eventType: 'FIRE', confidence: 0.92, snapshotBase64: SNAPSHOT_B64 })
    .expect(201);
  const fireEventId = fire.body.event.eventId;

  const detail = await t.agent.get(`/api/events/${fireEventId}`).expect(200);
  const fireEvidenceId = detail.body.evidence[0]?.id;

  const note = await t.agent.post(`/api/events/${fireEventId}/notes`).send({ note: 'Dispatched security' }).expect(201);
  const noteId = note.body.note.id;

  return { siteId, zoneId, cameraId, modelId, scheduleId, monitoredObjectId, ruleId, fireEventId, fireEvidenceId, noteId };
}
