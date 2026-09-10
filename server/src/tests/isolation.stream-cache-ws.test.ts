import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { buildResourceTree, resetDatabase, signupTenant, testApp, type TenantAgent } from './helpers.js';
import { closePools } from '../db/pool.js';
import { createStreamSession, verifyStreamToken } from '../services/stream.service.js';
import { _cacheClear, _cacheKeys, cacheGet, cacheSet, tenantKey } from '../services/cache.service.js';
import { _resetHub, _subscriberCount, publishTenantEvent, subscribe } from '../realtime/hub.js';

describe('Stream / cache / websocket isolation', () => {
  let app: Express;
  let A: TenantAgent;
  let B: TenantAgent;
  let treeA: Awaited<ReturnType<typeof buildResourceTree>>;
  let treeB: Awaited<ReturnType<typeof buildResourceTree>>;

  beforeAll(async () => {
    await resetDatabase();
    app = testApp();
    A = await signupTenant(app, 'stream-a');
    B = await signupTenant(app, 'stream-b');
    treeA = await buildResourceTree(A);
    treeB = await buildResourceTree(B);
  });

  afterAll(async () => {
    await closePools();
  });

  // ---- Stream (spec 13) ----
  it('owner can create a stream session for its own camera', async () => {
    const r = await A.agent.post(`/api/cameras/${treeA.cameraId}/stream`).expect(200);
    expect(r.body.stream.playbackUrl).toContain('/api/streams/playback');
    // Never exposes raw rtsp or credentials.
    expect(JSON.stringify(r.body)).not.toMatch(/rtsp:\/\//);
    expect(JSON.stringify(r.body).toLowerCase()).not.toContain('password');
  });

  it('A cannot create a stream session for B camera', async () => {
    const r = await A.agent.post(`/api/cameras/${treeB.cameraId}/stream`);
    expect([403, 404]).toContain(r.status);
  });

  it('unit: a stream token for one camera does not validate for another', () => {
    const s = createStreamSession({ organizationId: A.organizationId, cameraId: treeA.cameraId, siteId: treeA.siteId });
    expect(verifyStreamToken({ organizationId: A.organizationId, cameraId: treeA.cameraId, siteId: treeA.siteId, sessionId: s.sessionId, expiresAt: s.expiresAt, token: s.token })).toBe(true);
    // Swap in B's camera id -> signature no longer matches.
    expect(verifyStreamToken({ organizationId: A.organizationId, cameraId: treeB.cameraId, siteId: treeA.siteId, sessionId: s.sessionId, expiresAt: s.expiresAt, token: s.token })).toBe(false);
  });

  // ---- Cache (spec 16) ----
  it('cache keys are tenant-namespaced and never collide', () => {
    _cacheClear();
    cacheSet(A.organizationId, 'dashboard_stats', { cameras: 5 });
    cacheSet(B.organizationId, 'dashboard_stats', { cameras: 99 });
    expect(cacheGet<{ cameras: number }>(A.organizationId, 'dashboard_stats')?.cameras).toBe(5);
    expect(cacheGet<{ cameras: number }>(B.organizationId, 'dashboard_stats')?.cameras).toBe(99);
    // Keys carry the tenant prefix.
    expect(tenantKey(A.organizationId, 'dashboard_stats')).toBe(`tenant:${A.organizationId}:dashboard_stats`);
    for (const k of _cacheKeys()) expect(k.startsWith('tenant:')).toBe(true);
  });

  it('cache: A cannot read B namespace value', () => {
    _cacheClear();
    cacheSet(B.organizationId, 'secret', { v: 'b-only' });
    expect(cacheGet(A.organizationId, 'secret')).toBeUndefined();
  });

  // ---- WebSocket hub (spec 17) ----
  it('publishTenantEvent only reaches the target org subscribers', () => {
    _resetHub();
    const receivedA: string[] = [];
    const receivedB: string[] = [];
    const fakeA = { readyState: 1, send: (d: string) => receivedA.push(d) } as unknown as import('ws').WebSocket;
    const fakeB = { readyState: 1, send: (d: string) => receivedB.push(d) } as unknown as import('ws').WebSocket;
    subscribe(A.organizationId, fakeA);
    subscribe(B.organizationId, fakeB);

    publishTenantEvent(A.organizationId, { type: 'event.created', payload: { secret: 'for-A' } });
    expect(_subscriberCount(A.organizationId)).toBe(1);
    expect(receivedA.length).toBe(1);
    // B must receive NOTHING from A's publish.
    expect(receivedB.length).toBe(0);
    expect(receivedA[0]).toContain(A.organizationId);
    expect(receivedA[0]).not.toContain('for-B');
  });
});
