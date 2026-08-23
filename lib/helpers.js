/**
 * General-purpose Slack helpers.
 *
 * Slack text blocks cap at 3000 characters — `splitSlackTextChunks` splits
 * on newlines under that limit.
 */

/**
 * Run promises with a concurrency limit to avoid overwhelming external APIs.
 * @param {Array} items - Items to process
 * @param {Function} fn - Async function to run for each item
 * @param {number} concurrency - Max concurrent promises (default 3)
 * @returns {Promise<Array>} - Results in same order as items
 */
export async function mapWithConcurrency(items, fn, concurrency = 3) {
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
export function splitSlackTextChunks(text = '', maxLength = 3000) {
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

export function isDirectMessageEvent(message = {}) {
  if (message.channel_type === 'im') {
    return true;
  }

  return typeof message.channel === 'string' && message.channel.startsWith('D');
}

/**
 * Extract Slack user ID from mention format
 * @param {string} mention - Could be "<@U12345>" or "<@U12345|username>" or "U12345"
 * @returns {string|null}
 */
export function extractUserId(mention) {
  if (!mention) return null;

  // Already a plain ID (case-insensitive)
  if (/^U[A-Za-z0-9]+$/i.test(mention)) {
    return mention.toUpperCase();
  }

  // Extract from <@U12345> or <@U12345|name> (case-insensitive)
  const match = mention.match(/<@([A-Za-z0-9]+)(?:\|[^>]+)?>/i);
  return match ? match[1].toUpperCase() : null;
}
