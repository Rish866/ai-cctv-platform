import dotenv from 'dotenv';

dotenv.config();

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

/**
 * Central, immutable configuration. Read once at process start.
 * Nothing here is mutated per-request — tenant context is resolved per-request
 * from the authenticated session, never from a global variable.
 */
export const config = {
  env: optional('NODE_ENV', 'development'),
  port: parseInt(optional('PORT', '4000'), 10),
  webOrigin: optional('WEB_ORIGIN', 'http://localhost:5173'),

  // Two connection strings. App = RLS-enforced. Admin = migrations only.
  appDatabaseUrl: required('APP_DATABASE_URL', process.env.DATABASE_URL),
  adminDatabaseUrl: required(
    'ADMIN_DATABASE_URL',
    process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL,
  ),

  sessionSecret: optional('SESSION_SECRET', 'dev-session-secret-change-me'),
  // 32-byte hex key for AES-256-GCM credential encryption.
  credentialEncryptionKey: optional(
    'CREDENTIAL_ENCRYPTION_KEY',
    '0'.repeat(64),
  ),
  storageUrlSigningKey: optional(
    'STORAGE_URL_SIGNING_KEY',
    'dev-storage-signing-key-change-me',
  ),

  storage: {
    provider: optional('STORAGE_PROVIDER', 'local'),
    localRoot: optional('STORAGE_LOCAL_ROOT', './.storage'),
    bucket: optional('STORAGE_BUCKET', 'sentriai-evidence'),
    signedUrlTtlSeconds: parseInt(optional('STORAGE_SIGNED_URL_TTL_SECONDS', '300'), 10),
  },

  session: {
    cookieName: optional('SESSION_COOKIE_NAME', 'sentriai_session'),
    ttlHours: parseInt(optional('SESSION_TTL_HOURS', '12'), 10),
    cookieSecure: optional('COOKIE_SECURE', 'false') === 'true',
  },

  rateLimit: {
    windowMs: parseInt(optional('RATE_LIMIT_WINDOW_MS', '60000'), 10),
    max: parseInt(optional('RATE_LIMIT_MAX', '300'), 10),
    authMax: parseInt(optional('AUTH_RATE_LIMIT_MAX', '20'), 10),
  },

  demoOrgSlug: optional('DEMO_ORG_SLUG', 'demo'),

  // ----- Real CCTV / media / inference (add-on) -----
  media: {
    ffmpegPath: optional('FFMPEG_PATH', 'ffmpeg'),
    ffprobePath: optional('FFPROBE_PATH', 'ffprobe'),
    // Where the media worker writes HLS segments (private; served via authed API).
    hlsRoot: optional('MEDIA_HLS_ROOT', './.hls'),
    // RTSP connection/probe timeout (seconds).
    probeTimeoutSeconds: parseInt(optional('RTSP_PROBE_TIMEOUT_SECONDS', '8'), 10),
    defaultInferenceFps: parseFloat(optional('DEFAULT_INFERENCE_FPS', '2')),
    maxConcurrentStreams: parseInt(optional('MAX_CONCURRENT_STREAMS', '25'), 10),
    // Reconnect backoff (ms) — capped exponential.
    reconnectBaseMs: parseInt(optional('RECONNECT_BASE_MS', '5000'), 10),
    reconnectMaxMs: parseInt(optional('RECONNECT_MAX_MS', '60000'), 10),
    // Circular pre-event buffer duration (seconds) for evidence clips.
    frameBufferSeconds: parseInt(optional('FRAME_BUFFER_SECONDS', '5'), 10),
    // Whether the VIDEO_FILE_TEST_SOURCE dev source is permitted.
    allowVideoFileSource: optional('ALLOW_VIDEO_FILE_SOURCE', 'false') === 'true',
    // Shared secret the media worker uses to call the API's internal ingest.
    workerToken: optional('MEDIA_WORKER_TOKEN', 'dev-media-worker-token'),
    // How the media worker reaches the API (internal network URL).
    apiBaseUrl: optional('MEDIA_API_BASE_URL', 'http://localhost:4000'),
  },

  inference: {
    // Base URL of the Python inference service. Empty => no production adapter.
    serviceUrl: optional('INFERENCE_SERVICE_URL', ''),
    timeoutMs: parseInt(optional('INFERENCE_TIMEOUT_MS', '5000'), 10),
    model: optional('INFERENCE_MODEL', 'yolo-generic'),
  },
} as const;

export type AppConfig = typeof config;
