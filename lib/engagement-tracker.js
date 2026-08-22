'use strict';

/**
 * Slack Engagement / Analytics Tracker
 *
 * Two tables:
 * - engagement: home-tab visits + whether an action followed (bounce rate)
 * - analytics: unified event stream for all features (adoption, funnels,
 *   performance, error rates)
 *
 * Event types are injected by the consuming app (see `eventTypes`); the
 * library only ships the feature-agnostic CoreEventType. Schema:
 * migrations/002_slack_analytics.sql.
 */

const { normalizeLogger } = require('./logger');

const IDENTIFIER_RE = /^[a-z_][a-z0-9_.]*$/i;

// Feature-agnostic event types every Slack app has
const CoreEventType = {
  HOME_OPENED: 'home_opened',
  HOME_ACTION: 'home_action',
};

/**
 * Create an engagement tracker.
 *
 * @param {Object} options
 * @param {Object} [options.pool] - pg Pool; null makes every method a no-op
 * @param {Object} [options.logger] - pino-like logger
 * @param {Object<string,string>} [options.eventTypes] - App-specific event
 *   type enum, merged over CoreEventType and exposed as `EventType`
 * @param {{engagement?: string, analytics?: string}} [options.tables]
 */
function createEngagementTracker({
  pool = null,
  logger: rawLogger,
  eventTypes = {},
  tables = {},
} = {}) {
  const logger = normalizeLogger(rawLogger);
  const engagementTable = tables.engagement || 'slack_engagement';
  const analyticsTable = tables.analytics || 'slack_analytics';

  for (const table of [engagementTable, analyticsTable]) {
    if (!IDENTIFIER_RE.test(table)) {
      throw new Error(`Invalid engagement-tracker table name: ${table}`);
    }
  }

  const EventType = Object.freeze({ ...CoreEventType, ...eventTypes });

  /**
   * Initialize the analytics tables if they don't exist. Idempotent; prefer
   * running the migration file instead.
   */
  async function initializeTables() {
    if (!pool) {
      logger.warn('No database pool, analytics tracking disabled');
      return false;
    }

    try {
      // Home tab engagement table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${engagementTable} (
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
        CREATE INDEX IF NOT EXISTS idx_slack_engagement_user_id ON ${engagementTable}(user_id);
        CREATE INDEX IF NOT EXISTS idx_slack_engagement_opened_at ON ${engagementTable}(opened_at);
      `);

      // Unified analytics table for all features
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${analyticsTable} (
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

        CREATE INDEX IF NOT EXISTS idx_slack_analytics_event_type ON ${analyticsTable}(event_type);
        CREATE INDEX IF NOT EXISTS idx_slack_analytics_user_id ON ${analyticsTable}(user_id);
        CREATE INDEX IF NOT EXISTS idx_slack_analytics_created_at ON ${analyticsTable}(created_at);
        CREATE INDEX IF NOT EXISTS idx_slack_analytics_feature ON ${analyticsTable}(feature);
      `);

      logger.info('Analytics tables initialized');
      return true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize analytics tables');
      return false;
    }
  }

  /**
   * Record a home tab open event.
   * @param {string} userId - Slack user ID
   * @param {string} teamId - Slack team/workspace ID
   * @param {string} tab - Which tab was opened (home, messages)
   * @returns {Promise<{isFirstVisit: boolean, lastVisit: Date|null, visitCount: number, engagementId: number|null}>}
   */
  async function recordHomeOpen(userId, teamId, tab = 'home') {
    if (!pool) {
      return { isFirstVisit: true, lastVisit: null, visitCount: 0, engagementId: null };
    }

    try {
      // Get user's visit history
      const historyResult = await pool.query(`
        SELECT
          COUNT(*) as visit_count,
          MAX(opened_at) as last_visit
        FROM ${engagementTable}
        WHERE user_id = $1 AND tab = $2
      `, [userId, tab]);

      const visitCount = parseInt(historyResult.rows[0]?.visit_count || 0, 10);
      const lastVisit = historyResult.rows[0]?.last_visit || null;
      const isFirstVisit = visitCount === 0;

      // Record this visit
      const insertResult = await pool.query(`
        INSERT INTO ${engagementTable} (user_id, team_id, tab, opened_at)
        VALUES ($1, $2, $3, NOW())
        RETURNING id
      `, [userId, teamId, tab]);

      const engagementId = insertResult.rows[0]?.id;

      logger.debug({
        userId,
        isFirstVisit,
        visitCount: visitCount + 1,
        daysSinceLastVisit: lastVisit ? Math.floor((Date.now() - new Date(lastVisit).getTime()) / 86400000) : null,
      }, 'Home open recorded');

      return {
        isFirstVisit,
        lastVisit,
        visitCount: visitCount + 1,
        engagementId,
      };
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to record home open');
      return { isFirstVisit: true, lastVisit: null, visitCount: 0, engagementId: null };
    }
  }

  /**
   * Record that a user took an action (clicked a button, etc.).
   * This helps calculate "bounce rate" - visits without actions.
   * @param {number} engagementId - The ID from recordHomeOpen
   * @param {string} actionId - The action_id of the button/element clicked
   */
  async function recordAction(engagementId, actionId) {
    if (!pool || !engagementId) return;

    try {
      await pool.query(`
        UPDATE ${engagementTable}
        SET action_taken = TRUE, action_id = $1, action_at = NOW()
        WHERE id = $2
      `, [actionId, engagementId]);

      logger.debug({ engagementId, actionId }, 'Action recorded');
    } catch (error) {
      logger.error({ err: error, engagementId, actionId }, 'Failed to record action');
    }
  }

  /**
   * Get engagement analytics for reporting.
   * @param {number} days - Number of days to look back
   * @returns {Promise<Object|null>} Analytics summary
   */
  async function getAnalytics(days = 30) {
    if (!pool) return null;

    try {
      const result = await pool.query(`
        SELECT
          COUNT(DISTINCT user_id) as unique_users,
          COUNT(*) as total_visits,
          COUNT(*) FILTER (WHERE action_taken = TRUE) as visits_with_action,
          ROUND(100.0 * COUNT(*) FILTER (WHERE action_taken = TRUE) / NULLIF(COUNT(*), 0), 1) as conversion_rate,
          COUNT(DISTINCT user_id) FILTER (WHERE opened_at >= NOW() - INTERVAL '7 days') as weekly_active_users
        FROM ${engagementTable}
        WHERE opened_at >= NOW() - INTERVAL '1 day' * $1
      `, [days]);

      return result.rows[0];
    } catch (error) {
      logger.error({ err: error }, 'Failed to get analytics');
      return null;
    }
  }

  /**
   * Check if a user is dormant (hasn't visited recently).
   * @param {string} userId - Slack user ID
   * @param {number} daysThreshold - Days without visit to consider dormant
   * @returns {Promise<boolean>}
   */
  async function isUserDormant(userId, daysThreshold = 14) {
    if (!pool) return false;

    try {
      const result = await pool.query(`
        SELECT MAX(opened_at) as last_visit
        FROM ${engagementTable}
        WHERE user_id = $1
      `, [userId]);

      const lastVisit = result.rows[0]?.last_visit;
      if (!lastVisit) return true; // Never visited = dormant

      const daysSinceVisit = Math.floor((Date.now() - new Date(lastVisit).getTime()) / 86400000);
      return daysSinceVisit >= daysThreshold;
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to check dormancy');
      return false;
    }
  }

  /**
   * Track any event in the unified analytics table.
   * @param {string} eventType - One of EventType values
   * @param {Object} data - Event data
   * @param {string} data.userId - Slack user ID (required)
   * @param {string} [data.userName] - User's display name
   * @param {string} [data.teamId] - Slack workspace ID
   * @param {string} [data.channelId] - Channel where action occurred
   * @param {string} [data.feature] - Feature category
   * @param {string} [data.searchQuery] - Search query if applicable
   * @param {number} [data.resultCount] - Number of results
   * @param {number} [data.durationMs] - Operation duration
   * @param {boolean} [data.success] - Whether operation succeeded
   * @param {Object} [data.metadata] - Additional JSON metadata
   * @returns {Promise<number|null>} Inserted event id
   */
  async function trackEvent(eventType, data = {}) {
    if (!pool) return null;

    const {
      userId,
      userName,
      teamId,
      channelId,
      feature,
      searchQuery,
      resultCount,
      durationMs,
      success = true,
      metadata = {},
    } = data;

    if (!userId) {
      logger.warn({ eventType }, 'trackEvent called without userId');
      return null;
    }

    try {
      const result = await pool.query(`
        INSERT INTO ${analyticsTable}
          (event_type, user_id, user_name, team_id, channel_id, feature, search_query, result_count, duration_ms, success, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id
      `, [
        eventType,
        userId,
        userName || null,
        teamId || null,
        channelId || null,
        feature || null,
        searchQuery || null,
        resultCount || null,
        durationMs || null,
        success,
        JSON.stringify(metadata),
      ]);

      logger.debug({
        eventType,
        userId,
        feature,
        eventId: result.rows[0]?.id,
      }, 'Event tracked');

      return result.rows[0]?.id;
    } catch (error) {
      logger.error({ err: error, eventType, userId }, 'Failed to track event');
      return null;
    }
  }

  /**
   * Build a convenience tracker bound to an event type, e.g.:
   *
   *   const track = {
   *     searchCompleted: tracker.defineTracker(EventType.SEARCH_COMPLETED, { feature: 'search' }),
   *   };
   *   await track.searchCompleted({ userId, searchQuery, resultCount });
   *
   * @param {string} eventType
   * @param {Object} [defaults] - Data merged under the per-call data
   * @returns {(data?: Object) => Promise<number|null>}
   */
  function defineTracker(eventType, defaults = {}) {
    return (data = {}) => trackEvent(eventType, { ...defaults, ...data, metadata: { ...defaults.metadata, ...data.metadata } });
  }

  /**
   * Get feature usage summary.
   * @param {number} days - Number of days to look back
   */
  async function getFeatureUsage(days = 30) {
    if (!pool) return null;

    try {
      const result = await pool.query(`
        SELECT
          feature,
          event_type,
          COUNT(*) as event_count,
          COUNT(DISTINCT user_id) as unique_users,
          AVG(duration_ms) as avg_duration_ms,
          COUNT(*) FILTER (WHERE success = FALSE) as error_count
        FROM ${analyticsTable}
        WHERE created_at >= NOW() - INTERVAL '1 day' * $1
          AND feature IS NOT NULL
        GROUP BY feature, event_type
        ORDER BY feature, event_count DESC
      `, [days]);

      return result.rows;
    } catch (error) {
      logger.error({ err: error }, 'Failed to get feature usage');
      return null;
    }
  }

  return {
    // Table init
    initializeTables,

    // Home tab engagement
    recordHomeOpen,
    recordAction,
    getAnalytics,
    isUserDormant,

    // Unified analytics
    EventType,
    trackEvent,
    defineTracker,
    getFeatureUsage,
  };
}

module.exports = { createEngagementTracker, CoreEventType };
