-- =============================================================================
-- GarudAI ADD-ON — Real CCTV/RTSP: camera streaming columns + health tables
-- =============================================================================
-- Runs after 0004 (enum values committed). Purely ADDITIVE:
--   * new columns on cameras for stream/inference/health (safe defaults keep
--     existing rows behaving exactly as before)
--   * new tenant-owned tables camera_health_events + inference_stats, each with
--     organization_id NOT NULL, FKs, indexes, FORCE ROW LEVEL SECURITY + 4 RLS
--     policies, matching the existing security model. App role stays
--     NOSUPERUSER / NOBYPASSRLS.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Extend cameras with stream + inference + health telemetry.
-- -----------------------------------------------------------------------------
ALTER TABLE cameras
  -- RTSP transport: full path already exists (rtsp_path). Add port + profile.
  ADD COLUMN IF NOT EXISTS rtsp_port         integer  NOT NULL DEFAULT 554 CHECK (rtsp_port > 0 AND rtsp_port <= 65535),
  ADD COLUMN IF NOT EXISTS stream_profile    text     NOT NULL DEFAULT 'main',
  ADD COLUMN IF NOT EXISTS enabled           boolean  NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS inference_enabled boolean  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inference_fps     numeric(5,2) NOT NULL DEFAULT 2.0 CHECK (inference_fps >= 0 AND inference_fps <= 60),
  -- Live telemetry populated by the media worker.
  ADD COLUMN IF NOT EXISTS resolution        text,
  ADD COLUMN IF NOT EXISTS codec             text,
  ADD COLUMN IF NOT EXISTS source_fps        numeric(6,2),
  ADD COLUMN IF NOT EXISTS reconnect_count   integer  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_connected_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_frame_at     timestamptz,
  ADD COLUMN IF NOT EXISTS last_inference_at timestamptz,
  ADD COLUMN IF NOT EXISTS health            camera_health NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS downtime_seconds  bigint   NOT NULL DEFAULT 0,
  -- Optional approved dev/test source (e.g. VIDEO_FILE_TEST_SOURCE path). Only
  -- honored by the worker when explicitly enabled via env; never in prod unless
  -- configured. Stores a source-kind marker, NOT credentials.
  ADD COLUMN IF NOT EXISTS source_kind       text     NOT NULL DEFAULT 'RTSP';

-- -----------------------------------------------------------------------------
-- 2) camera_health_events — tenant-scoped health transitions (OFFLINE/RECOVERED
--    etc). Deduplicated by the health service; used for observability + audit.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS camera_health_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  camera_id       uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  status          camera_status NOT NULL,
  health          camera_health NOT NULL DEFAULT 'UNKNOWN',
  detail          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cam_health_org ON camera_health_events(organization_id);
CREATE INDEX IF NOT EXISTS idx_cam_health_org_camera ON camera_health_events(organization_id, camera_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 3) inference_stats — per-camera rolling inference metrics (tenant scoped).
--    One row per camera (upserted by the worker). No frame data is stored here.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inference_stats (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  camera_id          uuid NOT NULL UNIQUE REFERENCES cameras(id) ON DELETE CASCADE,
  frames_processed   bigint NOT NULL DEFAULT 0,
  detections_total   bigint NOT NULL DEFAULT 0,
  inference_failures bigint NOT NULL DEFAULT 0,
  avg_latency_ms     numeric(8,2) NOT NULL DEFAULT 0,
  last_model         text,
  last_model_version text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inference_stats_org ON inference_stats(organization_id);

-- =============================================================================
-- ROW LEVEL SECURITY for the new tenant tables — identical model to 0001/0003.
-- =============================================================================
DO $$
DECLARE
  t text;
  new_tables text[] := ARRAY['camera_health_events', 'inference_stats'];
BEGIN
  FOREACH t IN ARRAY new_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_select ON %1$I', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_insert ON %1$I', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_update ON %1$I', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_delete ON %1$I', t);
    EXECUTE format($f$CREATE POLICY %1$s_select ON %1$I FOR SELECT USING (app.org_visible(organization_id))$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_insert ON %1$I FOR INSERT WITH CHECK (app.org_visible(organization_id))$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_update ON %1$I FOR UPDATE USING (app.org_visible(organization_id)) WITH CHECK (app.org_visible(organization_id))$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_delete ON %1$I FOR DELETE USING (app.org_visible(organization_id))$f$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON camera_health_events, inference_stats TO garudai_app;
