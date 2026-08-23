/**
 * Postgres adapter for the slackline storage contract.
 *
 * One table (migrations/001_slackline_kv.sql), JSONB values, primary key
 * (ns, key). Use when the bot runs multiple instances or you already have
 * Postgres; memoryStorage()/fileStorage() cover everything else.
 *
 * The pg Pool is injected — slackline never opens connections, never reads
 * DATABASE_URL, and never imports pg.
 */

import { normalizeLogger } from '../lib/logger.js';

const IDENTIFIER_RE = /^[a-z_][a-z0-9_.]*$/i;

/**
 * @param {Object} options
 * @param {Object} options.pool - pg Pool (anything with query(text, params))
 * @param {string} [options.table] - Default 'slackline_kv'
 * @param {Object} [options.logger]
 */
export function postgresStorage({ pool, table = 'slackline_kv', logger: rawLogger } = {}) {
  const logger = normalizeLogger(rawLogger);

  if (!pool) {
    throw new Error('postgresStorage requires a pg pool');
  }
  if (!IDENTIFIER_RE.test(table)) {
    throw new Error(`Invalid storage table name: ${table}`);
  }

  return {
    async get(ns, key) {
      const result = await pool.query(
        `SELECT value FROM ${table} WHERE ns = $1 AND key = $2`,
        [ns, key]
      );
      return result.rows[0]?.value ?? null;
    },

    async put(ns, key, value) {
      await pool.query(`
        INSERT INTO ${table} (ns, key, value, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (ns, key)
        DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
      `, [ns, key, JSON.stringify(value)]);
    },

    async delete(ns, key) {
      await pool.query(`DELETE FROM ${table} WHERE ns = $1 AND key = $2`, [ns, key]);
    },

    async list(ns, { prefix, limit } = {}) {
      const conditions = ['ns = $1'];
      const params = [ns];

      if (prefix) {
        params.push(`${prefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
        conditions.push(`key LIKE $${params.length}`);
      }

      let sql = `SELECT key, value FROM ${table} WHERE ${conditions.join(' AND ')} ORDER BY key`;
      if (limit !== undefined) {
        params.push(limit);
        sql += ` LIMIT $${params.length}`;
      }

      const result = await pool.query(sql, params);
      logger.debug({ ns, prefix, rows: result.rows.length }, 'Storage list');
      return result.rows.map((row) => ({ key: row.key, value: row.value }));
    },
  };
}
