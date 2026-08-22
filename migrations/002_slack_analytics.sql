-- Migration: 002_slack_analytics
-- Description: Engagement + unified analytics tables for the engagement tracker
--
-- Run with your app's migration runner, e.g.:
--   psql $DATABASE_URL -f node_modules/@tbp/boltkit/migrations/002_slack_analytics.sql
-- If you use non-default table names, adapt names here and pass matching
-- `tables` options to createEngagementTracker().

-- ============================================================================
-- TABLE: slack_engagement
-- Home-tab visits + whether an action followed (bounce rate)
-- ============================================================================

CREATE TABLE IF NOT EXISTS slack_engagement (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(20) NOT NULL,
  team_id VARCHAR(20),
  tab VARCHAR(20) NOT NULL DEFAULT 'home',
  opened_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  action_taken BOOLEAN DEFAULT FALSE,
  action_id VARCHAR(100),
  action_at TIMESTAMP WITH TIME ZONE,
  session_duration_ms INTEGER,
  CONSTRAINT unique_user_session UNIQUE (user_id, opened_at)
);

CREATE INDEX IF NOT EXISTS idx_slack_engagement_user_id ON slack_engagement(user_id);
CREATE INDEX IF NOT EXISTS idx_slack_engagement_opened_at ON slack_engagement(opened_at);

-- ============================================================================
-- TABLE: slack_analytics
-- Unified event stream for all features (adoption, funnels, performance)
-- ============================================================================

CREATE TABLE IF NOT EXISTS slack_analytics (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL,
  user_id VARCHAR(20) NOT NULL,
  user_name VARCHAR(100),
  team_id VARCHAR(20),
  channel_id VARCHAR(20),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Event-specific metadata (flexible JSON)
  metadata JSONB DEFAULT '{}',

  -- Common fields for quick filtering
  feature VARCHAR(20),
  search_query VARCHAR(500),
  result_count INTEGER,
  duration_ms INTEGER,
  success BOOLEAN DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_slack_analytics_event_type ON slack_analytics(event_type);
CREATE INDEX IF NOT EXISTS idx_slack_analytics_user_id ON slack_analytics(user_id);
CREATE INDEX IF NOT EXISTS idx_slack_analytics_created_at ON slack_analytics(created_at);
CREATE INDEX IF NOT EXISTS idx_slack_analytics_feature ON slack_analytics(feature);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE slack_engagement IS
  'Home-tab visit tracking with action follow-through for bounce-rate analysis';

COMMENT ON TABLE slack_analytics IS
  'Unified analytics event stream; event_type values are defined by the consuming app';
