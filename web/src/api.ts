/**
 * Thin API client. All requests are same-origin with credentials so the
 * httpOnly session cookie is sent automatically. The frontend NEVER handles
 * tenant tokens or organization ids for security — the server derives tenant
 * context from the session. This client is display-layer only.
 */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/**
 * API base URL. In production the web app (garudai.in on Vercel) and the API
 * (api.garudai.in on Render) are on different origins, so set VITE_API_URL at
 * build time to the API's absolute URL. In local dev it's empty and requests go
 * to the same origin (`/api`), proxied to the API by Vite. `credentials:
 * 'include'` sends the httpOnly session cookie cross-site (cookie is
 * SameSite=None; Secure in production).
 */
export const API_BASE_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE_URL}/api${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    let code = 'ERROR';
    let message = res.statusText;
    if (ct.includes('application/json')) {
      const data = await res.json().catch(() => ({}));
      code = data.error ?? code;
      message = data.message ?? message;
    }
    throw new ApiError(res.status, code, message);
  }
  if (ct.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/**
 * Absolutize a server-relative path (e.g. a signed evidence URL "/api/...", or
 * an HLS manifest URL) against the API origin so it loads from the API host
 * (api.garudai.in) rather than the web host. Pass-through for absolute URLs.
 */
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE_URL}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** WebSocket URL for the tenant realtime channel, on the API origin. */
export function wsUrl(): string {
  if (API_BASE_URL) {
    return `${API_BASE_URL.replace(/^http/i, 'ws')}/ws`;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

export interface Membership {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'VIEWER';
  status: string;
}

export interface CurrentUser {
  id: string;
  email: string;
  fullName: string;
  isPlatformAdmin: boolean;
}
