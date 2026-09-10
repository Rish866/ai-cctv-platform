import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { buildResourceTree, resetDatabase, signupTenant, testApp, type TenantAgent } from './helpers.js';
import { closePools } from '../db/pool.js';
import { buildEvidenceKey, keyBelongsToOrg, signEvidenceUrl, verifyEvidenceUrl } from '../services/storage.service.js';

/**
 * STORAGE ISOLATION SUITE (spec sections 11, 50).
 * Signed evidence URLs are bound to org+key+expiry. A URL for B's object cannot
 * be used by A, and B cannot fetch A's object even with a valid-looking URL.
 */
describe('Storage / evidence isolation', () => {
  let app: Express;
  let A: TenantAgent;
  let B: TenantAgent;
  let treeA: Awaited<ReturnType<typeof buildResourceTree>>;

  beforeAll(async () => {
    await resetDatabase();
    app = testApp();
    A = await signupTenant(app, 'store-a');
    B = await signupTenant(app, 'store-b');
    treeA = await buildResourceTree(A);
  });

  afterAll(async () => {
    await closePools();
  });

  it('owner can fetch its own signed evidence object', async () => {
    const url = (await A.agent.get(`/api/events/${treeA.eventId}/evidence/${treeA.evidenceId}/url`).expect(200)).body
      .evidence.url;
    await A.agent.get(url).expect(200);
  });

  it("B cannot fetch A's object even with A's valid signed URL", async () => {
    const url = (await A.agent.get(`/api/events/${treeA.eventId}/evidence/${treeA.evidenceId}/url`).expect(200)).body
      .evidence.url;
    // B is authenticated but not a member of A's org -> 404.
    const res = await B.agent.get(url);
    expect(res.status).toBe(404);
  });

  it('a tampered org param invalidates the signature', async () => {
    const url: string = (await A.agent.get(`/api/events/${treeA.eventId}/evidence/${treeA.evidenceId}/url`).expect(200))
      .body.evidence.url;
    const tampered = url.replace(/org=[^&]+/, `org=${B.organizationId}`);
    const res = await A.agent.get(tampered);
    expect([403, 404]).toContain(res.status);
  });

  it('unit: evidence keys are org-scoped and signatures bind org+key', () => {
    const key = buildEvidenceKey({ organizationId: A.organizationId, siteId: treeA.siteId, cameraId: treeA.cameraId, eventId: treeA.eventId, filename: 'x.jpg' });
    expect(keyBelongsToOrg(key, A.organizationId)).toBe(true);
    expect(keyBelongsToOrg(key, B.organizationId)).toBe(false);

    const signed = signEvidenceUrl(A.organizationId, key);
    const exp = Number(new URLSearchParams(signed.url.split('?')[1]).get('exp'));
    const sig = new URLSearchParams(signed.url.split('?')[1]).get('sig')!;
    // Valid for A.
    expect(verifyEvidenceUrl({ organizationId: A.organizationId, storageKey: key, expiresAt: exp, token: sig })).toBe(true);
    // Not valid when claimed for B.
    expect(verifyEvidenceUrl({ organizationId: B.organizationId, storageKey: key, expiresAt: exp, token: sig })).toBe(false);
  });
});
