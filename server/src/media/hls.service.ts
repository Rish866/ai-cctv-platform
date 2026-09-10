import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { config } from '../config.js';
import { buildRtspUrl, redactRtsp, type RtspTarget } from './rtsp.js';

/**
 * RTSP -> HLS transcoding for browser-compatible live playback.
 *
 * Browsers cannot consume RTSP directly. This service runs an FFmpeg process
 * per active live session that pulls the RTSP stream (server-side, credentials
 * never exposed) and writes HLS (.m3u8 + .ts segments) into a PRIVATE,
 * tenant-scoped directory. The API serves those segments only through an
 * authenticated + signed endpoint (see cameras live routes), so the RTSP URL
 * and credentials never reach the client — only short-lived authorized HLS.
 *
 * Sessions are keyed by {organizationId}/{cameraId}; the on-disk path is
 * namespaced by organization so one tenant's segments can never be under
 * another's prefix. Idle sessions are reaped.
 */

interface HlsSession {
  organizationId: string;
  cameraId: string;
  dir: string;
  proc: ChildProcess;
  startedAt: number;
  lastAccess: number;
}

const HLS_IDLE_TIMEOUT_MS = 60_000;

class HlsManager {
  private sessions = new Map<string, HlsSession>();
  private reaper: ReturnType<typeof setInterval> | null = null;

  private key(org: string, cam: string): string {
    return `${org}:${cam}`;
  }

  /** Absolute, org-namespaced directory for a camera's HLS output. */
  sessionDir(org: string, cam: string): string {
    const root = resolve(config.media.hlsRoot);
    // organizations/{org}/cameras/{cam}
    const rel = normalize(join('organizations', org, 'cameras', cam)).replace(/^(\.\.(\/|\\|$))+/, '');
    const full = join(root, rel);
    if (!full.startsWith(root)) throw new Error('Invalid HLS path');
    return full;
  }

  /**
   * Ensure an HLS session is running for the camera and return its manifest path
   * (relative name "index.m3u8"). Starts FFmpeg if not already running.
   */
  async ensureSession(org: string, cam: string, target: RtspTarget): Promise<{ manifest: string }> {
    const k = this.key(org, cam);
    const existing = this.sessions.get(k);
    if (existing && !existing.proc.killed) {
      existing.lastAccess = Date.now();
      return { manifest: 'index.m3u8' };
    }
    const dir = this.sessionDir(org, cam);
    await fs.mkdir(dir, { recursive: true });

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-i', buildRtspUrl(target),
      '-an',
      '-c:v', 'copy', // pass-through when possible; browsers need H264 (typical for IP cams)
      '-f', 'hls',
      '-hls_time', '2',
      '-hls_list_size', '5',
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_filename', join(dir, 'seg_%05d.ts'),
      join(dir, 'index.m3u8'),
    ];
    const proc = spawn(config.media.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderrTail = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderrTail = redactRtsp((stderrTail + d.toString()).slice(-400));
    });
    proc.on('exit', () => {
      const s = this.sessions.get(k);
      if (s && s.proc === proc) this.sessions.delete(k);
    });

    this.sessions.set(k, { organizationId: org, cameraId: cam, dir, proc, startedAt: Date.now(), lastAccess: Date.now() });
    this.ensureReaper();
    return { manifest: 'index.m3u8' };
  }

  /** Read an HLS artifact (manifest or segment) for a camera, marking access. */
  async readArtifact(org: string, cam: string, name: string): Promise<Buffer> {
    // name must be a plain hls filename — no path traversal.
    if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.includes('..')) {
      throw new Error('Invalid HLS artifact name');
    }
    const s = this.sessions.get(this.key(org, cam));
    if (s) s.lastAccess = Date.now();
    const dir = this.sessionDir(org, cam);
    const full = join(dir, name);
    if (!full.startsWith(dir)) throw new Error('Invalid HLS path');
    return fs.readFile(full);
  }

  stopSession(org: string, cam: string): void {
    const k = this.key(org, cam);
    const s = this.sessions.get(k);
    if (s) {
      s.proc.kill('SIGKILL');
      this.sessions.delete(k);
    }
  }

  private ensureReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      const now = Date.now();
      for (const [k, s] of this.sessions) {
        if (now - s.lastAccess > HLS_IDLE_TIMEOUT_MS) {
          s.proc.kill('SIGKILL');
          this.sessions.delete(k);
        }
      }
      if (this.sessions.size === 0 && this.reaper) {
        clearInterval(this.reaper);
        this.reaper = null;
      }
    }, 15_000);
  }

  stopAll(): void {
    for (const s of this.sessions.values()) s.proc.kill('SIGKILL');
    this.sessions.clear();
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = null;
    }
  }
}

export const hlsManager = new HlsManager();
