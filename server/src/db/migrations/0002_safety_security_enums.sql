-- =============================================================================
-- SentriAI ADD-ON — Safety & Security AI: enum extensions ONLY
-- =============================================================================
-- This migration is intentionally isolated because PostgreSQL requires new enum
-- values added with ALTER TYPE ... ADD VALUE to be COMMITTED before they can be
-- referenced (e.g. in defaults, table data, or CHECKs) later. Migration 0003
-- creates the tables/columns that USE these values.
--
-- All changes here are purely ADDITIVE. No existing value is renamed or removed,
-- so every existing event/rule row and all existing code paths keep working.
-- =============================================================================

-- --- New AI event / rule types (Safety & Security AI) ---
-- Fire & Safety
ALTER TYPE ai_rule_type ADD VALUE IF NOT EXISTS 'FIRE';
ALTER TYPE ai_rule_type ADD VALUE IF NOT EXISTS 'SMOKE';
ALTER TYPE ai_rule_type ADD VALUE IF NOT EXISTS 'FIRE_AND_SMOKE';
-- Theft / Security
ALTER TYPE ai_rule_type ADD VALUE IF NOT EXISTS 'UNAUTHORIZED_ENTRY';
ALTER TYPE ai_rule_type ADD VALUE IF NOT EXISTS 'AFTER_HOURS_ACTIVITY';
ALTER TYPE ai_rule_type ADD VALUE IF NOT EXISTS 'OBJECT_REMOVED';
ALTER TYPE ai_rule_type ADD VALUE IF NOT EXISTS 'LOITERING_SECURITY';
ALTER TYPE ai_rule_type ADD VALUE IF NOT EXISTS 'UNAUTHORIZED_VEHICLE';
ALTER TYPE ai_rule_type ADD VALUE IF NOT EXISTS 'RESTRICTED_ZONE_ACTIVITY';

-- --- New incident-workflow statuses (extends existing event_status) ---
ALTER TYPE event_status ADD VALUE IF NOT EXISTS 'INVESTIGATING';
ALTER TYPE event_status ADD VALUE IF NOT EXISTS 'FALSE_POSITIVE';

-- --- New notification channels (extends existing notify_channel) ---
ALTER TYPE notify_channel ADD VALUE IF NOT EXISTS 'WHATSAPP';
ALTER TYPE notify_channel ADD VALUE IF NOT EXISTS 'PUSH';

-- --- Model-type enum for the AI model abstraction (new) ---
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ai_model_type') THEN
    CREATE TYPE ai_model_type AS ENUM (
      'PERSON', 'VEHICLE', 'FIRE', 'SMOKE', 'OBJECT_TRACKING', 'GENERIC_SECURITY'
    );
  END IF;
END $$;
