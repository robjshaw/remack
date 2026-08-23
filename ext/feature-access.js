/**
 * Feature Access Control — on the storage contract, portable anywhere.
 *
 * Ring-fencing for pilot/coming-soon features:
 * - Live features (requiresAccess: false): available to everyone
 * - Pilot/Coming Soon (requiresAccess: true): invite-only via /command add @user
 *
 * Grants live in namespace 'feature-access' (key `{featureKey}:{userId}`);
 * an audit log of grants/revokes/denials (adoption + demand signal) lives in
 * 'feature-access-log'. Works with any slackline storage — memory, file, or
 * a shared adapter.
 */

import { normalizeLogger } from '../lib/logger.js';
import { extractUserId } from '../lib/helpers.js';

const ACCESS_NS = 'feature-access';
const LOG_NS = 'feature-access-log';

export const AccessEventType = {
  ACCESS_GRANTED: 'access_granted',
  ACCESS_REVOKED: 'access_revoked',
  ACCESS_DENIED: 'access_denied',
  ACCESS_CHECKED: 'access_checked',
};

/**
 * @typedef {Object} FeatureConfig
 * @property {string} key - Stable key stored with grants (e.g. 'buyer_list')
 * @property {string} name - Human-readable name
 * @property {string} status - 'live' | 'pilot' | 'coming_soon'
 * @property {boolean} requiresAccess - false = everyone; true = invite-only
 * @property {string} [docsUrl] - Optional docs link shown in denial messages
 */

/**
 * @param {Object} options
 * @param {Object} options.storage - slackline storage (app.storage or your own)
 * @param {Object<string, FeatureConfig>} options.features - Keyed by command name
 * @param {boolean} [options.failOpen] - Allow access when storage errors (default true)
 * @param {Object} [options.logger]
 * @param {Function} [options.buildNoAccessMessage] - Override the denial
 *   message builder; receives (featureCommand, config)
 */
export function createFeatureAccess({
  storage,
  features = {},
  failOpen = true,
  logger: rawLogger,
  buildNoAccessMessage: customNoAccessMessage,
} = {}) {
  if (!storage) {
    throw new Error('createFeatureAccess requires a storage (pass app.storage or memoryStorage())');
  }

  const logger = normalizeLogger(rawLogger);
  const FEATURE_CONFIG = Object.freeze({ ...features });

  async function logAccessEvent(eventType, featureKey, userId, userName, metadata = {}) {
    try {
      const key = `${new Date().toISOString()}:${crypto.randomUUID()}`;
      await storage.put(LOG_NS, key, {
        eventType,
        featureKey,
        userId,
        userName: userName || null,
        targetUserId: metadata.targetUserId || null,
        targetUserName: metadata.targetUserName || null,
        at: new Date().toISOString(),
        metadata,
      });
    } catch (error) {
      logger.error({ err: error, eventType, featureKey }, 'Failed to log access event');
    }
  }

  /**
   * Check if a user has access to a feature.
   */
  async function hasAccess(featureCommand, slackUserId) {
    const config = FEATURE_CONFIG[featureCommand];

    if (!config) {
      logger.warn({ featureCommand }, 'Unknown feature command');
      return false;
    }

    if (!config.requiresAccess) {
      return true;
    }

    try {
      const grant = await storage.get(ACCESS_NS, `${config.key}:${slackUserId}`);
      const allowed = grant !== null;
      logger.debug({ featureCommand, slackUserId, hasAccess: allowed }, 'Access check performed');
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

    try {
      const key = `${config.key}:${targetUserId}`;
      const existing = await storage.get(ACCESS_NS, key);
      if (existing) {
        return { success: true, alreadyHadAccess: true };
      }

      await storage.put(ACCESS_NS, key, {
        featureKey: config.key,
        userId: targetUserId,
        userName: targetUserName || null,
        grantedByUserId: grantedByUserId || null,
        grantedByUserName: grantedByUserName || null,
        grantedAt: new Date().toISOString(),
      });

      await logAccessEvent(AccessEventType.ACCESS_GRANTED, config.key, grantedByUserId, grantedByUserName, {
        targetUserId,
        targetUserName,
      });

      logger.info({ featureCommand, targetUserId, grantedByUserId }, 'Access granted');
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

    try {
      const key = `${config.key}:${targetUserId}`;
      const hadAccess = (await storage.get(ACCESS_NS, key)) !== null;

      if (hadAccess) {
        await storage.delete(ACCESS_NS, key);
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
   * @returns {Promise<Array<{userId, userName, grantedBy, grantedAt}>>}
   */
  async function getAccessList(featureCommand) {
    const config = FEATURE_CONFIG[featureCommand];
    if (!config) return [];

    try {
      const entries = await storage.list(ACCESS_NS, { prefix: `${config.key}:` });
      return entries.map(({ value }) => ({
        userId: value.userId,
        userName: value.userName,
        grantedBy: value.grantedByUserName,
        grantedAt: value.grantedAt,
      }));
    } catch (error) {
      logger.error({ err: error, featureCommand }, 'Failed to get access list');
      return [];
    }
  }

  /**
   * Log when a user is denied access (demand signal).
   */
  async function logAccessDenied(featureCommand, userId, userName, channelId) {
    const config = FEATURE_CONFIG[featureCommand];
    if (!config) return;

    await logAccessEvent(AccessEventType.ACCESS_DENIED, config.key, userId, userName, {
      channelId,
      featureStatus: config.status,
    });

    logger.info({ featureCommand, userId }, 'Access denied - logged for demand tracking');
  }

  /**
   * Aggregate the access log: per feature+event counts and unique users.
   * Computed in JS over the log namespace — fine at bot scale.
   */
  async function getAccessAnalytics(days = 30) {
    try {
      const cutoff = Date.now() - days * 86_400_000;
      const entries = await storage.list(LOG_NS);
      const buckets = new Map();

      for (const { value } of entries) {
        if (new Date(value.at).getTime() < cutoff) continue;
        const bucketKey = `${value.featureKey}|${value.eventType}`;
        if (!buckets.has(bucketKey)) {
          buckets.set(bucketKey, { featureKey: value.featureKey, eventType: value.eventType, eventCount: 0, users: new Set() });
        }
        const bucket = buckets.get(bucketKey);
        bucket.eventCount += 1;
        if (value.userId) bucket.users.add(value.userId);
      }

      return [...buckets.values()]
        .map(({ users, ...rest }) => ({ ...rest, uniqueUsers: users.size }))
        .sort((a, b) => a.featureKey.localeCompare(b.featureKey) || b.eventCount - a.eventCount);
    } catch (error) {
      logger.error({ err: error }, 'Failed to get access analytics');
      return null;
    }
  }

  /**
   * Build the "no access" message for Slack.
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
        elements: [{ type: 'mrkdwn', text: `<${config.docsUrl}|Learn more about this feature>` }],
      });
    }

    blocks.push(
      { type: 'divider' },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `Interested in joining the ${statusDisplay}? Ask someone with access to run:\n\`/${featureCommand} add @you\``,
        }],
      }
    );

    return { response_type: 'ephemeral', blocks };
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
          text: { type: 'mrkdwn', text: `Added <@${targetUserId}> to *${featureName}*.` },
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `They can now use \`/${featureCommand}\` to access this feature.` }],
        },
      ],
    };
  }

  function getFeatureConfig(featureCommand) {
    return FEATURE_CONFIG[featureCommand] || null;
  }

  return {
    hasAccess,
    grantAccess,
    revokeAccess,
    getAccessList,
    logAccessDenied,
    logAccessEvent,
    AccessEventType,
    buildNoAccessMessage,
    buildAccessGrantedMessage,
    extractUserId,
    getFeatureConfig,
    getAccessAnalytics,
    features: FEATURE_CONFIG,
  };
}
