'use strict';

/**
 * General-purpose Slack helpers.
 *
 * These encode a few hard-won lessons:
 * - Slack gives handlers a 3-second ack window; acking twice (or after the
 *   window) throws — `ackSafely` swallows exactly those cases.
 * - Slack text blocks cap at 3000 characters — `splitSlackTextChunks`
 *   splits on newlines under that limit.
 */

const { ErrorCode } = require('@slack/bolt');
const { normalizeLogger } = require('./logger');

/**
 * Attempt to acknowledge a Slack request while gracefully handling duplicate
 * or late acks.
 *
 * @param {Function} ackFn - Slack ack function
 * @param {Object} [payload] - Optional payload to pass to ack
 * @param {Object} [meta] - Metadata included in logs; may carry a `logger`
 *   key (pino-like) which is used for logging and excluded from log context
 * @returns {Promise<boolean>} - True if ack succeeded, false otherwise
 */
async function ackSafely(ackFn, payload, meta = {}) {
  const { logger: rawLogger, ...context } = meta;
  const logger = normalizeLogger(rawLogger);

  if (typeof ackFn !== 'function') {
    return false;
  }

  try {
    await ackFn(payload);
    return true;
  } catch (error) {
    if (error.code === ErrorCode.ReceiverMultipleAckError) {
      logger.debug(context, 'Slack request already acknowledged by another handler');
      return false;
    }

    if (error.code === ErrorCode.HTTPReceiverDeferredRequestError) {
      logger.warn({ ...context, err: error }, 'Slack request acknowledgement timed out before fallback handler');
      return false;
    }

    logger.error({ ...context, err: error }, 'Failed to acknowledge Slack request');
    return false;
  }
}

/**
 * Run promises with a concurrency limit to avoid overwhelming external APIs.
 * @param {Array} items - Items to process
 * @param {Function} fn - Async function to run for each item
 * @param {number} concurrency - Max concurrent promises (default 3)
 * @returns {Promise<Array>} - Results in same order as items
 */
async function mapWithConcurrency(items, fn, concurrency = 3) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await fn(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Split text into chunks that fit Slack's 3000-character text-block limit,
 * preferring newline boundaries.
 */
function splitSlackTextChunks(text = '', maxLength = 3000) {
  const normalized = String(text || '');
  if (!normalized) return [];

  const chunks = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) {
      splitAt = maxLength;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function isSlackNotFoundError(error) {
  return error?.code === 'slack_webapi_platform_error'
    && error?.data?.error === 'not_found';
}

function isDirectMessageEvent(message = {}) {
  if (message.channel_type === 'im') {
    return true;
  }

  return typeof message.channel === 'string' && message.channel.startsWith('D');
}

function normalizeMultilineNote(value, maxLength = 2000) {
  const normalized = String(value || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim();

  return normalized.slice(0, maxLength);
}

/**
 * Extract Slack user ID from mention format
 * @param {string} mention - Could be "<@U12345>" or "<@U12345|username>" or "U12345"
 * @returns {string|null}
 */
function extractUserId(mention) {
  if (!mention) return null;

  // Already a plain ID (case-insensitive)
  if (/^U[A-Za-z0-9]+$/i.test(mention)) {
    return mention.toUpperCase();
  }

  // Extract from <@U12345> or <@U12345|name> (case-insensitive)
  const match = mention.match(/<@([A-Za-z0-9]+)(?:\|[^>]+)?>/i);
  return match ? match[1].toUpperCase() : null;
}

module.exports = {
  ackSafely,
  mapWithConcurrency,
  splitSlackTextChunks,
  isSlackNotFoundError,
  isDirectMessageEvent,
  normalizeMultilineNote,
  extractUserId,
};
