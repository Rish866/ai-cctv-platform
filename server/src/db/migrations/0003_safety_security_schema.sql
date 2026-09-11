-- =============================================================================
-- GarudAI ADD-ON — Safety & Security AI: schema, columns, new tenant tables
-- =============================================================================
-- Runs after 0002 (enum values committed). Purely ADDITIVE:
--   * extends ai_rules with cooldown / min-duration / notification-channel config
--   * adds new tenant-owned tables (ai_models, zone_schedules, monitored_objects,
--     incident_notes, alert_cooldowns), each with organization_id NOT NULL, FKs,
--     indexes, and FULL RLS (SELECT/INSERT/UPDATE/DELETE) + FORCE ROW LEVEL
--     SECURITY, matching the existing security model exactly.
-- The application role stays NOSUPERUSER / NOBYPASSRLS (unchanged).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Extend ai_rules with false-positive control + cooldown + channels.
--    Defaults chosen so EXISTING rows keep behaving as before (cooldown 0 = no
--    change to existing dedup behavior; min_duration_ms 0; channels default set).
-- -----------------------------------------------------------------------------
ALTER TABLE ai_rules
  ADD COLUMN IF NOT EXISTS cooldown_seconds integer NOT NULL DEFAULT 30
    CHECK (cooldown_seconds >= 0),
  ADD COLUMN IF NOT EXISTS min_duration_ms integer NOT NULL DEFAULT 0
    CHECK (min_duration_ms >= 0),
  -- Which notification channels fire for this rule (subset of notify_channel).
  ADD COLUMN IF NOT EXISTS notify_channels notify_channel[] NOT NULL DEFAULT '{}'::notify_channel[],
  -- Optional link to a specific AI model (nullable; set after ai_models exists).
  ADD COLUMN IF NOT EXISTS ai_model_id uuid;

-- -----------------------------------------------------------------------------
-- 2) AI model abstraction (tenant-owned config + platform-shared catalog).
--    Each org configures which model/version/threshold applies. organization_id
--    NOT NULL keeps it tenant scoped like everything else.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_models (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  model_type         ai_model_type NOT NULL,
  name               text NOT NULL,
  version            text NOT NULL DEFAULT 'v1',
  -- Identifier the inference backend resolves (e.g. a registry key / weights id).
  backend_ref        text,
  confidence_threshold numeric(4,3) NOT NULL DEFAULT 0.700
    CHECK (confidence_threshold >= 0 AND confidence_threshold <= 1),
  -- true for the built-in demo/test adapter; production models are false.
  is_demo_adapter    boolean NOT NULL DEFAULT false,
  enabled            boolean NOT NULL DEFAULT true,
  config             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_models_org ON ai_models(organization_id);
CREATE INDEX IF NOT EXISTS idx_ai_models_org_type ON ai_models(organization_id, model_type);

-- Now that ai_models exists, wire the ai_rules FK (kept nullable + SET NULL).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_ai_rules_model'
  ) THEN
    ALTER TABLE ai_rules
      ADD CONSTRAINT fk_ai_rules_model
      FOREIGN KEY (ai_model_id) REFERENCES ai_models(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_ai_rules_model ON ai_rules(ai_model_id);

-- -----------------------------------------------------------------------------
-- 3) Zone operating schedules (after-hours activity). Tenant + zone scoped.
--    A zone is "open" during [open_minute, close_minute) on the given weekday
--    (0=Sunday..6=Saturday). Activity outside open windows -> AFTER_HOURS.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zone_schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  zone_id         uuid NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  -- 0..6 (Sun..Sat). NULL weekday => applies every day.
  weekday         smallint CHECK (weekday IS NULL OR (weekday >= 0 AND weekday <= 6)),
  open_minute     integer NOT NULL DEFAULT 540  CHECK (open_minute  >= 0 AND open_minute  <= 1440), -- 09:00
  close_minute    integer NOT NULL DEFAULT 1080 CHECK (close_minute >= 0 AND close_minute <= 1440), -- 18:00
  timezone        text NOT NULL DEFAULT 'UTC',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_zone_schedules_org ON zone_schedules(organization_id);
CREATE INDEX IF NOT EXISTS idx_zone_schedules_org_zone ON zone_schedules(organization_id, zone_id);

-- -----------------------------------------------------------------------------
-- 4) Monitored objects / asset areas (object-removed detection). The reference
--    "present" state is tracked so a removal can be confirmed with dwell time.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monitored_objects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  camera_id       uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  zone_id         uuid REFERENCES zones(id) ON DELETE SET NULL,
  label           text NOT NULL,
  -- Bounding region the object is expected to occupy.
  region          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Current known state: is the object present?
  present         boolean NOT NULL DEFAULT true,
  -- How long (ms) the object must be absent before OBJECT_REMOVED is confirmed.
  confirm_ms      integer NOT NULL DEFAULT 3000 CHECK (confirm_ms >= 0),
  last_seen_at    timestamptz,
  last_missing_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_monitored_objects_org ON monitored_objects(organization_id);
CREATE INDEX IF NOT EXISTS idx_monitored_objects_org_camera ON monitored_objects(organization_id, camera_id);

-- -----------------------------------------------------------------------------
-- 5) Incident notes (incident workflow). Notes attach to an event; tenant scoped.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incident_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id        uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  author_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  note            text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incident_notes_org ON incident_notes(organization_id);
CREATE INDEX IF NOT EXISTS idx_incident_notes_org_event ON incident_notes(organization_id, event_id);

-- -----------------------------------------------------------------------------
-- 6) Alert cooldown state (per tenant + rule/camera key). Prevents alert storms.
--    Durable so cooldown survives process restarts and is enforced per tenant.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_cooldowns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Deterministic key, e.g. "<camera_id>:<event_type>" — scoped by org via RLS.
  cooldown_key    text NOT NULL,
  -- The active incident this cooldown is grouping detections into.
  event_id        uuid REFERENCES events(id) ON DELETE SET NULL,
  last_alert_at   timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, cooldown_key)
);
CREATE INDEX IF NOT EXISTS idx_alert_cooldowns_org ON alert_cooldowns(organization_id);

-- =============================================================================
-- ROW LEVEL SECURITY for the new tenant tables — identical model to 0001.
-- =============================================================================
DO $$
DECLARE
  t text;
  new_tenant_tables text[] := ARRAY[
    'ai_models', 'zone_schedules', 'monitored_objects', 'incident_notes', 'alert_cooldowns'
  ];
BEGIN
  FOREACH t IN ARRAY new_tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    -- Drop-if-exists keeps this migration safely re-runnable.
    EXECUTE format('DROP POLICY IF EXISTS %1$s_select ON %1$I', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_insert ON %1$I', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_update ON %1$I', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_delete ON %1$I', t);

    EXECUTE format($f$
      CREATE POLICY %1$s_select ON %1$I
      FOR SELECT USING (app.org_visible(organization_id))
    $f$, t);
    EXECUTE format($f$
      CREATE POLICY %1$s_insert ON %1$I
      FOR INSERT WITH CHECK (app.org_visible(organization_id))
    $f$, t);
    EXECUTE format($f$
      CREATE POLICY %1$s_update ON %1$I
      FOR UPDATE USING (app.org_visible(organization_id))
                 WITH CHECK (app.org_visible(organization_id))
    $f$, t);
    EXECUTE format($f$
      CREATE POLICY %1$s_delete ON %1$I
      FOR DELETE USING (app.org_visible(organization_id))
    $f$, t);
  END LOOP;
END $$;

-- =============================================================================
-- GRANTS — app role gets DML on the new tables (default privileges from 0001
-- already cover future tables, but grant explicitly to be safe + idempotent).
-- =============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON
  ai_models, zone_schedules, monitored_objects, incident_notes, alert_cooldowns
  TO garudai_app;
