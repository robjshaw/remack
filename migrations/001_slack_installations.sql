-- Migration: 001_slack_installations
-- Description: OAuth installation store for org-ready Slack apps
--
-- Run with your app's migration runner, e.g.:
--   psql $DATABASE_URL -f node_modules/@tbp/boltkit/migrations/001_slack_installations.sql
-- If you use a non-default table name, adapt names here and pass a matching
-- `table` option to createInstallationStore().

-- ============================================================================
-- TABLE: public.slack_installations
-- Stores OAuth tokens per team/enterprise for multi-workspace support
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.slack_installations (
  id SERIAL PRIMARY KEY,

  -- Team/Workspace identifiers
  team_id VARCHAR(50),
  team_name VARCHAR(255),

  -- Enterprise Grid identifiers (null for non-enterprise)
  enterprise_id VARCHAR(50),
  enterprise_name VARCHAR(255),

  -- Installation metadata
  is_enterprise_install BOOLEAN DEFAULT FALSE,
  installed_by_user_id VARCHAR(50),

  -- Bot credentials
  bot_token TEXT NOT NULL,
  bot_id VARCHAR(50),
  bot_user_id VARCHAR(50),
  bot_scopes TEXT[], -- Array of granted scopes

  -- User token (if user scopes requested)
  user_token TEXT,
  user_id VARCHAR(50),
  user_scopes TEXT[],

  -- App reference
  app_id VARCHAR(50),

  -- Token metadata
  token_type VARCHAR(20) DEFAULT 'bot',

  -- Timestamps
  installed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Unique constraint: one installation per team (or enterprise for org-wide)
  CONSTRAINT unique_installation UNIQUE (team_id, enterprise_id, is_enterprise_install)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_slack_installations_team
  ON public.slack_installations(team_id);

CREATE INDEX IF NOT EXISTS idx_slack_installations_enterprise
  ON public.slack_installations(enterprise_id)
  WHERE enterprise_id IS NOT NULL;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE public.slack_installations IS
  'OAuth installation store for Slack app - supports single workspace and Enterprise Grid';

COMMENT ON COLUMN public.slack_installations.bot_token IS
  'xoxb-* token for bot actions';

COMMENT ON COLUMN public.slack_installations.is_enterprise_install IS
  'True if installed at org level (Enterprise Grid), false for single workspace';
