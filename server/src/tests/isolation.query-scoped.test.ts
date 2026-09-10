import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { buildResourceTree, resetDatabase, signupTenant, testApp, type TenantAgent } from './helpers.js';
import { closePools } from '../db/pool.js';

/**
 * SEARCH / REPORT / BILLING / AUDIT isolation (spec 18, 19, 20, 21).
 * Each of these aggregate/search surfaces must only ever reflect the caller's org.
 */
describe('Search / report / billing / audit are tenant-scoped', () => {
  let app: Express;
  let A: TenantAgent;
  let B: TenantAgent;
  let treeA: Awaited<ReturnType<typeof buildResourceTree>>;
  let treeB: Awaited<ReturnType<typeof buildResourceTree>>;

  beforeAll(async () => {
    await resetDatabase();
    app = testApp();
    A = await signupTenant(app, 'q-alpha');
    B = await signupTenant(app, 'q-beta');
    // Give A a uniquely-named site and B a differently-named site.
    await A.agent.post('/api/sites').send({ name: 'AlphaUniqueSite', timezone: 'UTC' }).expect(201);
    await B.agent.post('/api/sites').send({ name: 'BetaUniqueSite', timezone: 'UTC' }).expect(201);
    treeA = await buildResourceTree(A);
    treeB = await buildResourceTree(B);
  });

  afterAll(async () => {
    await closePools();
  });

  // ---- Search ----
  it('search only returns the caller org results', async () => {
    const a = await A.agent.get('/api/search?q=UniqueSite').expect(200);
    const aNames = a.body.results.sites.map((s: { name: string }) => s.name);
    expect(aNames).toContain('AlphaUniqueSite');
    expect(aNames).not.toContain('BetaUniqueSite');

    const b = await B.agent.get('/api/search?q=UniqueSite').expect(200);
    const bNames = b.body.results.sites.map((s: { name: string }) => s.name);
    expect(bNames).toContain('BetaUniqueSite');
    expect(bNames).not.toContain('AlphaUniqueSite');
  });

  it('search results never include the other org resource ids', async () => {
    const a = await A.agent.get('/api/search?q=Site').expect(200);
    const body = JSON.stringify(a.body);
    expect(body).not.toContain(treeB.siteId);
    expect(body).not.toContain(treeB.cameraId);
  });

  // ---- Reports / analytics ----
  it('report data totals reflect only the caller org', async () => {
    // A generates a second event so its totals differ from B.
    await A.agent.post('/api/events/ingest').send({ cameraId: treeA.cameraId, eventType: 'VEHICLE_DETECTION', confidence: 0.8 }).expect(201);
    const rep = await A.agent.post('/api/reports').send({ name: 'r', kind: 'EVENT_SUMMARY', params: {} }).expect(201);
    const data = await A.agent.get(`/api/reports/${rep.body.report.id}/data`).expect(200);
    // A has exactly 1 camera + 1 site created by buildResourceTree (+1 extra site above).
    expect(data.body.totals.cameras).toBe(1);
    // total events for A = 2 (person + vehicle). B's single event must not count.
    expect(data.body.totals.total_events).toBe(2);
  });

  it('CSV export only contains caller org events', async () => {
    const a = await A.agent.get('/api/reports/export/events.csv').expect(200);
    expect(a.text).not.toContain(treeB.eventId);
    expect(a.text).toContain(treeA.eventId);
  });

  // ---- Billing ----
  it('billing subscription is per-org and cameras_used reflects own cameras', async () => {
    const a = await A.agent.get('/api/billing/subscription').expect(200);
    const b = await B.agent.get('/api/billing/subscription').expect(200);
    expect(a.body.subscription.cameras_used).toBe(1);
    expect(b.body.subscription.cameras_used).toBe(1);
    // A cannot read B invoices list content (different org rows only).
    const inv = await A.agent.get('/api/billing/invoices').expect(200);
    expect(JSON.stringify(inv.body)).not.toContain(B.organizationId);
  });

  // ---- Audit ----
  it('audit logs are tenant scoped (A sees only A actions)', async () => {
    const a = await A.agent.get('/api/audit-logs').expect(200);
    const body = JSON.stringify(a.body);
    expect(body).not.toContain(treeB.siteId);
    expect(body).not.toContain(treeB.cameraId);
    // A should have some of its own audit entries (site/camera/event creation).
    expect(a.body.auditLogs.length).toBeGreaterThan(0);
  });
});
