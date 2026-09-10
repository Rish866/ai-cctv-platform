/**
 * RTSP URL construction + credential redaction.
 *
 * Credentials are ONLY ever assembled into a full RTSP URL server-side, inside
 * the trusted media path. The full URL (with password) is never returned to a
 * client, never logged, and never placed in a WebSocket payload. `redactRtsp`
 * guarantees that if a URL is ever logged it appears as rtsp://user:***@host.
 */

export interface RtspTarget {
  host: string;
  port?: number;
  path?: string | null;
  username?: string;
  password?: string;
}

/** Build a full rtsp:// URL with embedded credentials (server-side ONLY). */
export function buildRtspUrl(t: RtspTarget): string {
  const port = t.port && t.port !== 554 ? `:${t.port}` : ':554';
  const path = normalizePath(t.path);
  const auth =
    t.username || t.password
      ? `${encodeURIComponent(t.username ?? '')}:${encodeURIComponent(t.password ?? '')}@`
      : '';
  return `rtsp://${auth}${t.host}${port}${path}`;
}

/** Build a redacted rtsp:// URL safe for logs / diagnostics. */
export function buildRedactedRtspUrl(t: RtspTarget): string {
  const port = t.port && t.port !== 554 ? `:${t.port}` : ':554';
  const path = normalizePath(t.path);
  const auth = t.username || t.password ? `${t.username ? t.username : 'user'}:***@` : '';
  return `rtsp://${auth}${t.host}${port}${path}`;
}

function normalizePath(path?: string | null): string {
  if (!path) return '';
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * Redact any embedded credentials from an arbitrary rtsp/http URL string.
 * Defense-in-depth: applied to anything that might reach a log or error.
 */
export function redactRtsp(value: string): string {
  return value.replace(/(rtsp|rtsps|http|https):\/\/([^:/@\s]+):([^@/\s]+)@/gi, '$1://$2:***@');
}
