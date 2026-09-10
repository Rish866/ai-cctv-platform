import type { AiModelType } from './types.js';

/**
 * AI MODEL ABSTRACTION
 * ====================
 * The platform is model-agnostic. Each detection category (person, vehicle,
 * fire, smoke, object-tracking, generic security) is served by a model that
 * implements the `InferenceAdapter` interface below. Real deployments register
 * a production adapter (e.g. a GPU-backed YOLO/fire-classifier microservice)
 * per `ai_model_type`; the interface is what the pipeline calls.
 *
 * IMPORTANT (spec §37): there is NO fake AI presented as real. This module
 * ships a single, explicitly-labelled DEMO adapter used ONLY for demos/tests.
 * It is `isDemo = true`, requires the `is_demo_adapter` flag on the model row,
 * and never runs implicitly in place of a production model. If no production
 * adapter is registered for a model type, inference calls fail loudly rather
 * than silently fabricating detections.
 */

export interface DetectionInput {
  /** Raw frame bytes (e.g. JPEG). Optional for adapters that pull from a stream. */
  frame?: Buffer;
  /** Camera / zone context, so adapters can apply zone geometry. */
  cameraId: string;
  zoneId?: string | null;
  /** Confidence threshold configured for this model/rule. */
  minConfidence: number;
  /** Free-form model config (thresholds, class filters, region, etc.). */
  config?: Record<string, unknown>;
}

export interface Detection {
  label: string;
  confidence: number;
  /** Optional bounding box {x,y,w,h} in normalized [0,1] coordinates. */
  bbox?: { x: number; y: number; w: number; h: number };
  metadata?: Record<string, unknown>;
}

export interface InferenceAdapter {
  readonly modelType: AiModelType;
  readonly isDemo: boolean;
  /** Returns detections at or above minConfidence. */
  infer(input: DetectionInput): Promise<Detection[]>;
}

class ModelRegistry {
  private adapters = new Map<AiModelType, InferenceAdapter>();

  register(adapter: InferenceAdapter): void {
    this.adapters.set(adapter.modelType, adapter);
  }

  /**
   * Resolve an adapter for a model type. `allowDemo` must be explicitly true to
   * fall back to the demo adapter — production code paths pass false so a
   * missing production model surfaces as an error instead of fake output.
   */
  resolve(modelType: AiModelType, opts: { allowDemo: boolean }): InferenceAdapter {
    const adapter = this.adapters.get(modelType);
    if (adapter && !adapter.isDemo) return adapter;
    if (opts.allowDemo && adapter) return adapter;
    if (opts.allowDemo) {
      const demo = this.adapters.get(modelType);
      if (demo) return demo;
    }
    throw new Error(
      `No production inference adapter registered for model type "${modelType}". ` +
        `Register one via aiModelRegistry.register(...) or enable the demo adapter explicitly.`,
    );
  }

  has(modelType: AiModelType): boolean {
    return this.adapters.has(modelType);
  }
}

export const aiModelRegistry = new ModelRegistry();

/**
 * DEMO adapter — deterministic, clearly-labelled placeholder for sales demos and
 * automated tests. It does NOT perform real computer vision. It echoes a
 * detection derived from its input config so demo scenarios are reproducible.
 * `isDemo = true` guarantees it can never be mistaken for a production model.
 */
export class DemoAdapter implements InferenceAdapter {
  readonly isDemo = true;
  constructor(public readonly modelType: AiModelType) {}

  async infer(input: DetectionInput): Promise<Detection[]> {
    const label = String((input.config?.demoLabel as string) ?? this.modelType.toLowerCase());
    const confidence = Number((input.config?.demoConfidence as number) ?? Math.max(input.minConfidence, 0.85));
    if (confidence < input.minConfidence) return [];
    return [
      {
        label,
        confidence,
        metadata: { adapter: 'demo', modelType: this.modelType, note: 'DEMO ADAPTER — not a production model' },
      },
    ];
  }
}

/**
 * Register demo adapters for every model type. Called at startup ONLY in
 * non-production or when explicitly enabled. Production deployments overwrite
 * these by registering real adapters for the same model types.
 */
export function registerDemoAdapters(): void {
  (['PERSON', 'VEHICLE', 'FIRE', 'SMOKE', 'OBJECT_TRACKING', 'GENERIC_SECURITY'] as AiModelType[]).forEach(
    (t) => aiModelRegistry.register(new DemoAdapter(t)),
  );
}
