import { config } from '../config.js';
import type { AiModelType } from './types.js';
import { aiModelRegistry, type Detection, type DetectionInput, type InferenceAdapter } from './model.js';

/**
 * ProductionInferenceAdapter — calls the real Python inference microservice
 * (see inference-service/) over HTTP. Performs NO detection itself; it forwards
 * a frame and returns whatever the model produced.
 *
 * Fail-closed contract (spec §11, §31, §37): if the service is unreachable, times
 * out, or errors, this THROWS an InferenceUnavailableError — it NEVER fabricates
 * detections and NEVER silently falls back to the demo adapter. Infrastructure
 * failures are surfaced as INFERENCE_UNAVAILABLE, not as fake "fire detected".
 */
export class InferenceUnavailableError extends Error {
  readonly code = 'INFERENCE_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'InferenceUnavailableError';
  }
}

interface ServiceDetection {
  class: string;
  confidence: number;
  bbox?: { x: number; y: number; width: number; height: number };
}
interface ServiceResponse {
  model: string;
  modelVersion: string;
  inferenceMs: number;
  detections: ServiceDetection[];
}

// Map our model types to the inference service's model keyword.
const MODEL_KEYWORD: Record<AiModelType, string> = {
  PERSON: 'general',
  VEHICLE: 'general',
  GENERIC_SECURITY: 'general',
  OBJECT_TRACKING: 'general',
  FIRE: 'fire',
  SMOKE: 'fire',
};

export class ProductionInferenceAdapter implements InferenceAdapter {
  readonly isDemo = false;

  constructor(
    public readonly modelType: AiModelType,
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async infer(input: DetectionInput): Promise<Detection[]> {
    if (!input.frame || input.frame.length === 0) {
      throw new InferenceUnavailableError('No frame provided to inference adapter');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const form = new FormData();
      const blob = new Blob([new Uint8Array(input.frame)], { type: 'image/jpeg' });
      form.append('frame', blob, 'frame.jpg');
      form.append('model', MODEL_KEYWORD[this.modelType] ?? 'general');
      form.append('min_confidence', String(input.minConfidence ?? 0.5));

      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/infer`, {
        method: 'POST',
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new InferenceUnavailableError(`Inference service returned HTTP ${res.status}`);
      }
      const data = (await res.json()) as ServiceResponse;
      if (!data || !Array.isArray(data.detections)) {
        throw new InferenceUnavailableError('Malformed inference response');
      }
      return data.detections.map((d) => ({
        label: d.class,
        confidence: d.confidence,
        bbox: d.bbox ? { x: d.bbox.x, y: d.bbox.y, w: d.bbox.width, h: d.bbox.height } : undefined,
        metadata: { model: data.model, modelVersion: data.modelVersion, inferenceMs: data.inferenceMs },
      }));
    } catch (err) {
      if (err instanceof InferenceUnavailableError) throw err;
      const reason = (err as Error).name === 'AbortError' ? 'timed out' : String((err as Error).message);
      throw new InferenceUnavailableError(`Inference service unavailable (${reason})`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Liveness check against the service /ready endpoint. */
  async ready(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/ready`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Register production adapters for every model type against the configured
 * inference service. Called at startup ONLY when a service URL is configured.
 * In production, the demo adapters are NOT registered (see index.ts), so if this
 * is not called the pipeline fails closed rather than using demo output.
 */
export function registerProductionAdapters(): void {
  const url = config.inference.serviceUrl;
  if (!url) return;
  (['PERSON', 'VEHICLE', 'FIRE', 'SMOKE', 'OBJECT_TRACKING', 'GENERIC_SECURITY'] as AiModelType[]).forEach((t) =>
    aiModelRegistry.register(new ProductionInferenceAdapter(t, url, config.inference.timeoutMs)),
  );
}
