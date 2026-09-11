-- =============================================================================
-- GarudAI ADD-ON — Real CCTV/RTSP: camera_status enum extensions ONLY
-- =============================================================================
-- Isolated file: new enum values must be COMMITTED before migration 0005 can
-- use them (defaults / data). Purely ADDITIVE — no existing value changes, so
-- every existing camera row and code path keeps working.
-- =============================================================================

ALTER TYPE camera_status ADD VALUE IF NOT EXISTS 'CONNECTING';
ALTER TYPE camera_status ADD VALUE IF NOT EXISTS 'RECONNECTING';
ALTER TYPE camera_status ADD VALUE IF NOT EXISTS 'AUTH_FAILED';
ALTER TYPE camera_status ADD VALUE IF NOT EXISTS 'INVALID_STREAM';
ALTER TYPE camera_status ADD VALUE IF NOT EXISTS 'DISABLED';

-- New AI/system event types for camera health (extends ai_rule_type used by
-- events.event_type). Additive; existing detections unaffected.
ALTER TYPE ai_rule_type ADD VALUE IF NOT EXISTS 'CAMERA_OFFLINE';
ALTER TYPE ai_rule_type ADD VALUE IF NOT EXISTS 'CAMERA_RECOVERED';

-- Health status enum for the camera health snapshot.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'camera_health') THEN
    CREATE TYPE camera_health AS ENUM ('HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN');
  END IF;
END $$;
