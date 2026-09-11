import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { buildRtspUrl, buildRedactedRtspUrl, redactRtsp, type RtspTarget } from './rtsp.js';

/**
 * FrameSource — runs a single FFmpeg child that connects to an RTSP camera (or,
 * in approved dev mode, a local video file) and emits JPEG frames at a target
 * FPS. One FrameSource per camera => one broken camera never affects others.
 *
 * FFmpeg writes MJPEG to stdout; we split on JPEG SOI/EOI markers to emit whole
 * frames. The full RTSP URL (with credentials) is passed only in the child argv
 * and NEVER logged — logs use the redacted form.
 *
 * Lifecycle: start() spawns; stop() SIGKILLs and prevents restarts (no zombies).
 * Crashes/exits are surfaced via the 'exit' event so the worker can apply
 * exponential-backoff reconnect.
 */

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);

export interface FrameSourceOptions {
  /** RTSP connection target (server-side only). */
  target?: RtspTarget;
  /** Approved local video file path (VIDEO_FILE_TEST_SOURCE) — dev/test only. */
  videoFile?: string;
  /** Frames per second to sample (>=0). */
  fps: number;
  /** Logical label for logs (camera id) — never contains credentials. */
  label: string;
}

export interface FrameSourceEvents {
  frame: (jpeg: Buffer) => void;
  exit: (info: { code: number | null; signal: NodeJS.Signals | null; reason: string }) => void;
  error: (message: string) => void;
}

export class FrameSource extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private stopped = false;
  private stderrTail = '';

  constructor(private readonly opts: FrameSourceOptions) {
    super();
  }

  /** The redacted source string, safe for logs. */
  get redactedSource(): string {
    if (this.opts.videoFile) return `file:${this.opts.videoFile}`;
    return this.opts.target ? buildRedactedRtspUrl(this.opts.target) : 'unknown';
  }

  start(): void {
    if (this.child || this.stopped) return;
    const fps = Math.max(0.1, this.opts.fps || config.media.defaultInferenceFps);
    const args: string[] = ['-hide_banner', '-loglevel', 'error'];

    if (this.opts.videoFile) {
      // Approved local test source. Loop so the demo keeps producing frames.
      args.push('-re', '-stream_loop', '-1', '-i', this.opts.videoFile);
    } else if (this.opts.target) {
      args.push('-rtsp_transport', 'tcp', '-i', buildRtspUrl(this.opts.target));
    } else {
      this.emit('error', 'FrameSource has no source configured');
      return;
    }

    // Output MJPEG frames at the sampling FPS to stdout.
    args.push('-an', '-vf', `fps=${fps}`, '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '5', 'pipe:1');

    const child = spawn(config.media.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;

    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr.on('data', (d: Buffer) => {
      // Keep only a short redacted tail for diagnostics; never log full URLs.
      this.stderrTail = redactRtsp((this.stderrTail + d.toString()).slice(-500));
    });
    child.on('error', (err) => {
      this.emit('error', redactRtsp(String(err.message)));
    });
    child.on('exit', (code, signal) => {
      this.child = null;
      this.buffer = Buffer.alloc(0);
      if (!this.stopped) {
        this.emit('exit', { code, signal, reason: this.stderrTail || 'ffmpeg exited' });
      }
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // Extract complete JPEG frames (SOI..EOI). Guard against unbounded growth.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const soi = this.buffer.indexOf(JPEG_SOI);
      if (soi < 0) {
        if (this.buffer.length > 8 * 1024 * 1024) this.buffer = Buffer.alloc(0);
        return;
      }
      const eoi = this.buffer.indexOf(JPEG_EOI, soi + 2);
      if (eoi < 0) {
        if (soi > 0) this.buffer = this.buffer.subarray(soi);
        return;
      }
      const frame = this.buffer.subarray(soi, eoi + 2);
      this.buffer = this.buffer.subarray(eoi + 2);
      this.emit('frame', Buffer.from(frame));
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.child) {
      // Terminate cleanly; SIGKILL after a grace period to avoid zombies.
      const child = this.child;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 2000);
      this.child = null;
    }
  }

  isRunning(): boolean {
    return this.child !== null && !this.stopped;
  }
}
