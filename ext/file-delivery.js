/**
 * File delivery via DM with graceful scope degradation.
 *
 * Uploads a file to the user's DM. If the app is missing the `files:write`
 * scope, falls back to posting the content inline as chunked code blocks so
 * the user still gets their data.
 */

import { isSlackError } from '../lib/client.js';
import { splitSlackTextChunks } from '../lib/helpers.js';
import { normalizeLogger } from '../lib/logger.js';

/**
 * Deliver text content to a user as a file (or inline fallback).
 *
 * @param {Object} client - remack client (createClient / args.client)
 * @param {Object} options
 * @param {string} options.userId - Slack user ID to DM
 * @param {string} options.content - File content (e.g. CSV text)
 * @param {string} options.filename
 * @param {string} [options.title]
 * @param {string} [options.initialComment]
 * @param {Object} [options.logger]
 * @param {number} [options.chunkSize] - Inline fallback chunk size (default 3000)
 * @returns {Promise<{deliveredVia: 'file'|'inline_fallback'}>}
 */
export async function deliverFileToUser(client, {
  userId,
  content,
  filename,
  title,
  initialComment,
  logger: rawLogger,
  chunkSize = 3000,
}) {
  const logger = normalizeLogger(rawLogger);

  const dm = await client.conversations.open({ users: userId });
  const dmChannelId = dm.channel?.id;

  if (!dmChannelId) {
    throw new Error(`Could not open DM channel for file delivery (user ${userId})`);
  }

  try {
    await client.files.upload({
      channelId: dmChannelId,
      filename,
      content,
      title,
      initialComment,
    });

    return { deliveredVia: 'file' };
  } catch (error) {
    if (!isSlackError(error, 'missing_scope')) {
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
