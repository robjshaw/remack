'use strict';

/**
 * File delivery via DM with graceful scope degradation.
 *
 * Uploads a file to the user's DM via files.uploadV2. If the app is missing
 * the `files:write` scope, falls back to posting the content inline as
 * chunked code blocks so the user still gets their data.
 */

const { splitSlackTextChunks } = require('./helpers');
const { normalizeLogger } = require('./logger');

/**
 * Deliver text content to a user as a file (or inline fallback).
 *
 * @param {Object} client - Slack WebClient
 * @param {Object} options
 * @param {string} options.userId - Slack user ID to DM
 * @param {string} options.content - File content (e.g. CSV text)
 * @param {string} options.filename
 * @param {string} [options.title]
 * @param {string} [options.initialComment]
 * @param {Object} [options.logger] - pino-like logger
 * @param {number} [options.chunkSize] - Inline fallback chunk size (default 3000)
 * @returns {Promise<{deliveredVia: 'file'|'inline_fallback'}>}
 */
async function deliverFileToUser(client, {
  userId,
  content,
  filename,
  title,
  initialComment,
  logger: rawLogger,
  chunkSize = 3000,
}) {
  const logger = normalizeLogger(rawLogger);

  const dmChannel = await client.conversations.open({ users: userId });
  const dmChannelId = dmChannel.channel?.id;

  if (!dmChannelId) {
    throw new Error(`Could not open DM channel for file delivery (user ${userId})`);
  }

  try {
    await client.files.uploadV2({
      channel_id: dmChannelId,
      filename,
      content,
      title,
      initial_comment: initialComment,
    });

    return { deliveredVia: 'file' };
  } catch (error) {
    const slackError = error?.data?.error || error?.message || 'unknown_error';
    if (slackError !== 'missing_scope') {
      throw error;
    }

    logger.warn({ err: error, userId, filename }, 'Slack file upload scope missing; falling back to DM text delivery');

    const chunks = splitSlackTextChunks(content, chunkSize);
    await client.chat.postMessage({
      channel: dmChannelId,
      text: `${initialComment ? `${initialComment}\n\n` : ''}Slack app is missing \`files:write\`, so this export is delivered inline.\nFilename: \`${filename}\``,
    });

    for (let index = 0; index < chunks.length; index += 1) {
      await client.chat.postMessage({
        channel: dmChannelId,
        text: `Chunk ${index + 1}/${chunks.length} for \`${filename}\`:\n\`\`\`\n${chunks[index]}\n\`\`\``,
      });
    }

    return { deliveredVia: 'inline_fallback' };
  }
}

module.exports = {
  deliverFileToUser,
  // Backwards-compatible alias for callers ported from apps that used the
  // original CSV-specific name; accepts `csv` in place of `content`.
  deliverCsvExportToUser: (client, { csv, ...rest }) =>
    deliverFileToUser(client, { content: csv ?? rest.content, ...rest }),
};
