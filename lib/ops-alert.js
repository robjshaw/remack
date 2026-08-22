'use strict';

/**
 * Ops alert helper.
 *
 * Fire-and-forget Slack notification for background jobs (cron / queue
 * workers) that have no interactive Slack client in scope. Surfaces failures
 * that would otherwise be swallowed by a job's try/catch and only land in
 * logs nobody watches.
 *
 * Deliberately best-effort: if the token or channel is missing, or the Slack
 * call throws, it logs and returns instead of propagating — alerting must
 * never be the reason a job fails.
 */

const { WebClient } = require('@slack/web-api');
const { normalizeLogger } = require('./logger');

/**
 * Create an ops-alert sender.
 *
 * @param {Object} [options]
 * @param {string} [options.token] - Bot token (default: SLACK_BOT_TOKEN env)
 * @param {string} [options.channel] - Channel ID or name to post to
 *   (default: SLACK_ALERTS_CHANNEL env), e.g. C0… or "#my-app-ops"
 * @param {Object} [options.client] - Pre-built WebClient (skips token)
 * @param {Object} [options.logger] - pino-like logger
 * @returns {{ sendOpsAlert: (title: string, opts?: {error?: Error, context?: Object}) => Promise<boolean> }}
 */
function createOpsAlert({
  token = process.env.SLACK_BOT_TOKEN,
  channel = process.env.SLACK_ALERTS_CHANNEL,
  client = null,
  logger: rawLogger,
} = {}) {
  const logger = normalizeLogger(rawLogger);
  let cachedClient = client;

  function getClient() {
    if (cachedClient) return cachedClient;
    if (!token) return null;
    cachedClient = new WebClient(token);
    return cachedClient;
  }

  /**
   * Post an ops alert to Slack. Never throws.
   *
   * @param {string} title - Short headline, e.g. "Weekly summary aggregation failed".
   * @param {Object} [opts]
   * @param {Error}  [opts.error]   - Error whose message should be included.
   * @param {Object} [opts.context] - Extra key/value context rendered as a bullet list.
   * @returns {Promise<boolean>} true if a message was sent, false otherwise.
   */
  async function sendOpsAlert(title, { error, context = {} } = {}) {
    const webClient = getClient();

    if (!webClient || !channel) {
      logger.warn(
        { hasToken: !!token || !!client, hasChannel: !!channel, title },
        'Ops alert not sent (Slack token or alerts channel not configured)'
      );
      return false;
    }

    const lines = [`:rotating_light: *${title}*`];
    if (error?.message) lines.push('```' + String(error.message).slice(0, 900) + '```');
    for (const [key, value] of Object.entries(context)) {
      lines.push(`• *${key}*: ${value}`);
    }

    try {
      await webClient.chat.postMessage({
        channel,
        text: lines.join('\n'),
        unfurl_links: false,
      });
      return true;
    } catch (postError) {
      logger.error({ err: postError, title }, 'Failed to post ops alert to Slack');
      return false;
    }
  }

  return { sendOpsAlert };
}

module.exports = { createOpsAlert };
