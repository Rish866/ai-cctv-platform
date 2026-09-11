/**
 * Tenant-namespaced cache.
 *
 * Every key is prefixed with `tenant:{organizationId}:` so cached data for one
 * organization can NEVER be served to another. In production the same interface
 * would back onto Redis; here it is an in-process Map with TTL, which is enough
 * to demonstrate + test the isolation contract.
 *
 * Keys are ALWAYS built via tenantKey() — there is no way to construct an
 * un-namespaced key through the public API.
 */
interface Entry {
  value: unknown;
  expiresAt: number;
}

const store = new Map<string, Entry>();

export function tenantKey(organizationId: string, name: string): string {
  if (!organizationId) throw new Error('cache: organizationId is required for tenant key');
  return `tenant:${organizationId}:${name}`;
}

export function cacheGet<T>(organizationId: string, name: string): T | undefined {
  const key = tenantKey(organizationId, name);
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function cacheSet<T>(organizationId: string, name: string, value: T, ttlSeconds = 30): void {
  store.set(tenantKey(organizationId, name), {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  });
}

/** Invalidate a single key or the entire tenant namespace. */
export function cacheInvalidate(organizationId: string, name?: string): void {
  if (name) {
    store.delete(tenantKey(organizationId, name));
    return;
  }
  const prefix = `tenant:${organizationId}:`;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/** Test/introspection helper — returns all keys (namespaced). */
export function _cacheKeys(): string[] {
  return [...store.keys()];
}

export function _cacheClear(): void {
  store.clear();
}
