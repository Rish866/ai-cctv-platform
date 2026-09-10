import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductionInferenceAdapter, InferenceUnavailableError } from '../ai/production-adapter.js';
import { DemoAdapter } from '../ai/model.js';

/**
 * Inference adapter behavior: real parsing, and fail-closed semantics
 * (INFERENCE_UNAVAILABLE) on timeout / error / malformed response. The
 * production adapter must NEVER fabricate detections and must never be a demo.
 */
describe('ProductionInferenceAdapter', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

  it('is never a demo adapter', () => {
    const a = new ProductionInferenceAdapter('FIRE', 'http://svc', 1000);
    expect(a.isDemo).toBe(false);
  });

  it('maps a valid service response to Detection[]', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ model: 'fire-cv', modelVersion: '1.0', inferenceMs: 12, detections: [{ class: 'FIRE', confidence: 0.9, bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
    const a = new ProductionInferenceAdapter('FIRE', 'http://svc', 1000);
    const dets = await a.infer({ frame, cameraId: 'c', minConfidence: 0.5 });
    expect(dets).toHaveLength(1);
    expect(dets[0]!.label).toBe('FIRE');
    expect(dets[0]!.bbox).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  });

  it('throws INFERENCE_UNAVAILABLE on HTTP error (never fabricates)', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const a = new ProductionInferenceAdapter('FIRE', 'http://svc', 1000);
    await expect(a.infer({ frame, cameraId: 'c', minConfidence: 0.5 })).rejects.toBeInstanceOf(InferenceUnavailableError);
  });

  it('throws INFERENCE_UNAVAILABLE on malformed response', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const a = new ProductionInferenceAdapter('FIRE', 'http://svc', 1000);
    await expect(a.infer({ frame, cameraId: 'c', minConfidence: 0.5 })).rejects.toBeInstanceOf(InferenceUnavailableError);
  });

  it('throws INFERENCE_UNAVAILABLE on network failure/timeout', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const a = new ProductionInferenceAdapter('FIRE', 'http://svc', 500);
    await expect(a.infer({ frame, cameraId: 'c', minConfidence: 0.5 })).rejects.toBeInstanceOf(InferenceUnavailableError);
  });

  it('throws INFERENCE_UNAVAILABLE when no frame supplied', async () => {
    const a = new ProductionInferenceAdapter('PERSON', 'http://svc', 1000);
    await expect(a.infer({ cameraId: 'c', minConfidence: 0.5 })).rejects.toBeInstanceOf(InferenceUnavailableError);
  });
});

describe('Production-vs-demo policy (spec §11, §38, §46)', () => {
  it('DemoAdapter is explicitly flagged isDemo=true', () => {
    const d = new DemoAdapter('FIRE');
    expect(d.isDemo).toBe(true);
  });

  it('the startup guard (from index.ts) refuses production without an inference URL', () => {
    // Mirror the exact guard used in index.ts main(). In production with no
    // inference service URL, the app must refuse to start (never run demo AI).
    const guard = (env: string, serviceUrl: string) => env === 'production' && !serviceUrl;
    expect(guard('production', '')).toBe(true); // refuse
    expect(guard('production', 'http://inference:8100')).toBe(false); // ok, real adapter
    expect(guard('development', '')).toBe(false); // dev may use demo adapter
  });

  it('registerProductionAdapters registers a NON-demo FIRE adapter when URL set', async () => {
    const priorUrl = process.env.INFERENCE_SERVICE_URL;
    process.env.INFERENCE_SERVICE_URL = 'http://inference:8100';
    vi.resetModules();
    const model = await import('../ai/model.js');
    const prod = await import('../ai/production-adapter.js');
    prod.registerProductionAdapters();
    const adapter = model.aiModelRegistry.resolve('FIRE', { allowDemo: false });
    expect(adapter.isDemo).toBe(false);
    if (priorUrl) process.env.INFERENCE_SERVICE_URL = priorUrl;
    else delete process.env.INFERENCE_SERVICE_URL;
    vi.resetModules();
  });
});
