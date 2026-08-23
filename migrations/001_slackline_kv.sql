-- Migration: 001_slackline_kv
-- Description: The single table backing ext/postgres-storage.js — slackline's
--   namespaced KV storage (OAuth installations, feature access, engagement).
--
-- Run with your app's migration runner, e.g.:
--   psql $DATABASE_URL -f node_modules/@tbp/slackline/migrations/001_slackline_kv.sql
-- If you use a different table name, adapt it here and pass a matching
-- `table` option to postgresStorage().

CREATE TABLE IF NOT EXISTS slackline_kv (
  ns TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (ns, key)
);

-- Prefix listings (list(ns, {prefix})) use the primary key's (ns, key) order.

COMMENT ON TABLE slackline_kv IS
  'slackline storage contract: namespaced KV with JSONB values. Namespaces in use: installations, feature-access, feature-access-log, engagement, analytics.';
