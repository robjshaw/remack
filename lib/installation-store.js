'use strict';

/**
 * Slack OAuth Installation Store
 *
 * Stores and retrieves OAuth installations from PostgreSQL.
 * Supports both single-workspace and Enterprise Grid (org-wide) installations.
 *
 * Pass the returned object as Bolt's `installationStore` when SLACK_BOT_TOKEN
 * is not set. Schema: migrations/001_slack_installations.sql.
 */

const { normalizeLogger } = require('./logger');

const IDENTIFIER_RE = /^[a-z_][a-z0-9_.]*$/i;

/**
 * Create a Postgres-backed Bolt InstallationStore.
 *
 * @param {Object} options
 * @param {Object} options.pool - pg Pool (or anything with query(text, params))
 * @param {Object} [options.logger] - pino-like logger
 * @param {string} [options.table] - Installations table (default 'public.slack_installations')
 * @returns {{ storeInstallation, fetchInstallation, deleteInstallation, getAllInstallations }}
 */
function createInstallationStore({ pool, logger: rawLogger, table = 'public.slack_installations' } = {}) {
  const logger = normalizeLogger(rawLogger);

  if (!IDENTIFIER_RE.test(table)) {
    throw new Error(`Invalid installations table name: ${table}`);
  }

  function requirePool() {
    if (!pool) {
      throw new Error('Database not configured for installation store');
    }
    return pool;
  }

  /**
   * Store a new installation. Called after successful OAuth flow.
   */
  async function storeInstallation(installation) {
    const db = requirePool();

    const {
      team,
      enterprise,
      isEnterpriseInstall,
      bot,
      user,
      appId,
    } = installation;

    logger.info({
      teamId: team?.id,
      enterpriseId: enterprise?.id,
      isEnterpriseInstall,
      botUserId: bot?.userId,
    }, 'Storing Slack installation');

    try {
      await db.query(`
        INSERT INTO ${table} (
          team_id, team_name,
          enterprise_id, enterprise_name,
          is_enterprise_install, installed_by_user_id,
          bot_token, bot_id, bot_user_id, bot_scopes,
          user_token, user_id, user_scopes,
          app_id, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW()
        )
        ON CONFLICT (team_id, enterprise_id, is_enterprise_install)
        DO UPDATE SET
          team_name = EXCLUDED.team_name,
          enterprise_name = EXCLUDED.enterprise_name,
          bot_token = EXCLUDED.bot_token,
          bot_id = EXCLUDED.bot_id,
          bot_user_id = EXCLUDED.bot_user_id,
          bot_scopes = EXCLUDED.bot_scopes,
          user_token = EXCLUDED.user_token,
          user_id = EXCLUDED.user_id,
          user_scopes = EXCLUDED.user_scopes,
          updated_at = NOW()
      `, [
        team?.id || null,
        team?.name || null,
        enterprise?.id || null,
        enterprise?.name || null,
        isEnterpriseInstall || false,
        user?.id || null,
        bot?.token || null,
        bot?.id || null,
        bot?.userId || null,
        bot?.scopes || [],
        user?.token || null,
        user?.id || null,
        user?.scopes || [],
        appId || null,
      ]);

      logger.info({
        teamId: team?.id,
        enterpriseId: enterprise?.id,
      }, 'Installation stored successfully');

    } catch (error) {
      logger.error({ err: error }, 'Failed to store installation');
      throw error;
    }
  }

  /**
   * Fetch an installation by team/enterprise.
   * Called by Bolt to get a token for API calls.
   */
  async function fetchInstallation(installQuery) {
    const db = requirePool();

    const {
      teamId,
      enterpriseId,
      isEnterpriseInstall,
    } = installQuery;

    logger.debug({
      teamId,
      enterpriseId,
      isEnterpriseInstall,
    }, 'Fetching installation');

    try {
      let result;

      if (isEnterpriseInstall && enterpriseId) {
        // Org-wide installation lookup
        result = await db.query(`
          SELECT * FROM ${table}
          WHERE enterprise_id = $1 AND is_enterprise_install = TRUE
          LIMIT 1
        `, [enterpriseId]);
      } else if (teamId) {
        // Single workspace lookup
        result = await db.query(`
          SELECT * FROM ${table}
          WHERE team_id = $1 AND (enterprise_id IS NULL OR enterprise_id = $2)
          ORDER BY is_enterprise_install DESC
          LIMIT 1
        `, [teamId, enterpriseId || null]);
      } else {
        throw new Error('Either teamId or enterpriseId is required');
      }

      if (result.rows.length === 0) {
        logger.warn({ teamId, enterpriseId }, 'Installation not found');
        throw new Error(`Installation not found for team ${teamId}`);
      }

      const row = result.rows[0];

      // Convert DB row back to Bolt installation format
      return {
        team: {
          id: row.team_id,
          name: row.team_name,
        },
        enterprise: row.enterprise_id ? {
          id: row.enterprise_id,
          name: row.enterprise_name,
        } : undefined,
        isEnterpriseInstall: row.is_enterprise_install,
        bot: {
          token: row.bot_token,
          id: row.bot_id,
          userId: row.bot_user_id,
          scopes: row.bot_scopes || [],
        },
        user: row.user_token ? {
          token: row.user_token,
          id: row.user_id,
          scopes: row.user_scopes || [],
        } : undefined,
        appId: row.app_id,
      };

    } catch (error) {
      logger.error({ err: error, teamId, enterpriseId }, 'Failed to fetch installation');
      throw error;
    }
  }

  /**
   * Delete an installation (app uninstalled).
   */
  async function deleteInstallation(installQuery) {
    const db = requirePool();

    const { teamId, enterpriseId, isEnterpriseInstall } = installQuery;

    logger.info({ teamId, enterpriseId }, 'Deleting installation');

    try {
      if (isEnterpriseInstall && enterpriseId) {
        await db.query(`
          DELETE FROM ${table}
          WHERE enterprise_id = $1 AND is_enterprise_install = TRUE
        `, [enterpriseId]);
      } else if (teamId) {
        await db.query(`
          DELETE FROM ${table}
          WHERE team_id = $1
        `, [teamId]);
      }

      logger.info({ teamId, enterpriseId }, 'Installation deleted');

    } catch (error) {
      logger.error({ err: error }, 'Failed to delete installation');
      throw error;
    }
  }

  /**
   * Get all installations (for admin/debugging).
   */
  async function getAllInstallations() {
    if (!pool) return [];

    try {
      const result = await pool.query(`
        SELECT team_id, team_name, enterprise_id, enterprise_name,
               is_enterprise_install, installed_at, updated_at
        FROM ${table}
        ORDER BY updated_at DESC
      `);

      return result.rows;
    } catch (error) {
      logger.error({ err: error }, 'Failed to get installations');
      return [];
    }
  }

  return {
    storeInstallation,
    fetchInstallation,
    deleteInstallation,
    getAllInstallations,
  };
}

module.exports = { createInstallationStore };
