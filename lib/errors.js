/**
 * Error boundaries.
 *
 * A handler throw is never allowed to become a 5xx (Slack retries events on
 * non-2xx and shows users a timeout warning). Errors run through a boundary
 * chain, Remix-style:
 *
 *   route ErrorBoundary → app onError → built-in default
 *
 * Each boundary may return an ack value (used as the HTTP response when the
 * error happened before the ack) or undefined. A boundary that throws falls
 * through to the next.
 *
 * Throw UserError from a handler for expected, user-facing failures: the
 * user sees your message, and no ops alert fires (user errors aren't
 * incidents).
 */

import { normalizeLogger } from './logger.js';

export class UserError extends Error {
  /**
   * @param {string} userMessage - Friendly message shown to the user
   * @param {Object} [options]
   * @param {Error} [options.cause]
   * @param {boolean} [options.ephemeral] - Show ephemerally (default true)
   */
  constructor(userMessage, { cause, ephemeral = true } = {}) {
    super(userMessage, cause ? { cause } : undefined);
    this.name = 'UserError';
    this.userMessage = userMessage;
    this.ephemeral = ephemeral;
  }
}

/**
 * Run the boundary chain for an error thrown by a route.
 *
 * @param {Object} options
 * @param {Error} options.error
 * @param {Object} options.args - The route args object (payload, client, ...)
 * @param {Object} [options.routeModule] - May export ErrorBoundary
 * @param {Function} [options.onError] - App-level boundary (error, args) → ackValue|void
 * @param {Function} [options.opsAlert] - sendOpsAlert(title, {error, context})
 * @param {'ack'|'deferred'} options.phase - Whether the HTTP response is still open
 * @param {string} [options.genericMessage]
 * @param {Object} [options.logger]
 * @returns {Promise<*>} ack value for the response (phase 'ack'), or undefined
 */
export async function runBoundaryChain({
  error,
  args,
  routeModule,
  onError,
  opsAlert,
  phase,
  genericMessage = 'Something went wrong. Please try again.',
  logger: rawLogger,
}) {
  const logger = normalizeLogger(rawLogger);
  const context = {
    kind: args?.kind,
    id: args?.id,
    userId: args?.userId,
    teamId: args?.teamId,
    phase,
  };

  // 1. Route-level ErrorBoundary
  if (typeof routeModule?.ErrorBoundary === 'function') {
    try {
      return await routeModule.ErrorBoundary({ ...args, error });
    } catch (boundaryError) {
      logger.error({ err: boundaryError, ...context }, 'Route ErrorBoundary threw; falling through');
    }
  }

  // 2. App-level onError
  if (typeof onError === 'function') {
    try {
      const result = await onError(error, args);
      if (result !== undefined) return result;
    } catch (onErrorError) {
      logger.error({ err: onErrorError, ...context }, 'App onError threw; falling through');
    }
  }

  // 3. Built-in default boundary
  const isUserError = error instanceof UserError;
  if (isUserError) {
    logger.warn({ err: error, ...context }, 'Handler raised user-facing error');
  } else {
    logger.error({ err: error, ...context }, 'Unhandled error in Slack route');
    if (typeof opsAlert === 'function') {
      const title = `Slack route error: ${context.kind || 'route'} ${context.id || ''}`.trim();
      // Fire-and-forget; alerting must never be the reason handling fails
      Promise.resolve(opsAlert(title, { error, context })).catch(() => {});
    }
  }

  const text = isUserError ? error.userMessage : genericMessage;

  // Commands can carry the message in the ack response itself
  if (phase === 'ack' && args?.kind === 'command') {
    return { response_type: 'ephemeral', text };
  }

  // Everything else: best-effort notify after the ack
  await notifyUser(args, text, logger);
  return undefined;
}

async function notifyUser(args, text, logger) {
  try {
    if (args?.responseUrl) {
      await fetch(args.responseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response_type: 'ephemeral', text, replace_original: false }),
      });
      return;
    }

    if (args?.client && args?.channelId && args?.userId) {
      await args.client.chat.postEphemeral({ channel: args.channelId, user: args.userId, text });
    }
  } catch (notifyError) {
    logger.debug({ err: notifyError }, 'Failed to notify user about route error');
  }
}
