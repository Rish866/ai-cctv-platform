import { promises as fs } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { config } from '../config.js';
import { signStorageToken, verifyStorageToken } from '../lib/crypto.js';

/**
 * Tenant-isolated evidence storage.
 *
 * Object keys are ALWAYS namespaced by organization:
 *   organizations/{orgId}/sites/{siteId}/cameras/{camId}/events/{eventId}/{name}
 *
 * Objects are private. Access is granted only through short-lived HMAC-signed
 * URLs whose signature binds {organizationId, storageKey, expiresAt}. A URL
 * minted for tenant A's object cannot be replayed against tenant B's object,
 * and a tampered key/org/expiry invalidates the signature.
 *
 * The `local` provider writes under STORAGE_LOCAL_ROOT for dev/tests; in
 * production STORAGE_PROVIDER would be s3/gcs and this module would call the
 * cloud SDK's presign — the tenant-scoping + ownership-check contract is the same.
 */
export function buildEvidenceKey(p: {
  organizationId: string;
  siteId: string;
  cameraId: string;
  eventId: string;
  filename: string;
}): string {
  const safeName = p.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `organizations/${p.organizationId}/sites/${p.siteId}/cameras/${p.cameraId}/events/${p.eventId}/${safeName}`;
}

/** Assert a storage key belongs to the given org (path-prefix invariant). */
export function keyBelongsToOrg(storageKey: string, organizationId: string): boolean {
  return storageKey.startsWith(`organizations/${organizationId}/`);
}

const storageRoot = resolve(config.storage.localRoot);

export async function putObject(storageKey: string, data: Buffer, _contentType: string): Promise<void> {
  const full = safeLocalPath(storageKey);
  await fs.mkdir(dirname(full), { recursive: true });
  await fs.writeFile(full, data);
}

export async function getObject(storageKey: string): Promise<Buffer> {
  return fs.readFile(safeLocalPath(storageKey));
}

export async function objectExists(storageKey: string): Promise<boolean> {
  try {
    await fs.access(safeLocalPath(storageKey));
    return true;
  } catch {
    return false;
  }
}

/** Prevent path traversal escaping the storage root. */
function safeLocalPath(storageKey: string): string {
  const normalized = normalize(storageKey).replace(/^(\.\.(\/|\\|$))+/, '');
  const full = join(storageRoot, normalized);
  if (!full.startsWith(storageRoot)) {
    throw new Error('Invalid storage key (path traversal blocked)');
  }
  return full;
}

export interface SignedUrl {
  url: string;
  expiresAt: number;
}

/**
 * Mint a signed URL for an evidence object. Callers MUST have already verified
 * (a) authentication, (b) org membership, (c) event belongs to org, and
 * (d) evidence belongs to event — this function only signs.
 */
export function signEvidenceUrl(organizationId: string, storageKey: string): SignedUrl {
  const expiresAt = Math.floor(Date.now() / 1000) + config.storage.signedUrlTtlSeconds;
  const token = signStorageToken({ organizationId, storageKey, expiresAt });
  const q = new URLSearchParams({
    key: storageKey,
    org: organizationId,
    exp: String(expiresAt),
    sig: token,
  });
  return { url: `/api/storage/object?${q.toString()}`, expiresAt };
}

/** Validate a signed URL request. Returns true only if signature + org + key + expiry match. */
export function verifyEvidenceUrl(params: {
  organizationId: string;
  storageKey: string;
  expiresAt: number;
  token: string;
}): boolean {
  if (!keyBelongsToOrg(params.storageKey, params.organizationId)) return false;
  return verifyStorageToken(
    { organizationId: params.organizationId, storageKey: params.storageKey, expiresAt: params.expiresAt },
    params.token,
  );
}
