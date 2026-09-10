import {
  createHmac,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'node:crypto';
import argon2 from 'argon2';
import { config } from '../config.js';

// -----------------------------------------------------------------------------
// Password hashing (argon2id) — never store plaintext passwords.
// -----------------------------------------------------------------------------
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Symmetric encryption for camera credentials (AES-256-GCM).
// Stored form: base64(iv).base64(tag).base64(ciphertext)
// The key comes from CREDENTIAL_ENCRYPTION_KEY (64 hex chars = 32 bytes).
// Plaintext credentials NEVER leave the server and are decrypted only inside
// the trusted media/stream service path.
// -----------------------------------------------------------------------------
function credentialKey(): Buffer {
  const hex = config.credentialEncryptionKey;
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY must be 64 hex characters (32 bytes) for AES-256-GCM',
    );
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', credentialKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  const [ivB64, tagB64, ctB64] = stored.split('.');
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error('Malformed encrypted secret');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    credentialKey(),
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]);
  return pt.toString('utf8');
}

// -----------------------------------------------------------------------------
// Signed, short-lived storage/evidence URLs (HMAC-SHA256).
// The signature binds the exact object key + organization + expiry, so a URL
// issued for tenant A's evidence cannot be replayed for tenant B's object.
// -----------------------------------------------------------------------------
export interface SignedUrlParams {
  organizationId: string;
  storageKey: string;
  expiresAt: number; // epoch seconds
}

export function signStorageToken(p: SignedUrlParams): string {
  const payload = `${p.organizationId}:${p.storageKey}:${p.expiresAt}`;
  return createHmac('sha256', config.storageUrlSigningKey).update(payload).digest('hex');
}

export function verifyStorageToken(p: SignedUrlParams, token: string): boolean {
  if (p.expiresAt < Math.floor(Date.now() / 1000)) return false;
  const expected = signStorageToken(p);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(token, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// -----------------------------------------------------------------------------
// Signed session tokens (opaque session id + HMAC to detect tampering).
// -----------------------------------------------------------------------------
export function signSessionId(sessionId: string): string {
  const sig = createHmac('sha256', config.sessionSecret).update(sessionId).digest('hex');
  return `${sessionId}.${sig}`;
}

export function verifySessionId(signed: string): string | null {
  const idx = signed.lastIndexOf('.');
  if (idx < 0) return null;
  const sessionId = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const expected = createHmac('sha256', config.sessionSecret)
    .update(sessionId)
    .digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return sessionId;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
