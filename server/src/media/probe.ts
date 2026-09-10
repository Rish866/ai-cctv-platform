import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { buildRtspUrl, buildRedactedRtspUrl, redactRtsp, type RtspTarget } from './rtsp.js';

/**
 * RTSP connectivity probe using ffprobe. Runs entirely server-side; the full
 * URL (with credentials) is passed to the child process argv but NEVER returned
 * or logged — only the redacted form appears in diagnostics.
 */

export type ProbeStatus =
  | 'CONNECTED'
  | 'AUTH_FAILED'
  | 'INVALID_STREAM'
  | 'TIMEOUT'
  | 'UNREACHABLE'
  | 'PROBE_ERROR';

export interface ProbeResult {
  success: boolean;
  status: ProbeStatus;
  latencyMs: number;
  message: string;
  // Safe stream metadata (never credentials).
  resolution?: string;
  codec?: string;
  fps?: number;
}

/** Classify ffprobe stderr into a safe status without leaking the URL. */
export function classifyProbeError(stderr: string): { status: ProbeStatus; message: string } {
  const s = stderr.toLowerCase();
  if (s.includes('401') || s.includes('unauthorized') || s.includes('authentication')) {
    return { status: 'AUTH_FAILED', message: 'Camera authentication failed' };
  }
  if (s.includes('timed out') || s.includes('timeout')) {
    return { status: 'TIMEOUT', message: 'RTSP connection timed out' };
  }
  if (
    s.includes('connection refused') ||
    s.includes('no route to host') ||
    s.includes('network is unreachable') ||
    s.includes('failed to resolve') ||
    s.includes('name or service not known')
  ) {
    return { status: 'UNREACHABLE', message: 'Camera is unreachable on the network' };
  }
  if (s.includes('invalid data') || s.includes('could not find codec') || s.includes('not contain any stream')) {
    return { status: 'INVALID_STREAM', message: 'RTSP endpoint did not return a valid video stream' };
  }
  return { status: 'PROBE_ERROR', message: 'Unable to probe RTSP stream' };
}

/** Parse ffprobe JSON output into safe metadata. */
export function parseProbeJson(json: string): { resolution?: string; codec?: string; fps?: number } {
  try {
    const data = JSON.parse(json) as {
      streams?: Array<{ codec_type?: string; width?: number; height?: number; codec_name?: string; avg_frame_rate?: string }>;
    };
    const video = (data.streams ?? []).find((st) => st.codec_type === 'video');
    if (!video) return {};
    const resolution = video.width && video.height ? `${video.width}x${video.height}` : undefined;
    let fps: number | undefined;
    if (video.avg_frame_rate && video.avg_frame_rate.includes('/')) {
      const [n, d] = video.avg_frame_rate.split('/').map(Number);
      if (n && d) fps = Math.round((n / d) * 100) / 100;
    }
    return { resolution, codec: video.codec_name, fps };
  } catch {
    return {};
  }
}

// The probe runner is injectable so tests can exercise classification/parsing
// without spawning a real ffprobe.
export type ProbeRunner = (target: RtspTarget) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultRunner: ProbeRunner = (target) =>
  new Promise((resolve) => {
    const url = buildRtspUrl(target);
    const timeoutS = config.media.probeTimeoutSeconds;
    // -rtsp_transport tcp for reliability; -show_streams for metadata; JSON out.
    const args = [
      '-v', 'error',
      '-rtsp_transport', 'tcp',
      '-timeout', String(timeoutS * 1_000_000), // microseconds
      '-print_format', 'json',
      '-show_streams',
      '-i', url,
    ];
    const child = spawn(config.media.ffprobePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const killTimer = setTimeout(() => child.kill('SIGKILL'), (timeoutS + 2) * 1000);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({ code: 1, stdout: '', stderr: String(err.message) });
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      // Never let a raw URL leak via stderr.
      resolve({ code: code ?? 1, stdout, stderr: redactRtsp(stderr) });
    });
  });

/**
 * Probe an RTSP target. Returns a SAFE diagnostic result — no credentials, no
 * raw URL. `runner` can be injected in tests.
 */
export async function probeRtsp(target: RtspTarget, runner: ProbeRunner = defaultRunner): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const { code, stdout, stderr } = await runner(target);
    const latencyMs = Date.now() - started;
    if (code === 0) {
      const meta = parseProbeJson(stdout);
      return {
        success: true,
        status: 'CONNECTED',
        latencyMs,
        message: 'RTSP stream reachable',
        ...meta,
      };
    }
    const { status, message } = classifyProbeError(stderr);
    return { success: false, status, latencyMs, message };
  } catch (err) {
    // Defensive: never surface a raw URL.
    return {
      success: false,
      status: 'PROBE_ERROR',
      latencyMs: Date.now() - started,
      message: redactRtsp(String((err as Error).message ?? 'probe failed')),
    };
  }
}

export { buildRedactedRtspUrl };
