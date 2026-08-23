/**
 * Minimal Slack Web API client on global fetch. Zero dependencies.
 *
 * `client.call('chat.postMessage', params)` POSTs to slack.com/api/… with a
 * bearer token. Proxy dot-access mirrors the method names, so
 * `client.chat.postMessage(params)` is the same call — the full API surface
 * without generated code.
 *
 * `ok: false` responses throw SlackApiError carrying Slack's error code
 * (e.g. 'missing_scope', 'not_found'); 429s honor Retry-After with bounded
 * retries.
 */

import { normalizeLogger } from './logger.js';

const BASE_URL = 'https://slack.com/api/';

// Slack methods that reject JSON bodies and require form encoding.
const FORM_ONLY_METHODS = new Set([
  'oauth.v2.access',
  'oauth.access',
  'files.getUploadURLExternal',
]);

export class SlackApiError extends Error {
  constructor(method, data) {
    super(`Slack API ${method} failed: ${data?.error || 'unknown_error'}`);
    this.name = 'SlackApiError';
    this.method = method;
    this.error = data?.error || 'unknown_error';
    this.data = data;
  }
}

/**
 * True if err is a SlackApiError (optionally with a specific error code).
 * @param {unknown} err
 * @param {string} [code] - e.g. 'not_found', 'missing_scope'
 */
export function isSlackError(err, code) {
  if (!(err instanceof SlackApiError)) return false;
  return code === undefined || err.error === code;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a Slack Web API client.
 *
 * @param {Object} options
 * @param {string} [options.token] - Bot token; omit only for auth-less
 *   methods like oauth.v2.access
 * @param {Function} [options.fetch] - fetch implementation (tests)
 * @param {number} [options.maxRetries] - 429 retries (default 2)
 * @param {Object} [options.logger] - pino-like logger
 */
export function createClient({
  token,
  fetch = globalThis.fetch,
  maxRetries = 2,
  logger: rawLogger,
} = {}) {
  const logger = normalizeLogger(rawLogger);

  async function call(method, params = {}, { encoding } = {}) {
    const useForm = encoding === 'form' || (encoding === undefined && FORM_ONLY_METHODS.has(method));

    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;

    let body;
    if (useForm) {
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) form.set(key, String(value));
      }
      body = form.toString();
      headers['content-type'] = 'application/x-www-form-urlencoded';
    } else {
      body = JSON.stringify(params);
      headers['content-type'] = 'application/json; charset=utf-8';
    }

    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(BASE_URL + method, { method: 'POST', headers, body });

      if (response.status === 429 && attempt < maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after')) || 1;
        logger.warn({ method, retryAfter, attempt }, 'Slack rate limit hit; retrying');
        await sleep(retryAfter * 1000);
        continue;
      }

      const data = await response.json();
      if (!data.ok) {
        throw new SlackApiError(method, data);
      }
      return data;
    }
  }

  /**
   * Upload a file to a channel via Slack's external-upload flow:
   * files.getUploadURLExternal → POST bytes → files.completeUploadExternal.
   *
   * @param {Object} options
   * @param {string} options.channelId
   * @param {string} options.filename
   * @param {string} [options.content] - Text content (UTF-8 encoded)
   * @param {Uint8Array} [options.bytes] - Raw bytes (alternative to content)
   * @param {string} [options.title]
   * @param {string} [options.initialComment]
   * @returns {Promise<{fileId: string}>}
   */
  async function upload({ channelId, filename, content, bytes, title, initialComment }) {
    const fileBytes = bytes ?? new TextEncoder().encode(content ?? '');

    const { upload_url: uploadUrl, file_id: fileId } = await call('files.getUploadURLExternal', {
      filename,
      length: fileBytes.byteLength, // byte count, NOT string length
    });

    const postResponse = await fetch(uploadUrl, { method: 'POST', body: fileBytes });
    if (!postResponse.ok) {
      throw new SlackApiError('files.uploadBytes', { error: `upload_post_failed_${postResponse.status}` });
    }

    await call('files.completeUploadExternal', {
      files: [{ id: fileId, title: title || filename }],
      channel_id: channelId,
      initial_comment: initialComment,
    }, { encoding: 'json' });

    return { fileId };
  }

  const base = { call, token, files: undefined };

  // Proxy dot-access: client.chat.postMessage(p) → call('chat.postMessage', p).
  // One level of nesting covers the whole Web API namespace.
  const client = new Proxy(base, {
    get(target, prop) {
      if (prop in target && target[prop] !== undefined) return target[prop];
      if (typeof prop !== 'string') return undefined;

      return new Proxy({}, {
        get(_, methodName) {
          if (typeof methodName !== 'string') return undefined;
          const method = `${prop}.${methodName}`;
          if (prop === 'files' && methodName === 'upload') return upload;
          return (params, opts) => call(method, params, opts);
        },
      });
    },
  });

  return client;
}
