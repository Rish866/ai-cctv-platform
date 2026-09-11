// Vitest global setup: provide deterministic test secrets/storage so tests do
// not depend on a developer .env. DB connection comes from the harness env
// (APP_DATABASE_URL / ADMIN_DATABASE_URL) injected by scripts/with-postgres.sh.
process.env.CREDENTIAL_ENCRYPTION_KEY ||=
  '1111111111111111111111111111111111111111111111111111111111111111';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.STORAGE_URL_SIGNING_KEY ||= 'test-storage-signing-key';
process.env.STORAGE_LOCAL_ROOT ||= '/tmp/garudai-test-storage';
process.env.NODE_ENV ||= 'test';
