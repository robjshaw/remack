/** Shared test doubles for remack tests. */

import { createHmac } from 'node:crypto';

/**
 * Fake pg pool: records query(text, params) calls and returns scripted rows.
 * Pass an array of results (consumed in order) or a function (text, params) => {rows}.
 */
export function fakePool(script = []) {
  const calls = [];
  const scriptFn = typeof script === 'function' ? script : null;
  const queue = scriptFn ? null : [...script];

  return {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      if (scriptFn) return scriptFn(text, params);
      const next = queue.length ? queue.shift() : { rows: [] };
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

/**
 * Silent logger that records calls. Children record into the same
 * `entries`, with their bindings merged into objOrMsg (pino semantics).
 */
export function fakeLogger(entries = [], bindings = {}) {
  const make = (level) => (objOrMsg, msg) => entries.push(typeof objOrMsg === 'string'
    ? { level, objOrMsg: Object.keys(bindings).length ? { ...bindings } : objOrMsg, msg: msg ?? objOrMsg }
    : { level, objOrMsg: { ...bindings, ...(objOrMsg || {}) }, msg });
  return {
    entries,
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    child: (more = {}) => fakeLogger(entries, { ...bindings, ...more }),
  };
}

/**
 * Fake global-fetch replacement: records requests and returns scripted
 * responses. Script entries may be:
 *   - a function (url, init) => Response | object (object → JSON 200)
 *   - an object → JSON 200 response
 *   - a Response
 * Pass an array (consumed in order) or a single function used for all calls.
 */
export function fakeFetch(script = []) {
  const calls = [];
  const scriptFn = typeof script === 'function' ? script : null;
  const queue = scriptFn ? null : [...script];

  const fetchFn = async (url, init = {}) => {
    const call = { url: String(url), init };
    // Preserve a readable copy of the body for assertions
    if (typeof init.body === 'string') call.body = init.body;
    else if (init.body instanceof Uint8Array) call.body = init.body;
    calls.push(call);

    let entry = scriptFn ? scriptFn(url, init) : (queue.length ? queue.shift() : { ok: true });
    if (typeof entry === 'function') entry = entry(url, init);
    if (entry instanceof Error) throw entry;
    if (entry instanceof Response) return entry;
    return new Response(JSON.stringify(entry), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  fetchFn.calls = calls;
  return fetchFn;
}

export const TEST_SIGNING_SECRET = 'test-signing-secret';

/**
 * Build a correctly-signed Slack HTTP Request for app.fetch().
 *
 * @param {Object} options
 * @param {string} [options.path] - Request path (default '/events')
 * @param {string|URLSearchParams|Object} options.body - Raw body string, form
 *   params, or an object (sent as JSON)
 * @param {string} [options.contentType] - Defaults by body type
 * @param {string} [options.signingSecret]
 * @param {number} [options.timestamp] - Unix seconds (default: now)
 * @param {Object} [options.headers] - Extra headers
 * @returns {Request}
 */
export function signedRequest({
  path = '/events',
  body,
  contentType,
  signingSecret = TEST_SIGNING_SECRET,
  timestamp = Math.floor(Date.now() / 1000),
  headers = {},
} = {}) {
  let rawBody;
  let resolvedContentType = contentType;

  if (typeof body === 'string') {
    rawBody = body;
    resolvedContentType ||= 'application/x-www-form-urlencoded';
  } else if (body instanceof URLSearchParams) {
    rawBody = body.toString();
    resolvedContentType ||= 'application/x-www-form-urlencoded';
  } else {
    rawBody = JSON.stringify(body);
    resolvedContentType ||= 'application/json';
  }

  const signature = 'v0=' + createHmac('sha256', signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex');

  return new Request(`https://bot.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': resolvedContentType,
      'x-slack-request-timestamp': String(timestamp),
      'x-slack-signature': signature,
      ...headers,
    },
    body: rawBody,
  });
}

/** Form-encode an interactivity payload the way Slack does. */
export function interactivityBody(payload) {
  return new URLSearchParams({ payload: JSON.stringify(payload) });
}
