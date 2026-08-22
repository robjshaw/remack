'use strict';

/**
 * Central error handling.
 *
 * Replaces the per-handler try/catch pattern: the registrar wraps every
 * handler with `wrap()`, so an uncaught throw is acked (Slack won't retry or
 * show a timeout), logged with context, optionally reported to an ops
 * channel, and surfaced to the user as an ephemeral message.
 *
 * Throw `SlackUserError` from a handler to show the user a specific friendly
 * message instead of the generic one (and skip the ops alert — user errors
 * aren't incidents).
 */

const { ackSafely, extractUserId } = require('./helpers');
const { normalizeLogger } = require('./logger');

class SlackUserError extends Error {
  /**
   * @param {string} userMessage - Friendly message shown to the user
   * @param {Object} [options]
   * @param {Error} [options.cause]
   * @param {boolean} [options.ephemeral] - Show ephemerally (default true)
   */
  constructor(userMessage, { cause, ephemeral = true } = {}) {
    super(userMessage, cause ? { cause } : undefined);
    this.name = 'SlackUserError';
    this.userMessage = userMessage;
    this.ephemeral = ephemeral;
  }
}

/**
 * Create a central error handler.
 *
 * @param {Object} [options]
 * @param {Object} [options.logger] - pino-like logger
 * @param {Function} [options.opsAlert] - sendOpsAlert(title, {error, context})
 *   from createOpsAlert; called (fire-and-forget) for unexpected errors
 * @param {boolean} [options.notifyUser] - Attempt an ephemeral message to the
 *   user on error (default true)
 * @param {string} [options.genericMessage] - Fallback user-facing text
 * @param {Function} [options.onError] - Hook (error, context) for Sentry etc.
 * @returns {{ wrap: Function, globalHandler: Function }}
 */
function createErrorHandler({
  logger: rawLogger,
  opsAlert,
  notifyUser = true,
  genericMessage = 'Something went wrong. Please try again.',
  onError,
} = {}) {
  const logger = normalizeLogger(rawLogger);

  async function tryNotifyUser(args, error, context) {
    if (!notifyUser) return;

    const text = error instanceof SlackUserError ? error.userMessage : genericMessage;
    const { respond, client, body } = args;

    try {
      if (typeof respond === 'function') {
        await respond({ response_type: 'ephemeral', text, replace_original: false });
        return;
      }

      const channelId = body?.channel?.id || body?.channel_id || body?.container?.channel_id;
      const userId = body?.user?.id || body?.user_id || extractUserId(body?.user?.id);
      if (client && channelId && userId) {
        await client.chat.postEphemeral({ channel: channelId, user: userId, text });
      }
    } catch (notifyError) {
      logger.debug({ err: notifyError, ...context }, 'Failed to notify user about handler error');
    }
  }

  /**
   * Wrap a handler so uncaught errors are acked, logged, reported, and
   * surfaced to the user.
   *
   * @param {Function} handler - Bolt listener
   * @param {Object} [context] - Tags for logs/alerts, e.g. {module, kind, id}
   * @returns {Function} wrapped listener
   */
  function wrap(handler, context = {}) {
    return async (args) => {
      try {
        await handler(args);
      } catch (error) {
        const { body } = args;
        const errorContext = {
          ...context,
          userId: body?.user?.id || body?.user_id,
          teamId: body?.team?.id || body?.team_id,
        };

        // Ack first so Slack doesn't retry or show a timeout
        await ackSafely(args.ack, undefined, { logger, ...errorContext });

        const isUserError = error instanceof SlackUserError;
        if (isUserError) {
          logger.warn({ err: error, ...errorContext }, 'Handler raised user-facing error');
        } else {
          logger.error({ err: error, ...errorContext }, 'Unhandled error in Slack handler');
        }

        if (onError) {
          try {
            onError(error, errorContext);
          } catch (hookError) {
            logger.error({ err: hookError }, 'onError hook threw');
          }
        }

        if (!isUserError && typeof opsAlert === 'function') {
          const title = `Slack handler error: ${context.kind || 'handler'} ${context.id || ''}`.trim();
          // Fire-and-forget; sendOpsAlert never throws but guard anyway
          Promise.resolve(opsAlert(title, { error, context: errorContext })).catch(() => {});
        }

        await tryNotifyUser(args, error, errorContext);
      }
    };
  }

  /**
   * For app.error() — catches errors thrown outside wrapped handlers
   * (middleware, Bolt internals).
   */
  async function globalHandler(error) {
    logger.error({ err: error }, 'Unhandled Bolt app error');

    if (onError) {
      try {
        onError(error, { kind: 'global' });
      } catch (hookError) {
        logger.error({ err: hookError }, 'onError hook threw');
      }
    }

    if (typeof opsAlert === 'function') {
      Promise.resolve(opsAlert('Unhandled Slack app error', { error })).catch(() => {});
    }
  }

  return { wrap, globalHandler };
}

module.exports = { createErrorHandler, SlackUserError };
