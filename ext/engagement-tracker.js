/**
 * Engagement / analytics tracker — on the storage contract, portable
 * anywhere.
 *
 * Two namespaces:
 *   'engagement' — home-tab visits + whether an action followed (bounce
 *     rate); keys `{userId}:{iso}:{uuid}` so per-user history lists cheaply
 *   'analytics' — unified event stream; keys `{iso}:{uuid}` (time-ordered)
 *
 * Aggregations are computed in JS over listed entries — right-sized for bot
 * scale. If you outgrow that, ship events to your analytics pipeline from a
 * defineTracker wrapper instead.
 *
 * Event types are injected by the consuming app; the library only ships the
 * feature-agnostic CoreEventType.
 */

import { normalizeLogger } from '../lib/logger.js';

const ENGAGEMENT_NS = 'engagement';
const ANALYTICS_NS = 'analytics';

export const CoreEventType = {
  HOME_OPENED: 'home_opened',
  HOME_ACTION: 'home_action',
};

/**
 * @param {Object} options
 * @param {Object} options.storage - slackline storage (app.storage or your own)
 * @param {Object<string,string>} [options.eventTypes] - App event enum,
 *   merged over CoreEventType, exposed as `EventType`
 * @param {Object} [options.logger]
 */
export function createEngagementTracker({
  storage,
  eventTypes = {},
  logger: rawLogger,
} = {}) {
  if (!storage) {
    throw new Error('createEngagementTracker requires a storage (pass app.storage or memoryStorage())');
  }

  const logger = normalizeLogger(rawLogger);
  const EventType = Object.freeze({ ...CoreEventType, ...eventTypes });

  /**
   * Track any event in the unified stream.
   * @param {string} eventType
   * @param {Object} data - { userId (required), userName?, teamId?,
   *   channelId?, feature?, searchQuery?, resultCount?, durationMs?,
   *   success?, metadata? }
   * @returns {Promise<string|null>} the event key
   */
  async function trackEvent(eventType, data = {}) {
    const {
      userId, userName, teamId, channelId, feature,
      searchQuery, resultCount, durationMs, success = true, metadata = {},
    } = data;

    if (!userId) {
      logger.warn({ eventType }, 'trackEvent called without userId');
      return null;
    }

    try {
      const at = new Date().toISOString();
      const key = `${at}:${crypto.randomUUID()}`;
      await storage.put(ANALYTICS_NS, key, {
        eventType, userId,
        userName: userName || null,
        teamId: teamId || null,
        channelId: channelId || null,
        feature: feature || null,
        searchQuery: searchQuery || null,
        resultCount: resultCount ?? null,
        durationMs: durationMs ?? null,
        success,
        metadata,
        at,
      });

      logger.debug({ eventType, userId, feature }, 'Event tracked');
      return key;
    } catch (error) {
      logger.error({ err: error, eventType, userId }, 'Failed to track event');
      return null;
    }
  }

  /**
   * Build a convenience tracker bound to an event type:
   *   const track = { search: tracker.defineTracker(EventType.SEARCH, { feature: 'search' }) };
   *   await track.search({ userId, searchQuery });
   */
  function defineTracker(eventType, defaults = {}) {
    return (data = {}) => trackEvent(eventType, {
      ...defaults,
      ...data,
      metadata: { ...defaults.metadata, ...data.metadata },
    });
  }

  /**
   * Record a home tab open.
   * @returns {Promise<{isFirstVisit, lastVisit, visitCount, engagementId}>}
   */
  async function recordHomeOpen(userId, teamId, tab = 'home') {
    try {
      const history = (await storage.list(ENGAGEMENT_NS, { prefix: `${userId}:` }))
        .filter(({ value }) => value.tab === tab);

      const visitCount = history.length;
      const lastVisit = visitCount ? history[history.length - 1].value.openedAt : null;

      const openedAt = new Date().toISOString();
      const engagementId = `${userId}:${openedAt}:${crypto.randomUUID()}`;
      await storage.put(ENGAGEMENT_NS, engagementId, {
        userId,
        teamId: teamId || null,
        tab,
        openedAt,
        actionTaken: false,
        actionId: null,
        actionAt: null,
      });

      logger.debug({ userId, isFirstVisit: visitCount === 0, visitCount: visitCount + 1 }, 'Home open recorded');
      return { isFirstVisit: visitCount === 0, lastVisit, visitCount: visitCount + 1, engagementId };
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to record home open');
      return { isFirstVisit: true, lastVisit: null, visitCount: 0, engagementId: null };
    }
  }

  /**
   * Mark that a visit led to an action (bounce-rate signal).
   * @param {string} engagementId - From recordHomeOpen
   * @param {string} actionId
   */
  async function recordAction(engagementId, actionId) {
    if (!engagementId) return;

    try {
      const visit = await storage.get(ENGAGEMENT_NS, engagementId);
      if (!visit) return;

      await storage.put(ENGAGEMENT_NS, engagementId, {
        ...visit,
        actionTaken: true,
        actionId,
        actionAt: new Date().toISOString(),
      });
      logger.debug({ engagementId, actionId }, 'Action recorded');
    } catch (error) {
      logger.error({ err: error, engagementId, actionId }, 'Failed to record action');
    }
  }

  /**
   * Engagement summary over the window: unique users, visits, conversion.
   */
  async function getAnalytics(days = 30) {
    try {
      const cutoff = Date.now() - days * 86_400_000;
      const weekCutoff = Date.now() - 7 * 86_400_000;
      const entries = (await storage.list(ENGAGEMENT_NS))
        .filter(({ value }) => new Date(value.openedAt).getTime() >= cutoff);

      const users = new Set();
      const weeklyUsers = new Set();
      let withAction = 0;

      for (const { value } of entries) {
        users.add(value.userId);
        if (new Date(value.openedAt).getTime() >= weekCutoff) weeklyUsers.add(value.userId);
        if (value.actionTaken) withAction += 1;
      }

      const totalVisits = entries.length;
      return {
        uniqueUsers: users.size,
        totalVisits,
        visitsWithAction: withAction,
        conversionRate: totalVisits ? Math.round((1000 * withAction) / totalVisits) / 10 : null,
        weeklyActiveUsers: weeklyUsers.size,
      };
    } catch (error) {
      logger.error({ err: error }, 'Failed to get analytics');
      return null;
    }
  }

  /**
   * Has the user gone quiet? Never-visited counts as dormant.
   */
  async function isUserDormant(userId, daysThreshold = 14) {
    try {
      const history = await storage.list(ENGAGEMENT_NS, { prefix: `${userId}:` });
      if (history.length === 0) return true;

      const lastVisit = history[history.length - 1].value.openedAt;
      const daysSince = Math.floor((Date.now() - new Date(lastVisit).getTime()) / 86_400_000);
      return daysSince >= daysThreshold;
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to check dormancy');
      return false;
    }
  }

  /**
   * Per feature+event usage over the window: counts, unique users, avg
   * duration, error count.
   */
  async function getFeatureUsage(days = 30) {
    try {
      const cutoff = Date.now() - days * 86_400_000;
      const entries = (await storage.list(ANALYTICS_NS))
        .filter(({ value }) => value.feature && new Date(value.at).getTime() >= cutoff);

      const buckets = new Map();
      for (const { value } of entries) {
        const bucketKey = `${value.feature}|${value.eventType}`;
        if (!buckets.has(bucketKey)) {
          buckets.set(bucketKey, {
            feature: value.feature, eventType: value.eventType,
            eventCount: 0, users: new Set(), durations: [], errorCount: 0,
          });
        }
        const bucket = buckets.get(bucketKey);
        bucket.eventCount += 1;
        bucket.users.add(value.userId);
        if (value.durationMs != null) bucket.durations.push(value.durationMs);
        if (value.success === false) bucket.errorCount += 1;
      }

      return [...buckets.values()]
        .map(({ users, durations, ...rest }) => ({
          ...rest,
          uniqueUsers: users.size,
          avgDurationMs: durations.length
            ? Math.round(durations.reduce((sum, ms) => sum + ms, 0) / durations.length)
            : null,
        }))
        .sort((a, b) => a.feature.localeCompare(b.feature) || b.eventCount - a.eventCount);
    } catch (error) {
      logger.error({ err: error }, 'Failed to get feature usage');
      return null;
    }
  }

  return {
    EventType,
    trackEvent,
    defineTracker,
    recordHomeOpen,
    recordAction,
    getAnalytics,
    isUserDormant,
    getFeatureUsage,
  };
}
