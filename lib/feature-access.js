'use strict';

/**
 * Feature Access Control
 *
 * Ring-fencing system for pilot/coming-soon features.
 * - Live features (requiresAccess: false): available to everyone
 * - Pilot/Coming Soon (requiresAccess: true): invite-only via /command add @user
 *
 * Analytics captured in the access log:
 * - Feature adoption curves
 * - Who's adding whom (viral growth)
 * - Access denied patterns (demand signal)
 *
 * Schema: migrations/003_feature_access.sql.
 */

const { normalizeLogger } = require('./logger');
const { extractUserId } = require('./helpers');

const IDENTIFIER_RE = /^[a-z_][a-z0-9_.]*$/i;

// Event types for logging
const AccessEventType = {
  ACCESS_GRANTED: 'access_granted',
  ACCESS_REVOKED: 'access_revoked',
  ACCESS_DENIED: 'access_denied',
  ACCESS_CHECKED: 'access_checked',
};

/**
 * @typedef {Object} FeatureConfig
 * @property {string} key - Stable key stored in the DB (e.g. 'buyer_list')
 * @property {string} name - Human-readable name (e.g. 'M&A Buyer Matching')
 * @property {string} status - 'live' | 'pilot' | 'coming_soon'
 * @property {boolean} requiresAccess - false = everyone; true = invite-only
 * @property {string} [docsUrl] - Optional docs link shown in denial messages
 */

/**
 * Create a feature-access service.
 *
 * @param {Object} options
 * @param {Object} [options.pool] - pg Pool; null disables persistence (see failOpen)
 * @param {Object} [options.logger] - pino-like logger
 * @param {Object<string, FeatureConfig>} options.features - Keyed by command
 *   name (e.g. 'buyer-list'). Replaces any hardcoded feature registry.
 * @param {boolean} [options.failOpen] - When the DB is missing or errors,
 *   allow access (default true)
 * @param {{access?: string, log?: string}} [options.tables]
 * @param {Function} [options.buildNoAccessMessage] - Override the default
 *   denial message builder; receives (featureCommand, config)
 */
function createFeatureAccess({
  pool = null,
  logger: rawLogger,
  features = {},
  failOpen = true,
  tables = {},
  buildNoAccessMessage: customNoAccessMessage,
} = {}) {
  const logger = normalizeLogger(rawLogger);
  const accessTable = tables.access || 'public.feature_access';
  const logTable = tables.log || 'public.feature_access_log';

  for (const table of [accessTable, logTable]) {
    if (!IDENTIFIER_RE.test(table)) {
      throw new Error(`Invalid feature-access table name: ${table}`);
    }
  }

  const FEATURE_CONFIG = Object.freeze({ ...features });

  /**
   * Initialize feature access tables. Idempotent; prefer running the
   * migration file instead.
   */
  async function initializeTables() {
    if (!pool) {
      logger.warn('No database pool, feature access control disabled');
      return false;
    }

    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${accessTable} (
          id SERIAL PRIMARY KEY,
          feature_key VARCHAR(50) NOT NULL,
          slack_user_id VARCHAR(50) NOT NULL,
          slack_user_name VARCHAR(100),
          granted_by_user_id VARCHAR(50),
          granted_by_user_name VARCHAR(100),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          CONSTRAINT unique_feature_user UNIQUE (feature_key, slack_user_id)
        );

        CREATE TABLE IF NOT EXISTS ${logTable} (
          id SERIAL PRIMARY KEY,
          event_type VARCHAR(50) NOT NULL,
          feature_key VARCHAR(50) NOT NULL,
          slack_user_id VARCHAR(50) NOT NULL,
          slack_user_name VARCHAR(100),
          target_user_id VARCHAR(50),
          target_user_name VARCHAR(100),
          channel_id VARCHAR(50),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          metadata JSONB DEFAULT '{}'
        );

        CREATE INDEX IF NOT EXISTS idx_feature_access_lookup
          ON ${accessTable}(feature_key, slack_user_id);
      `);

      logger.info('Feature access tables initialized');
      return true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize feature access tables');
      return false;
    }
  }

  /**
   * Check if a user has access to a feature.
   * @param {string} featureCommand - The command name, e.g. 'buyer-list'
   * @param {string} slackUserId - Slack user ID
   * @returns {Promise<boolean>}
   */
  async function hasAccess(featureCommand, slackUserId) {
    const config = FEATURE_CONFIG[featureCommand];

    if (!config) {
      logger.warn({ featureCommand }, 'Unknown feature command');
      return false;
    }

    // Live features - everyone has access
    if (!config.requiresAccess) {
      return true;
    }

    if (!pool) {
      logger.warn({ failOpen }, 'No database connection for access check');
      return failOpen;
    }

    try {
      const result = await pool.query(
        `SELECT 1 FROM ${accessTable} WHERE feature_key = $1 AND slack_user_id = $2`,
        [config.key, slackUserId]
      );

      const allowed = result.rows.length > 0;

      logger.debug({
        featureCommand,
        featureKey: config.key,
        slackUserId,
        hasAccess: allowed,
      }, 'Access check performed');

      return allowed;
    } catch (error) {
      logger.error({ err: error, featureCommand, slackUserId, failOpen }, 'Failed to check access');
      return failOpen;
    }
  }

  /**
   * Grant access to a user for a feature.
   * @returns {Promise<{success: boolean, alreadyHadAccess?: boolean, error?: string}>}
   */
  async function grantAccess(featureCommand, targetUserId, targetUserName, grantedByUserId, grantedByUserName) {
    const config = FEATURE_CONFIG[featureCommand];

    if (!config) {
      return { success: false, error: 'Unknown feature' };
    }

    if (!pool) {
      return { success: false, error: 'Database not available' };
    }

    try {
      // Check if already has access
      const existing = await pool.query(
        `SELECT 1 FROM ${accessTable} WHERE feature_key = $1 AND slack_user_id = $2`,
        [config.key, targetUserId]
      );

      if (existing.rows.length > 0) {
        return { success: true, alreadyHadAccess: true };
      }

      // Grant access
      await pool.query(
        `INSERT INTO ${accessTable}
          (feature_key, slack_user_id, slack_user_name, granted_by_user_id, granted_by_user_name)
         VALUES ($1, $2, $3, $4, $5)`,
        [config.key, targetUserId, targetUserName, grantedByUserId, grantedByUserName]
      );

      // Log the grant
      await logAccessEvent(AccessEventType.ACCESS_GRANTED, config.key, grantedByUserId, grantedByUserName, {
        targetUserId,
        targetUserName,
      });

      logger.info({
        featureCommand,
        targetUserId,
        targetUserName,
        grantedByUserId,
      }, 'Access granted');

      return { success: true, alreadyHadAccess: false };
    } catch (error) {
      logger.error({ err: error, featureCommand, targetUserId }, 'Failed to grant access');
      return { success: false, error: error.message };
    }
  }

  /**
   * Revoke access from a user.
   * @returns {Promise<{success: boolean, hadAccess?: boolean, error?: string}>}
   */
  async function revokeAccess(featureCommand, targetUserId, revokedByUserId, revokedByUserName) {
    const config = FEATURE_CONFIG[featureCommand];

    if (!config) {
      return { success: false, error: 'Unknown feature' };
    }

    if (!pool) {
      return { success: false, error: 'Database not available' };
    }

    try {
      const result = await pool.query(
        `DELETE FROM ${accessTable} WHERE feature_key = $1 AND slack_user_id = $2 RETURNING id`,
        [config.key, targetUserId]
      );

      const hadAccess = result.rows.length > 0;

      if (hadAccess) {
        await logAccessEvent(AccessEventType.ACCESS_REVOKED, config.key, revokedByUserId, revokedByUserName, {
          targetUserId,
        });
      }

      return { success: true, hadAccess };
    } catch (error) {
      logger.error({ err: error, featureCommand, targetUserId }, 'Failed to revoke access');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all users with access to a feature.
   * @returns {Promise<Array<{userId: string, userName: string, grantedBy: string, grantedAt: Date}>>}
   */
  async function getAccessList(featureCommand) {
    const config = FEATURE_CONFIG[featureCommand];

    if (!config || !pool) {
      return [];
    }

    try {
      const result = await pool.query(
        `SELECT slack_user_id, slack_user_name, granted_by_user_name, created_at
         FROM ${accessTable}
         WHERE feature_key = $1
         ORDER BY created_at ASC`,
        [config.key]
      );

      return result.rows.map(row => ({
        userId: row.slack_user_id,
        userName: row.slack_user_name,
        grantedBy: row.granted_by_user_name,
        grantedAt: row.created_at,
      }));
    } catch (error) {
      logger.error({ err: error, featureCommand }, 'Failed to get access list');
      return [];
    }
  }

  /**
   * Log an access event for analytics.
   */
  async function logAccessEvent(eventType, featureKey, userId, userName, metadata = {}) {
    if (!pool) return;

    try {
      await pool.query(
        `INSERT INTO ${logTable}
          (event_type, feature_key, slack_user_id, slack_user_name, target_user_id, target_user_name, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          eventType,
          featureKey,
          userId,
          userName,
          metadata.targetUserId || null,
          metadata.targetUserName || null,
          JSON.stringify(metadata),
        ]
      );
    } catch (error) {
      logger.error({ err: error, eventType, featureKey }, 'Failed to log access event');
    }
  }

  /**
   * Log when a user is denied access (for demand signals).
   */
  async function logAccessDenied(featureCommand, userId, userName, channelId) {
    const config = FEATURE_CONFIG[featureCommand];
    if (!config) return;

    await logAccessEvent(AccessEventType.ACCESS_DENIED, config.key, userId, userName, {
      channelId,
      featureStatus: config.status,
    });

    logger.info({
      featureCommand,
      userId,
      userName,
    }, 'Access denied - logged for demand tracking');
  }

  /**
   * Build the "no access" message for Slack.
   * Friendly, educational, with an optional docs link.
   */
  function buildNoAccessMessage(featureCommand) {
    const config = FEATURE_CONFIG[featureCommand];

    if (customNoAccessMessage) {
      return customNoAccessMessage(featureCommand, config || null);
    }

    if (!config) {
      return {
        response_type: 'ephemeral',
        text: 'This feature is not available.',
      };
    }

    const statusDisplay = config.status === 'coming_soon' ? 'coming soon' : config.status;

    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Thanks for checking out ${config.name}!*\n\nThis feature is currently in *${statusDisplay}*.`,
        },
      },
    ];

    if (config.docsUrl) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `<${config.docsUrl}|Learn more about this feature>`,
          },
        ],
      });
    }

    blocks.push(
      {
        type: 'divider',
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Interested in joining the ${statusDisplay}? Ask someone with access to run:\n\`/${featureCommand} add @you\``,
          },
        ],
      }
    );

    return {
      response_type: 'ephemeral',
      blocks,
    };
  }

  /**
   * Build success message when access is granted.
   */
  function buildAccessGrantedMessage(featureCommand, targetUserId, alreadyHadAccess) {
    const config = FEATURE_CONFIG[featureCommand];
    const featureName = config?.name || featureCommand;

    if (alreadyHadAccess) {
      return {
        response_type: 'ephemeral',
        text: `<@${targetUserId}> already has access to ${featureName}.`,
      };
    }

    return {
      response_type: 'ephemeral',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `Added <@${targetUserId}> to *${featureName}*.`,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `They can now use \`/${featureCommand}\` to access this feature.`,
            },
          ],
        },
      ],
    };
  }

  /**
   * Get feature config by command name.
   */
  function getFeatureConfig(featureCommand) {
    return FEATURE_CONFIG[featureCommand] || null;
  }

  /**
   * Get analytics on feature access.
   * @param {number} days - Days to look back
   */
  async function getAccessAnalytics(days = 30) {
    if (!pool) return null;

    try {
      const result = await pool.query(`
        SELECT
          feature_key,
          event_type,
          COUNT(*) as event_count,
          COUNT(DISTINCT slack_user_id) as unique_users
        FROM ${logTable}
        WHERE created_at >= NOW() - INTERVAL '1 day' * $1
        GROUP BY feature_key, event_type
        ORDER BY feature_key, event_count DESC
      `, [days]);

      return result.rows;
    } catch (error) {
      logger.error({ err: error }, 'Failed to get access analytics');
      return null;
    }
  }

  return {
    // Core functions
    initializeTables,
    hasAccess,
    grantAccess,
    revokeAccess,
    getAccessList,

    // Logging
    logAccessDenied,
    logAccessEvent,
    AccessEventType,

    // Message builders
    buildNoAccessMessage,
    buildAccessGrantedMessage,

    // Utilities
    extractUserId,
    getFeatureConfig,
    getAccessAnalytics,

    // Config
    features: FEATURE_CONFIG,
  };
}

module.exports = { createFeatureAccess, AccessEventType };
