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

import { createClient } from '../lib/client.js';
import { normalizeLogger } from '../lib/logger.js';

/**
 * @param {Object} [options]
 * @param {string} [options.token] - Bot token (default: SLACK_BOT_TOKEN env)
 * @param {string} [options.channel] - Channel ID or name
 *   (default: SLACK_ALERTS_CHANNEL env), e.g. C0… or "#my-app-ops"
 * @param {Object} [options.client] - Pre-built slackline client (skips token)
 * @param {Object} [options.logger]
 * @returns {{ sendOpsAlert: (title: string, opts?: {error?: Error, context?: Object}) => Promise<boolean> }}
 */
export function createOpsAlert({
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
    cachedClient = createClient({ token, logger });
    return cachedClient;
  }

  /**
   * Post an ops alert to Slack. Never throws.
   * @returns {Promise<boolean>} true if a message was sent
   */
  async function sendOpsAlert(title, { error, context = {} } = {}) {
    const slackClient = getClient();

    if (!slackClient || !channel) {
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
      await slackClient.chat.postMessage({
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
