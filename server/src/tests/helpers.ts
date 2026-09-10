import supertest from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { adminPool } from '../db/pool.js';

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
export async function signupTenant(app: Express, label: string): Promise<TenantAgent> {
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
