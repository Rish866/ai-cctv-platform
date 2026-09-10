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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
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
