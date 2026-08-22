--
-- Migration: 003_feature_access
-- Description: Ring-fencing for pilot/coming-soon features
--              Allows invite-only access via /command add @user
--
-- Run with your app's migration runner, e.g.:
--   psql $DATABASE_URL -f node_modules/@tbp/boltkit/migrations/003_feature_access.sql
-- If you use non-default table names, adapt names here and pass matching
-- `tables` options to createFeatureAccess().

-- ============================================================================
-- FEATURE ACCESS TABLE
-- Tracks which users have access to pilot/coming-soon features
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.feature_access (
    id SERIAL PRIMARY KEY,

    -- Feature identification
    feature_key VARCHAR(50) NOT NULL,

    -- User who has access
    slack_user_id VARCHAR(50) NOT NULL,         -- Slack user ID
    slack_user_name VARCHAR(100),               -- Display name (for reference)

    -- Who granted access
    granted_by_user_id VARCHAR(50),             -- Slack user ID who added them
    granted_by_user_name VARCHAR(100),          -- Display name (for reference)

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Ensure unique per feature + user
    CONSTRAINT unique_feature_user UNIQUE (feature_key, slack_user_id)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_feature_access_lookup
    ON public.feature_access(feature_key, slack_user_id);

CREATE INDEX IF NOT EXISTS idx_feature_access_feature
    ON public.feature_access(feature_key);

CREATE INDEX IF NOT EXISTS idx_feature_access_user
    ON public.feature_access(slack_user_id);


-- ============================================================================
-- FEATURE ACCESS LOG
-- Audit trail of access grants/revokes and access attempts
-- Links to engagement analytics
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.feature_access_log (
    id SERIAL PRIMARY KEY,

    -- Event type
    event_type VARCHAR(50) NOT NULL,            -- 'access_granted', 'access_revoked',
                                                -- 'access_denied', 'access_checked'

    -- Feature and user
    feature_key VARCHAR(50) NOT NULL,
    slack_user_id VARCHAR(50) NOT NULL,
    slack_user_name VARCHAR(100),

    -- For grant/revoke events
    target_user_id VARCHAR(50),                 -- User being granted/revoked
    target_user_name VARCHAR(100),

    -- Context
    channel_id VARCHAR(50),                     -- Where the command was run

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Additional metadata
    metadata JSONB DEFAULT '{}'
);

-- Indexes for analytics queries
CREATE INDEX IF NOT EXISTS idx_feature_access_log_event
    ON public.feature_access_log(event_type);

CREATE INDEX IF NOT EXISTS idx_feature_access_log_feature
    ON public.feature_access_log(feature_key);

CREATE INDEX IF NOT EXISTS idx_feature_access_log_created
    ON public.feature_access_log(created_at);


-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE public.feature_access IS
    'Tracks which users have access to pilot/coming-soon features';

COMMENT ON TABLE public.feature_access_log IS
    'Audit trail for feature access grants, revokes, and denied attempts';

COMMENT ON COLUMN public.feature_access.feature_key IS
    'Feature identifier matching the `key` in your features config';
