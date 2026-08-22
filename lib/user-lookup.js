'use strict';

/**
 * Slack User Lookup
 *
 * Maps staff names to Slack users via email lookup, with a per-instance
 * cache. Requires the `users:read.email` scope for lookupByEmail.
 *
 * Supports a test-recipient redirect so notification flows can be exercised
 * in a dev workspace without the real staff users.
 */

const { normalizeLogger } = require('./logger');

function normalizeNameKey(name) {
  return String(name || '').trim().toLowerCase();
}

function toUserShape(user, extra = {}) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.real_name || user.name,
    email: user.profile?.email,
    displayName: user.profile?.display_name,
    ...extra,
  };
}

/**
 * Create a user-lookup service.
 *
 * @param {Object} options
 * @param {string} options.emailDomain - Staff email domain, e.g. 'example.com' (required)
 * @param {Object<string,string>} [options.specialMappings] - Full name → email
 *   for names that don't follow the first.last convention
 * @param {Object<string,string>} [options.overrides] - Name → Slack user ID
 *   ('U…') or email; consulted before email derivation
 * @param {string} [options.testRecipient] - Slack user ID ('U…') or email; when
 *   set, ALL lookups redirect to this user (dev/test workspaces)
 * @param {Object} [options.logger] - pino-like logger
 */
function createUserLookup({
  emailDomain,
  specialMappings = {},
  overrides = {},
  testRecipient = null,
  logger: rawLogger,
} = {}) {
  if (!emailDomain) {
    throw new Error('createUserLookup requires an emailDomain option');
  }

  const logger = normalizeLogger(rawLogger);
  const userCache = new Map();

  const specialByName = new Map(
    Object.entries(specialMappings).map(([name, email]) => [normalizeNameKey(name), String(email || '').trim()])
  );
  const overridesByName = new Map(
    Object.entries(overrides).map(([name, target]) => [normalizeNameKey(name), String(target || '').trim()])
  );

  /**
   * Convert a staff name to an email address.
   * "Adil Khan" → "adil.khan@<emailDomain>"
   */
  function nameToEmail(name) {
    if (!name) return null;

    const special = specialByName.get(normalizeNameKey(name));
    if (special) {
      return special;
    }

    // Standard conversion: "First Last" → "first.last@domain"
    const parts = name.trim().toLowerCase().split(/\s+/);
    if (parts.length < 2) {
      // Single name - just use it
      return `${parts[0]}@${emailDomain}`;
    }

    // Use first and last name (ignore middle names)
    const firstName = parts[0];
    const lastName = parts[parts.length - 1];

    return `${firstName}.${lastName}@${emailDomain}`;
  }

  function nameToFallbackEmail(name) {
    if (!name) return null;

    const parts = name.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      return null;
    }

    return `${parts[0]}@${emailDomain}`;
  }

  async function lookupSlackUserByEmail(slackClient, email) {
    const result = await slackClient.users.lookupByEmail({ email });

    if (!result.ok || !result.user) {
      return null;
    }

    return toUserShape(result.user);
  }

  async function lookupByIdOrEmail(slackClient, target) {
    const result = target.startsWith('U')
      ? await slackClient.users.info({ user: target })
      : await slackClient.users.lookupByEmail({ email: target });

    return result?.ok !== false && result?.user ? result.user : null;
  }

  /**
   * Look up a Slack user by their staff name.
   *
   * @param {Object} slackClient - Slack WebClient instance
   * @param {string} name - Staff name (e.g., "Adil Khan")
   * @returns {Promise<Object|null>} Slack user object or null if not found
   */
  async function lookupUserByName(slackClient, name) {
    if (!name) return null;
    const normalizedName = normalizeNameKey(name);

    // TEST MODE: redirect every lookup to the configured test recipient
    if (testRecipient) {
      logger.info({ name, testRecipient }, 'TEST MODE: Redirecting to test recipient');
      try {
        const user = await lookupByIdOrEmail(slackClient, testRecipient);
        if (user) {
          return toUserShape(user, { _testMode: true, _originalName: name });
        }
      } catch (err) {
        logger.error({ err, testRecipient }, 'Failed to lookup test recipient');
      }
      return null;
    }

    // Check cache first
    if (userCache.has(normalizedName)) {
      const cached = userCache.get(normalizedName);
      logger.debug({ name, userId: cached?.id }, 'User found in cache');
      return cached;
    }

    const overrideTarget = overridesByName.get(normalizedName);
    if (overrideTarget) {
      try {
        logger.info({ name, overrideTarget }, 'Looking up Slack user via override');
        const rawUser = await lookupByIdOrEmail(slackClient, overrideTarget);
        const user = toUserShape(rawUser);

        if (user) {
          userCache.set(normalizedName, user);
          return user;
        }
      } catch (error) {
        logger.warn({ err: error, name, overrideTarget }, 'Failed Slack lookup via override');
      }
    }

    const primaryEmail = nameToEmail(name);
    const fallbackEmail = nameToFallbackEmail(name);
    const emailCandidates = [...new Set([primaryEmail, fallbackEmail].filter(Boolean))];

    if (emailCandidates.length === 0) {
      logger.warn({ name }, 'Could not derive email from name');
      return null;
    }

    for (const email of emailCandidates) {
      try {
        logger.info({ name, email }, 'Looking up Slack user by email');
        const user = await lookupSlackUserByEmail(slackClient, email);

        if (user) {
          userCache.set(normalizedName, user);
          logger.info({ name, email, userId: user.id }, 'Found Slack user');
          return user;
        }
      } catch (error) {
        if (error.data?.error === 'users_not_found') {
          logger.warn({ name, email }, 'User not found in Slack workspace');
          continue;
        }

        logger.error({ err: error, name, email }, 'Failed to lookup Slack user');
        return null;
      }
    }

    logger.warn({ name, emailCandidates }, 'User not found in Slack');
    userCache.set(normalizedName, null);
    return null;
  }

  /**
   * Look up multiple users at once.
   *
   * @param {Object} slackClient - Slack WebClient instance
   * @param {string[]} names - Array of staff names
   * @returns {Promise<Map<string, Object>>} Map of name → Slack user
   */
  async function lookupUsers(slackClient, names) {
    const results = new Map();

    for (const name of names) {
      const user = await lookupUserByName(slackClient, name);
      if (user) {
        results.set(name, user);
      }
    }

    return results;
  }

  /**
   * Clear the user cache (useful for testing).
   */
  function clearCache() {
    userCache.clear();
    logger.info('User cache cleared');
  }

  return {
    nameToEmail,
    nameToFallbackEmail,
    lookupUserByName,
    lookupUsers,
    clearCache,
    emailDomain,
  };
}

module.exports = { createUserLookup };
