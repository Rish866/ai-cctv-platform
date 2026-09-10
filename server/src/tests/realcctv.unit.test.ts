import { describe, expect, it } from 'vitest';
import { buildRtspUrl, buildRedactedRtspUrl, redactRtsp } from '../media/rtsp.js';
import { classifyProbeError, parseProbeJson, probeRtsp } from '../media/probe.js';
import { detectionInZone, pointInPolygon } from '../ai/zone.js';
import { SessionTracker } from '../ai/tracker.js';

/**
 * Pure unit tests for the real-CCTV layer (no DB / no ffmpeg needed). Verifies
 * credential redaction, probe classification/parsing, zone geometry, and the
 * session tracker.
 */

describe('RTSP URL + credential redaction', () => {
  it('builds a full URL server-side but redacts credentials for logs', () => {
    const target = { host: '10.0.0.5', port: 554, path: '/stream1', username: 'admin', password: 'S3cret!' };
    const full = buildRtspUrl(target);
    expect(full).toContain('admin');
    expect(full).toContain('S3cret');
    const redacted = buildRedactedRtspUrl(target);
    expect(redacted).toContain('admin:***@');
    expect(redacted).not.toContain('S3cret');
  });

  it('redactRtsp masks passwords embedded in arbitrary strings', () => {
    const line = 'ffmpeg error connecting to rtsp://admin:MyPassword@192.168.1.100/live';
    const out = redactRtsp(line);
    expect(out).not.toContain('MyPassword');
    expect(out).toContain('admin:***@');
  });

  it('url-encodes special chars in credentials', () => {
    const full = buildRtspUrl({ host: 'h', username: 'a b', password: 'p@ss/word' });
    expect(full).toContain('a%20b');
    expect(full).toContain('p%40ss%2Fword');
  });
});

describe('ffprobe result classification', () => {
  it('classifies auth failure', () => {
    expect(classifyProbeError('401 Unauthorized').status).toBe('AUTH_FAILED');
  });
  it('classifies timeout', () => {
    expect(classifyProbeError('Connection timed out').status).toBe('TIMEOUT');
  });
  it('classifies unreachable', () => {
    expect(classifyProbeError('No route to host').status).toBe('UNREACHABLE');
    expect(classifyProbeError('Failed to resolve hostname').status).toBe('UNREACHABLE');
  });
  it('classifies invalid stream', () => {
    expect(classifyProbeError('Invalid data found when processing input').status).toBe('INVALID_STREAM');
  });
  it('parses valid ffprobe json into safe metadata', () => {
    const json = JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1' }] });
    const meta = parseProbeJson(json);
    expect(meta.resolution).toBe('1920x1080');
    expect(meta.codec).toBe('h264');
    expect(meta.fps).toBe(30);
  });
  it('returns empty metadata for malformed json', () => {
    expect(parseProbeJson('not json')).toEqual({});
  });
});

describe('probeRtsp with injected runner (no real ffprobe)', () => {
  it('reports CONNECTED with metadata on success', async () => {
    const r = await probeRtsp(
      { host: 'x', username: 'u', password: 'p' },
      async () => ({ code: 0, stdout: JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 640, height: 480, avg_frame_rate: '15/1' }] }), stderr: '' }),
    );
    expect(r.success).toBe(true);
    expect(r.status).toBe('CONNECTED');
    expect(r.resolution).toBe('640x480');
  });
  it('reports AUTH_FAILED and leaks no credentials on failure', async () => {
    const r = await probeRtsp(
      { host: 'x', username: 'admin', password: 'secretpw' },
      async () => ({ code: 1, stdout: '', stderr: '401 Unauthorized' }),
    );
    expect(r.success).toBe(false);
    expect(r.status).toBe('AUTH_FAILED');
    expect(JSON.stringify(r)).not.toContain('secretpw');
  });
});

describe('Zone geometry evaluation', () => {
  it('point-in-polygon works for a square', () => {
    const square: Array<[number, number]> = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]];
    expect(pointInPolygon(0.5, 0.5, square)).toBe(true);
    expect(pointInPolygon(0.1, 0.1, square)).toBe(false);
  });
  it('detection center inside rectangle zone matches', () => {
    const geom = { type: 'rectangle' as const, x: 0.4, y: 0.4, width: 0.2, height: 0.2 };
    expect(detectionInZone({ x: 0.45, y: 0.45, w: 0.05, h: 0.05 }, geom)).toBe(true); // center 0.475,0.475
    expect(detectionInZone({ x: 0.0, y: 0.0, w: 0.05, h: 0.05 }, geom)).toBe(false);
  });
  it('empty geometry means whole frame (always matches)', () => {
    expect(detectionInZone({ x: 0.9, y: 0.9, w: 0.05, h: 0.05 }, {})).toBe(true);
    expect(detectionInZone({ x: 0.1, y: 0.1, w: 0.05, h: 0.05 }, null)).toBe(true);
  });
});

describe('SessionTracker (ephemeral, tenant-namespaced)', () => {
  it('assigns stable track ids + dwell time and never mixes org/camera', () => {
    const tr = new SessionTracker();
    const bbox = { x: 0.1, y: 0.1, w: 0.2, h: 0.4 };
    const t0 = 1_000_000;
    const a1 = tr.update('orgA', 'cam1', [{ label: 'PERSON', bbox }], t0);
    expect(a1[0]!.isNew).toBe(true);
    const a2 = tr.update('orgA', 'cam1', [{ label: 'PERSON', bbox: { ...bbox, x: 0.11 } }], t0 + 2000);
    expect(a2[0]!.isNew).toBe(false);
    expect(a2[0]!.trackId).toBe(a1[0]!.trackId);
    expect(a2[0]!.dwellMs).toBeGreaterThanOrEqual(2000);
    // Different org/camera => independent namespace, fresh track.
    const b1 = tr.update('orgB', 'cam1', [{ label: 'PERSON', bbox }], t0 + 2000);
    expect(b1[0]!.trackId).not.toBe(a1[0]!.trackId);
    expect(b1[0]!.isNew).toBe(true);
  });
});
