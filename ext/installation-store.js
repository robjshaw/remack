/**
 * Postgres installation store for OAuth mode.
 *
 * Interface consumed by createApp/oauth: { get, set, delete, list }.
 * Supports single-workspace and Enterprise Grid (org-wide) installs.
 * Schema: migrations/001_slack_installations.sql. The pg Pool is injected —
 * slackline never opens connections or reads DATABASE_URL.
 */

import { normalizeLogger } from '../lib/logger.js';

const IDENTIFIER_RE = /^[a-z_][a-z0-9_.]*$/i;

/**
 * @param {Object} options
 * @param {Object} options.pool - pg Pool (anything with query(text, params))
 * @param {Object} [options.logger]
 * @param {string} [options.table] - Default 'public.slack_installations'
 */
export function createInstallationStore({ pool, logger: rawLogger, table = 'public.slack_installations' } = {}) {
  const logger = normalizeLogger(rawLogger);

  if (!IDENTIFIER_RE.test(table)) {
    throw new Error(`Invalid installations table name: ${table}`);
  }
  if (!pool) {
    throw new Error('createInstallationStore requires a pg pool');
  }

  /** Store (upsert) an installation after a successful OAuth exchange. */
  async function set(installation) {
    const { team, enterprise, isEnterpriseInstall, bot, user, appId } = installation;

    logger.info({
      teamId: team?.id,
      enterpriseId: enterprise?.id,
      isEnterpriseInstall,
      botUserId: bot?.userId,
    }, 'Storing Slack installation');

    await pool.query(`
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
  }

  /**
   * Fetch an installation for a workspace. Returns null when not installed
   * (the app acks and warns rather than 500ing).
   */
  async function get({ teamId, enterpriseId, isEnterpriseInstall } = {}) {
    let result;

    if (isEnterpriseInstall && enterpriseId) {
      result = await pool.query(`
        SELECT * FROM ${table}
        WHERE enterprise_id = $1 AND is_enterprise_install = TRUE
        LIMIT 1
      `, [enterpriseId]);
    } else if (teamId) {
      result = await pool.query(`
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
      return null;
    }

    const row = result.rows[0];
    return {
      team: { id: row.team_id, name: row.team_name },
      enterprise: row.enterprise_id ? { id: row.enterprise_id, name: row.enterprise_name } : null,
      isEnterpriseInstall: row.is_enterprise_install,
      appId: row.app_id,
      bot: {
        token: row.bot_token,
        id: row.bot_id,
        userId: row.bot_user_id,
        scopes: row.bot_scopes || [],
      },
      user: row.user_token
        ? { id: row.user_id, token: row.user_token, scopes: row.user_scopes || [] }
        : null,
    };
  }

  /** Delete an installation (app uninstalled / tokens revoked). */
  async function remove({ teamId, enterpriseId, isEnterpriseInstall } = {}) {
    logger.info({ teamId, enterpriseId }, 'Deleting installation');

    if (isEnterpriseInstall && enterpriseId) {
      await pool.query(`
        DELETE FROM ${table}
        WHERE enterprise_id = $1 AND is_enterprise_install = TRUE
      `, [enterpriseId]);
    } else if (teamId) {
      await pool.query(`
        DELETE FROM ${table}
        WHERE team_id = $1
      `, [teamId]);
    }
  }

  /** List installations (admin/debugging). */
  async function list() {
    const result = await pool.query(`
      SELECT team_id, team_name, enterprise_id, enterprise_name,
             is_enterprise_install, installed_at, updated_at
      FROM ${table}
      ORDER BY updated_at DESC
    `);
    return result.rows;
  }

  return { get, set, delete: remove, list };
}
