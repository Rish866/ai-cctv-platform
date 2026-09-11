import { createHmac, randomUUID } from 'node:crypto';
import { config } from '../config.js';

/**
 * CCTV stream isolation.
 *
 * A stream session is a short-lived, signed token that authorizes a specific
 * {organization, site, camera}. It is minted ONLY after the route has verified
 * user -> membership -> camera ownership (via RLS). The token embeds the org +
 * camera + expiry and is HMAC-signed, so:
 *   - a token issued for tenant A's camera cannot be replayed for tenant B's,
 *   - raw RTSP URLs and credentials are never exposed to the browser,
 *   - there is no globally accessible stream URL.
 *
 * A media gateway would exchange this token for an HLS/WebRTC session, decrypt
 * camera credentials server-side, and never reveal them to the client.
 */
export interface StreamSession {
  sessionId: string;
  organizationId: string;
  cameraId: string;
  siteId: string;
  playbackUrl: string;
  token: string;
  expiresAt: number;
}

const STREAM_TTL_SECONDS = 120;

export function signStreamToken(p: {
  organizationId: string;
  cameraId: string;
  siteId: string;
  sessionId: string;
  expiresAt: number;
}): string {
  const payload = `${p.organizationId}:${p.cameraId}:${p.siteId}:${p.sessionId}:${p.expiresAt}`;
  return createHmac('sha256', config.storageUrlSigningKey).update(payload).digest('hex');
}

export function createStreamSession(p: {
  organizationId: string;
  cameraId: string;
  siteId: string;
}): StreamSession {
  const sessionId = randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + STREAM_TTL_SECONDS;
  const token = signStreamToken({ ...p, sessionId, expiresAt });
  const q = new URLSearchParams({
    cam: p.cameraId,
    org: p.organizationId,
    sid: sessionId,
    exp: String(expiresAt),
    sig: token,
  });
  return {
    sessionId,
    organizationId: p.organizationId,
    cameraId: p.cameraId,
    siteId: p.siteId,
    // Points at an authenticated media endpoint; never a raw rtsp:// URL.
    playbackUrl: `/api/streams/playback?${q.toString()}`,
    token,
    expiresAt,
  };
}

export function verifyStreamToken(p: {
  organizationId: string;
  cameraId: string;
  siteId: string;
  sessionId: string;
  expiresAt: number;
  token: string;
}): boolean {
  if (p.expiresAt < Math.floor(Date.now() / 1000)) return false;
  const expected = signStreamToken(p);
  return expected === p.token;
}
