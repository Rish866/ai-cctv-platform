-- =============================================================================
-- GarudAI — Initial schema + Row Level Security (RLS)
-- =============================================================================
-- Security model
-- --------------
-- Tenant isolation is enforced at THREE layers; this file is the deepest one.
--
--   1. PostgreSQL RLS (this file) — the database itself refuses to return or
--      mutate rows that do not belong to the caller's organization.
--   2. Backend authorization (tenant context middleware).
--   3. Frontend (display only — never trusted for security).
--
-- Every request runs as the NON-SUPERUSER role `garudai_app`, which has
-- NOBYPASSRLS. The backend opens a transaction and sets two GUCs:
--
--   SET LOCAL app.current_org        = '<organization uuid>';
--   SET LOCAL app.current_user       = '<user uuid>';
--   SET LOCAL app.is_platform_admin  = 'on' | 'off';
--
-- Policies read those GUCs via app.current_org() / app.is_platform_admin().
-- If app.current_org is unset/empty, the helper returns NULL and every policy
-- evaluates to FALSE => the request FAILS CLOSED (zero rows, no writes).
-- =============================================================================

-- gen_random_uuid() is built into PostgreSQL 13+ core (no extension needed).

-- -----------------------------------------------------------------------------
-- Tenant-context helper functions (SECURITY layer accessors)
-- -----------------------------------------------------------------------------
-- Schema to hold helpers so they cannot be shadowed by tenant data.
CREATE SCHEMA IF NOT EXISTS app;

-- Returns the current organization UUID from the session GUC, or NULL if unset.
-- NULL => policies fail closed (no rows visible, no writes permitted).
CREATE OR REPLACE FUNCTION app.current_org() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_org', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_user', true), '')::uuid
$$;

-- Platform admin bypass — only ever set true for verified PLATFORM_ADMIN users,
-- and even then scoped per request. Defaults to false (fail closed).
CREATE OR REPLACE FUNCTION app.is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.is_platform_admin', true), ''), 'off') = 'on'
$$;

-- Convenience predicate used by every tenant policy.
-- A row is accessible when either:
--   * the caller is a verified platform admin, OR
--   * the row's organization_id equals the session's current_org (never NULL match).
CREATE OR REPLACE FUNCTION app.org_visible(row_org uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app.is_platform_admin()
      OR (app.current_org() IS NOT NULL AND row_org = app.current_org())
$$;

-- =============================================================================
-- ENUM types
-- =============================================================================
CREATE TYPE org_role       AS ENUM ('OWNER', 'ADMIN', 'OPERATOR', 'VIEWER');
CREATE TYPE member_status  AS ENUM ('ACTIVE', 'INVITED', 'SUSPENDED');
CREATE TYPE camera_status  AS ENUM ('ONLINE', 'OFFLINE', 'DEGRADED', 'UNKNOWN');
CREATE TYPE event_severity AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE event_status   AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');
CREATE TYPE evidence_kind  AS ENUM ('SNAPSHOT', 'CLIP');
CREATE TYPE ai_rule_type   AS ENUM (
  'PERSON_DETECTION', 'VEHICLE_DETECTION', 'RESTRICTED_AREA_INTRUSION',
  'LINE_CROSSING', 'LOITERING', 'CROWD_DETECTION', 'HELMET_DETECTION',
  'SAFETY_VEST_DETECTION'
);
CREATE TYPE notify_channel AS ENUM ('EMAIL', 'SMS', 'WEBHOOK', 'IN_APP');
CREATE TYPE subscription_plan AS ENUM ('TRIAL', 'STARTER', 'GROWTH', 'ENTERPRISE');
CREATE TYPE subscription_status AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED');
CREATE TYPE invoice_status AS ENUM ('DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE');

-- =============================================================================
-- GLOBAL (platform-level) tables — NOT tenant scoped
-- =============================================================================

-- Users are global identities. A user may belong to multiple organizations via
-- organization_members. `is_platform_admin` grants platform-wide read access.
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  password_hash     text NOT NULL,
  full_name         text NOT NULL,
  is_platform_admin boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- Case-insensitive unique email.
CREATE UNIQUE INDEX uq_users_email_lower ON users (lower(email));

-- Organizations (tenants). The organization_id column here IS the primary key.
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  is_demo     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Sessions (server-side session store). Bound to a user; cookie carries only id.
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The active organization for this session (must be one the user belongs to).
  active_org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           text,
  user_agent   text
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- =============================================================================
-- TENANT-OWNED tables — every row carries organization_id UUID NOT NULL
-- =============================================================================

CREATE TABLE organization_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            org_role NOT NULL DEFAULT 'VIEWER',
  status          member_status NOT NULL DEFAULT 'ACTIVE',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);
CREATE INDEX idx_members_org ON organization_members(organization_id);
CREATE INDEX idx_members_user ON organization_members(user_id);

CREATE TABLE sites (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  address         text,
  timezone        text NOT NULL DEFAULT 'UTC',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sites_org ON sites(organization_id);

CREATE TABLE zones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id         uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name            text NOT NULL,
  -- Polygon / rule geometry as JSON (line for line-crossing, polygon for area).
  geometry        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_zones_org ON zones(organization_id);
CREATE INDEX idx_zones_org_site ON zones(organization_id, site_id);

CREATE TABLE cameras (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id         uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  zone_id         uuid REFERENCES zones(id) ON DELETE SET NULL,
  name            text NOT NULL,
  -- RTSP host/path stored WITHOUT credentials. Credentials live encrypted in
  -- camera_credentials and are never exposed to the browser.
  rtsp_host       text,
  rtsp_path       text,
  onvif_endpoint  text,
  status          camera_status NOT NULL DEFAULT 'UNKNOWN',
  last_seen_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_cameras_org ON cameras(organization_id);
CREATE INDEX idx_cameras_org_site ON cameras(organization_id, site_id);
CREATE INDEX idx_cameras_org_status ON cameras(organization_id, status);

-- Highly sensitive: encrypted at rest (AES-256-GCM) by the application layer.
-- One row per camera. The ciphertext is opaque to the DB.
CREATE TABLE camera_credentials (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  camera_id       uuid NOT NULL UNIQUE REFERENCES cameras(id) ON DELETE CASCADE,
  username_enc    text NOT NULL,   -- base64(iv:tag:ciphertext)
  password_enc    text NOT NULL,   -- base64(iv:tag:ciphertext)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_camcreds_org ON camera_credentials(organization_id);

CREATE TABLE ai_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  camera_id       uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  zone_id         uuid REFERENCES zones(id) ON DELETE SET NULL,
  rule_type       ai_rule_type NOT NULL,
  enabled         boolean NOT NULL DEFAULT true,
  min_confidence  numeric(4,3) NOT NULL DEFAULT 0.500 CHECK (min_confidence >= 0 AND min_confidence <= 1),
  severity        event_severity NOT NULL DEFAULT 'MEDIUM',
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_airules_org ON ai_rules(organization_id);
CREATE INDEX idx_airules_org_camera ON ai_rules(organization_id, camera_id);

CREATE TABLE events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id         uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  camera_id       uuid NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  ai_rule_id      uuid REFERENCES ai_rules(id) ON DELETE SET NULL,
  event_type      ai_rule_type NOT NULL,
  severity        event_severity NOT NULL DEFAULT 'MEDIUM',
  confidence      numeric(4,3) NOT NULL DEFAULT 0.000 CHECK (confidence >= 0 AND confidence <= 1),
  status          event_status NOT NULL DEFAULT 'OPEN',
  -- Idempotency / pipeline correlation id (from the AI worker).
  correlation_id  text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_org ON events(organization_id);
CREATE INDEX idx_events_org_camera ON events(organization_id, camera_id);
CREATE INDEX idx_events_org_time ON events(organization_id, occurred_at DESC);
CREATE INDEX idx_events_org_type ON events(organization_id, event_type);
CREATE INDEX idx_events_org_status ON events(organization_id, status);
CREATE UNIQUE INDEX uq_events_org_correlation ON events(organization_id, correlation_id) WHERE correlation_id IS NOT NULL;

-- Per-object detections that make up an event (bounding boxes etc.).
CREATE TABLE event_detections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id        uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  label           text NOT NULL,
  confidence      numeric(4,3) NOT NULL DEFAULT 0.000,
  bbox            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_detections_org ON event_detections(organization_id);
CREATE INDEX idx_detections_org_event ON event_detections(organization_id, event_id);

-- Evidence (snapshot / clip). storage_key is a tenant-scoped object path; the
-- object store keeps it PRIVATE and access is only via short-lived signed URLs.
CREATE TABLE event_evidence (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id        uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind            evidence_kind NOT NULL,
  storage_key     text NOT NULL, -- organizations/{org}/sites/{site}/cameras/{cam}/events/{event}/...
  content_type    text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes      bigint,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_evidence_org ON event_evidence(organization_id);
CREATE INDEX idx_evidence_org_event ON event_evidence(organization_id, event_id);

CREATE TABLE notification_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  channel         notify_channel NOT NULL,
  -- Recipient target (email address, phone, webhook url). Tenant scoped.
  target          text NOT NULL,
  min_severity    event_severity NOT NULL DEFAULT 'HIGH',
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifrules_org ON notification_rules(organization_id);

CREATE TABLE notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id            uuid REFERENCES events(id) ON DELETE CASCADE,
  notification_rule_id uuid REFERENCES notification_rules(id) ON DELETE SET NULL,
  channel             notify_channel NOT NULL,
  target              text NOT NULL,
  message             text NOT NULL,
  read_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_org ON notifications(organization_id);
CREATE INDEX idx_notifications_org_time ON notifications(organization_id, created_at DESC);

CREATE TABLE reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  kind            text NOT NULL DEFAULT 'EVENT_SUMMARY',
  params          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_reports_org ON reports(organization_id);

CREATE TABLE subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  plan            subscription_plan NOT NULL DEFAULT 'TRIAL',
  status          subscription_status NOT NULL DEFAULT 'TRIALING',
  camera_limit    integer NOT NULL DEFAULT 5,
  current_period_end timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_subscriptions_org ON subscriptions(organization_id);

CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number          text NOT NULL,
  status          invoice_status NOT NULL DEFAULT 'DRAFT',
  amount_cents    bigint NOT NULL DEFAULT 0,
  currency        text NOT NULL DEFAULT 'USD',
  period_start    timestamptz,
  period_end      timestamptz,
  issued_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, number)
);
CREATE INDEX idx_invoices_org ON invoices(organization_id);

CREATE TABLE audit_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  action          text NOT NULL,
  resource        text NOT NULL,
  resource_id     text,
  ip              text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_org ON audit_logs(organization_id);
CREATE INDEX idx_audit_org_time ON audit_logs(organization_id, created_at DESC);

-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================
-- Enable + FORCE RLS on every tenant table. FORCE ensures even the table owner
-- is subject to policies (defense in depth); the app role is not owner anyway.
--
-- Policy shape for a tenant table T with column organization_id:
--   USING       (app.org_visible(organization_id))         -- read / update-visibility / delete
--   WITH CHECK  (app.org_visible(organization_id))         -- insert / post-update row must stay in org
-- Platform admins pass org_visible() unconditionally; everyone else must match
-- the session's current_org, which the client cannot forge.
-- =============================================================================

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'organization_members','sites','zones','cameras','camera_credentials',
    'ai_rules','events','event_detections','event_evidence',
    'notification_rules','notifications','reports','subscriptions',
    'invoices','audit_logs'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    -- SELECT: only rows in the caller's org (or platform admin).
    EXECUTE format($f$
      CREATE POLICY %1$s_select ON %1$I
      FOR SELECT USING (app.org_visible(organization_id))
    $f$, t);

    -- INSERT: new row must belong to the caller's org.
    EXECUTE format($f$
      CREATE POLICY %1$s_insert ON %1$I
      FOR INSERT WITH CHECK (app.org_visible(organization_id))
    $f$, t);

    -- UPDATE: can only see + must keep the row in the caller's org.
    EXECUTE format($f$
      CREATE POLICY %1$s_update ON %1$I
      FOR UPDATE USING (app.org_visible(organization_id))
                 WITH CHECK (app.org_visible(organization_id))
    $f$, t);

    -- DELETE: can only delete rows in the caller's org.
    EXECUTE format($f$
      CREATE POLICY %1$s_delete ON %1$I
      FOR DELETE USING (app.org_visible(organization_id))
    $f$, t);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- RLS for the `organizations` table itself.
-- A caller may see an organization only if it is their current_org (or they are
-- a platform admin). Inserts are allowed (signup creates an org) but the backend
-- gates who may call it; updates/deletes restricted to the current org.
-- -----------------------------------------------------------------------------
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;

CREATE POLICY organizations_select ON organizations
  FOR SELECT USING (app.is_platform_admin() OR (app.current_org() IS NOT NULL AND id = app.current_org()));

-- Signup path: the org is created inside a transaction where current_org is set
-- to the freshly generated id (see backend). WITH CHECK enforces that match.
CREATE POLICY organizations_insert ON organizations
  FOR INSERT WITH CHECK (app.is_platform_admin() OR (app.current_org() IS NOT NULL AND id = app.current_org()));

CREATE POLICY organizations_update ON organizations
  FOR UPDATE USING (app.is_platform_admin() OR (app.current_org() IS NOT NULL AND id = app.current_org()))
             WITH CHECK (app.is_platform_admin() OR (app.current_org() IS NOT NULL AND id = app.current_org()));

CREATE POLICY organizations_delete ON organizations
  FOR DELETE USING (app.is_platform_admin() OR (app.current_org() IS NOT NULL AND id = app.current_org()));

-- -----------------------------------------------------------------------------
-- RLS for `users`.
-- Users are global, but must NOT be broadly readable across tenants. A caller
-- may read a user row only when that user is a member of the caller's current
-- org (or the caller is that user, or a platform admin). This prevents tenant A
-- from enumerating tenant B's user accounts.
-- -----------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY users_select ON users
  FOR SELECT USING (
    app.is_platform_admin()
    OR id = app.current_user_id()
    OR EXISTS (
      SELECT 1 FROM organization_members m
      WHERE m.user_id = users.id
        AND app.current_org() IS NOT NULL
        AND m.organization_id = app.current_org()
    )
  );

-- Signup must be able to create a user before any org context exists. We allow
-- INSERT broadly at the DB layer but the backend is the only writer and applies
-- validation + rate limiting. (No org leakage: users carry no organization_id.)
CREATE POLICY users_insert ON users
  FOR INSERT WITH CHECK (true);

-- A user may update only their own record (or platform admin).
CREATE POLICY users_update ON users
  FOR UPDATE USING (app.is_platform_admin() OR id = app.current_user_id())
             WITH CHECK (app.is_platform_admin() OR id = app.current_user_id());

CREATE POLICY users_delete ON users
  FOR DELETE USING (app.is_platform_admin() OR id = app.current_user_id());

-- -----------------------------------------------------------------------------
-- RLS for `sessions`. A session is readable/writable only by its owning user.
-- -----------------------------------------------------------------------------
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

-- Session lookup during authentication happens BEFORE current_user is known, so
-- the backend performs session resolution using the ADMIN connection in a tightly
-- scoped helper (see db/pool.ts). At the app-role layer we still restrict to the
-- owning user for any session touched inside an authenticated request.
CREATE POLICY sessions_select ON sessions
  FOR SELECT USING (app.is_platform_admin() OR user_id = app.current_user_id());
CREATE POLICY sessions_insert ON sessions
  FOR INSERT WITH CHECK (true);
CREATE POLICY sessions_update ON sessions
  FOR UPDATE USING (app.is_platform_admin() OR user_id = app.current_user_id())
             WITH CHECK (app.is_platform_admin() OR user_id = app.current_user_id());
CREATE POLICY sessions_delete ON sessions
  FOR DELETE USING (app.is_platform_admin() OR user_id = app.current_user_id());

-- =============================================================================
-- GRANTS
-- =============================================================================
-- The app role gets DML on all tables but is NOSUPERUSER + NOBYPASSRLS, so RLS
-- fully governs what it can touch. It gets NO DDL and cannot disable RLS.
-- =============================================================================
GRANT USAGE ON SCHEMA app TO garudai_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO garudai_app;
GRANT USAGE ON SCHEMA public TO garudai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO garudai_app;
-- Future tables created by migrations (superuser) — grant automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO garudai_app;
