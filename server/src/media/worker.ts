import { config } from '../config.js';
import { adminPool } from '../db/pool.js';
import { decryptSecret } from '../lib/crypto.js';
import { FrameSource } from './frame-source.js';
import { buildRedactedRtspUrl } from './rtsp.js';

/**
 * Media worker orchestrator.
 *
 * Runs as a SEPARATE process from the API (see media-worker.entry.ts) so heavy
 * FFmpeg/inference work never blocks HTTP. Per camera it:
 *   1. loads enabled cameras (trusted server process, admin DB) + decrypts creds,
 *   2. runs one FrameSource (FFmpeg) sampling frames at the camera's inference_fps,
 *   3. sends each sampled frame to the inference service,
 *   4. posts detections to the API internal endpoint (which re-validates tenant
 *      ownership under RLS via the worker token),
 *   5. reports health + telemetry, with exponential-backoff reconnect on failure.
 *
 * Credentials are decrypted only here (server-side) and never logged — only the
 * redacted RTSP form appears in logs.
 */

interface CameraRow {
  id: string;
  organization_id: string;
  site_id: string;
  rtsp_host: string | null;
  rtsp_path: string | null;
  rtsp_port: number;
  inference_enabled: boolean;
  inference_fps: number;
  enabled: boolean;
  source_kind: string;
  video_file?: string | null;
}

class CameraPipeline {
  private source: FrameSource | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private inFlight = false;
  private frames = 0;
  private detections = 0;
  private failures = 0;
  private latencies: number[] = [];
  private statsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly cam: CameraRow,
    private readonly creds: { username?: string; password?: string },
  ) {}

  private log(msg: string): void {
    // Structured, credential-safe log line.
    process.stdout.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        worker: 'media',
        organizationId: this.cam.organization_id,
        cameraId: this.cam.id,
        siteId: this.cam.site_id,
        source: this.redacted(),
        msg,
      }) + '\n',
    );
  }

  private redacted(): string {
    if (this.cam.source_kind === 'VIDEO_FILE_TEST_SOURCE') return `file:${this.cam.video_file ?? ''}`;
    return this.cam.rtsp_host
      ? buildRedactedRtspUrl({ host: this.cam.rtsp_host, port: this.cam.rtsp_port, path: this.cam.rtsp_path, username: this.creds.username })
      : 'unknown';
  }

  start(): void {
    if (this.stopped) return;
    void this.reportHealth('CONNECTING');
    const fps = Number(this.cam.inference_fps) || config.media.defaultInferenceFps;
    const useFile =
      this.cam.source_kind === 'VIDEO_FILE_TEST_SOURCE' &&
      config.media.allowVideoFileSource &&
      Boolean(this.cam.video_file);

    this.source = new FrameSource({
      label: this.cam.id,
      fps,
      videoFile: useFile ? this.cam.video_file ?? undefined : undefined,
      target: useFile
        ? undefined
        : {
            host: this.cam.rtsp_host ?? '',
            port: this.cam.rtsp_port,
            path: this.cam.rtsp_path,
            username: this.creds.username,
            password: this.creds.password,
          },
    });

    this.source.on('frame', (jpeg: Buffer) => void this.onFrame(jpeg));
    this.source.on('error', (m: string) => this.log(`ffmpeg error: ${m}`));
    this.source.on('exit', (info) => {
      this.log(`stream exited: ${info.reason}`);
      void this.reportHealth('OFFLINE', info.reason, { incrementReconnect: true });
      this.scheduleReconnect();
    });

    this.source.start();
    this.reconnectAttempts = 0;
    this.log('stream started');

    // Periodic stats flush.
    this.statsTimer = setInterval(() => void this.flushStats(), 15_000);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectAttempts += 1;
    const base = config.media.reconnectBaseMs;
    const max = config.media.reconnectMaxMs;
    const delay = Math.min(max, base * 2 ** Math.min(this.reconnectAttempts - 1, 6));
    void this.reportHealth('RECONNECTING', `reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      if (this.stopped) return;
      this.source?.removeAllListeners();
      this.source = null;
      this.start();
    }, delay);
  }

  private async onFrame(jpeg: Buffer): Promise<void> {
    this.frames += 1;
    // Mark a frame received (first frame => ONLINE).
    if (this.frames === 1) void this.reportHealth('ONLINE', undefined, { markConnected: true, markFrame: true });
    if (!this.cam.inference_enabled) return;
    // Drop frames if inference is still running (never queue unbounded).
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const started = Date.now();
      const dets = await this.runInference(jpeg);
      this.latencies.push(Date.now() - started);
      if (this.latencies.length > 50) this.latencies.shift();
      for (const d of dets) {
        await this.submitDetection(d, jpeg);
      }
    } catch (err) {
      this.failures += 1;
      this.log(`inference failure: ${String((err as Error).message)}`);
    } finally {
      this.inFlight = false;
    }
  }

  private modelKeyword(): 'general' | 'fire' {
    // Decide which model to call. In a fuller build this would consult the
    // camera's enabled ai_rules; here we run the general detector by default and
    // the fire detector when the org configured a fire rule (checked cheaply
    // via a cached flag). For the worker demo we run general.
    return 'general';
  }

  private async runInference(jpeg: Buffer): Promise<Array<{ label: string; confidence: number }>> {
    const url = config.inference.serviceUrl;
    if (!url) throw new Error('INFERENCE_UNAVAILABLE: no inference service configured');
    const form = new FormData();
    form.append('frame', new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }), 'frame.jpg');
    form.append('model', this.modelKeyword());
    form.append('min_confidence', '0.5');
    const res = await fetch(`${url.replace(/\/$/, '')}/infer`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(config.inference.timeoutMs),
    });
    if (!res.ok) throw new Error(`INFERENCE_UNAVAILABLE: HTTP ${res.status}`);
    const data = (await res.json()) as { detections: Array<{ class: string; confidence: number }> };
    this.detections += data.detections.length;
    void this.reportHealth('ONLINE', undefined, { markInference: true });
    return data.detections.map((d) => ({ label: d.class, confidence: d.confidence }));
  }

  private mapLabelToEventType(label: string): string | null {
    const l = label.toUpperCase();
    if (l === 'PERSON') return 'PERSON_DETECTION';
    if (['CAR', 'TRUCK', 'BUS', 'MOTORCYCLE', 'BICYCLE'].includes(l)) return 'VEHICLE_DETECTION';
    if (l === 'FIRE') return 'FIRE';
    if (l === 'SMOKE') return 'SMOKE';
    return null;
  }

  private async submitDetection(det: { label: string; confidence: number }, jpeg: Buffer): Promise<void> {
    const eventType = this.mapLabelToEventType(det.label);
    if (!eventType) return; // ignore classes we don't map to a rule
    await fetch(`${config.media.apiBaseUrl}/api/internal/detections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.media.workerToken}` },
      body: JSON.stringify({
        organizationId: this.cam.organization_id,
        cameraId: this.cam.id,
        eventType,
        confidence: det.confidence,
        // Only attach evidence for high-signal detections to avoid storage churn.
        snapshotBase64: det.confidence >= 0.85 ? jpeg.toString('base64') : undefined,
        metadata: { label: det.label },
      }),
    }).catch((e) => this.log(`detection submit failed: ${String((e as Error).message)}`));
  }

  private async reportHealth(
    status: string,
    detail?: string,
    flags?: { markConnected?: boolean; markFrame?: boolean; markInference?: boolean; incrementReconnect?: boolean },
  ): Promise<void> {
    await fetch(`${config.media.apiBaseUrl}/api/internal/camera-health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.media.workerToken}` },
      body: JSON.stringify({ organizationId: this.cam.organization_id, cameraId: this.cam.id, status, detail, ...flags }),
    }).catch(() => undefined);
  }

  private async flushStats(): Promise<void> {
    const avg = this.latencies.length ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length : 0;
    const frames = this.frames;
    const dets = this.detections;
    const fails = this.failures;
    this.frames = 0;
    this.detections = 0;
    this.failures = 0;
    if (frames === 0 && dets === 0 && fails === 0) return;
    await fetch(`${config.media.apiBaseUrl}/api/internal/inference-stats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.media.workerToken}` },
      body: JSON.stringify({
        organizationId: this.cam.organization_id,
        cameraId: this.cam.id,
        framesProcessed: frames,
        detections: dets,
        inferenceFailures: fails,
        avgLatencyMs: Math.round(avg * 100) / 100,
        model: config.inference.model,
      }),
    }).catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.source?.stop();
    this.source = null;
  }
}

export class MediaWorker {
  private pipelines = new Map<string, CameraPipeline>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /** Load enabled+inference cameras and reconcile pipelines. */
  async reconcile(): Promise<void> {
    const cams = (
      await adminPool.query<CameraRow>(
        `SELECT id, organization_id, site_id, rtsp_host, rtsp_path, rtsp_port,
                inference_enabled, inference_fps, enabled, source_kind
         FROM cameras WHERE enabled = true`,
      )
    ).rows;

    const active = new Set<string>();
    const limit = config.media.maxConcurrentStreams;
    for (const cam of cams) {
      if (active.size >= limit) break;
      active.add(cam.id);
      if (this.pipelines.has(cam.id)) continue;
      // Decrypt credentials (server-side only).
      let creds: { username?: string; password?: string } = {};
      const cr = await adminPool.query<{ username_enc: string; password_enc: string }>(
        `SELECT username_enc, password_enc FROM camera_credentials WHERE camera_id = $1`,
        [cam.id],
      );
      if (cr.rows[0]) {
        creds = { username: decryptSecret(cr.rows[0].username_enc), password: decryptSecret(cr.rows[0].password_enc) };
      }
      const p = new CameraPipeline(cam, creds);
      this.pipelines.set(cam.id, p);
      p.start();
    }
    // Stop pipelines whose camera is gone/disabled.
    for (const [id, p] of this.pipelines) {
      if (!active.has(id)) {
        p.stop();
        this.pipelines.delete(id);
      }
    }
  }

  start(pollMs = 15_000): void {
    void this.reconcile();
    this.pollTimer = setInterval(() => void this.reconcile(), pollMs);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const p of this.pipelines.values()) p.stop();
    this.pipelines.clear();
  }
}


