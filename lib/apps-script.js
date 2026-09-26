/**
 * Google Apps Script adapter — a slackline bot with no server: deploy a
 * script as a web app from any Google account and point Slack at it.
 *
 * Apps Script differs from every other runtime in ways that shape this
 * module, and they are trade-offs, not bugs:
 *
 *  1. doPost(e) never sees HTTP headers, so x-slack-signature CANNOT be
 *     verified. Requests are authenticated with two shared secrets instead:
 *     Slack's verification token (deprecated, but still sent in every
 *     body) and a random `?key=` on the Request URL. Both are required.
 *     Neither gives replay protection — the signing secret is the only
 *     thing that does, and it needs headers.
 *  2. Execution is synchronous and ends at `return`. Handlers must be
 *     synchronous (client calls return results directly), events run
 *     BEFORE the ack, defer() is unavailable, and respond() posts inline.
 *     Everything counts against Slack's 3s window, cold start included.
 *  3. No retry headers, so Events API retries are dropped by event_id,
 *     remembered in CacheService.
 *
 * The same route modules, args shape, ack model and error boundary chain
 * as createApp — only the sync constraint differs. This file must stay
 * free of Node and web-platform globals (fetch, URLSearchParams, crypto,
 * TextEncoder, process, Buffer): it is bundled for Apps Script's bare V8
 * by `slackline build:apps-script`.
 */

import { parseSlackRequest, ParseError } from './parse.js';
import { createRouter, unmatchedAckValue, route } from './router.js';
import { UserError } from './errors.js';
import { SlackApiError, isSlackError } from './client.js';
import { normalizeLogger, childLogger } from './logger.js';
import { message, view, options, optionGroups } from './respond.js';

export { route, UserError, SlackApiError, isSlackError, message, view, options, optionGroups };

const BASE_URL = 'https://slack.com/api/';
const SLOW_ACK_MS = 2000;
const MIN_URL_KEY_LENGTH = 16;

/** Length-leaking but otherwise constant-time string compare (no crypto on Apps Script). */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `key` from the query string only — e.parameter also merges form fields. */
function queryParam(queryString, name) {
  for (const pair of (queryString || '').split('&')) {
    const eq = pair.indexOf('=');
    const key = decodeURIComponent((eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, ' '));
    if (key === name) return eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
  }
  return null;
}

/** Throw if a handler went async: its promise can never settle before doPost returns. */
function requireSync(result, what) {
  if (result && typeof result.then === 'function') {
    result.then(undefined, () => {}); // don't leave an unhandled rejection behind
    throw new Error(`${what} returned a Promise. Apps Script runs synchronously and `
      + 'ends at return, so async work never finishes: drop async/await — client '
      + 'calls return results directly here.');
  }
  return result;
}

function makeId(services) {
  if (typeof services.Utilities?.getUuid === 'function') return services.Utilities.getUuid();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Synchronous Slack Web API client over UrlFetchApp. Same surface as
 * createClient: `client.call(method, params)` or `client.chat.postMessage(params)`,
 * `ok:false` throws SlackApiError, 429 honors Retry-After.
 *
 * @param {Object} options
 * @param {string} options.token
 * @param {Object} [options.UrlFetchApp] - default: the Apps Script global
 * @param {Function} [options.sleep] - (ms) => void; default Utilities.sleep
 * @param {number} [options.maxRetries] - 429 retries (default 2)
 */
export function createGasClient({
  token,
  UrlFetchApp = globalThis.UrlFetchApp,
  sleep = (ms) => globalThis.Utilities?.sleep(ms),
  maxRetries = 2,
} = {}) {
  function call(method, params = {}) {
    for (let attempt = 0; ; attempt++) {
      const response = UrlFetchApp.fetch(BASE_URL + method, {
        method: 'post',
        contentType: 'application/json; charset=utf-8',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        payload: JSON.stringify(params),
        muteHttpExceptions: true,
      });

      if (response.getResponseCode() === 429 && attempt < maxRetries) {
        const headers = response.getHeaders() || {};
        const retryAfter = Number(headers['Retry-After'] ?? headers['retry-after'] ?? 1);
        sleep(Math.max(1, retryAfter) * 1000);
        continue;
      }

      let data;
      try {
        data = JSON.parse(response.getContentText());
      } catch {
        throw new SlackApiError(method, { error: `http_${response.getResponseCode()}` });
      }
      if (!data.ok) throw new SlackApiError(method, data);
      return data;
    }
  }

  const client = { token, call };
  return new Proxy(client, {
    get(target, prop) {
      if (prop in target || typeof prop !== 'string') return target[prop];
      if (prop === 'then') return undefined; // never look like a thenable
      return methodProxy(prop);
    },
  });

  function methodProxy(path) {
    return new Proxy((params) => call(path, params), {
      get(target, prop) {
        if (typeof prop !== 'string' || prop === 'then') return undefined;
        return methodProxy(`${path}.${prop}`);
      },
    });
  }
}

/**
 * Create a slackline app for Apps Script. Wire it up with:
 *
 *   function doPost(e) { return app().doPost(e); }
 *
 * Secrets default to Script Properties (Project Settings → Script
 * Properties): SLACK_VERIFICATION_TOKEN, SLACK_URL_KEY, SLACK_BOT_TOKEN.
 *
 * @param {Object} options
 * @param {string} [options.verificationToken] - Basic Information → App
 *   Credentials → Verification Token
 * @param {string} [options.urlKey] - ≥16 random chars; the Request URL is
 *   `https://script.google.com/macros/s/…/exec?key=<urlKey>`
 * @param {string} [options.botToken] - xoxb- token (single workspace)
 * @param {Array} [options.routes] - RouteDefs from route()
 * @param {Object} [options.context] - injected into every args
 * @param {Function} [options.onError] - (error, args) => ackValue|void
 * @param {Function} [options.opsAlert] - (title, {error, context}) => void; sync
 * @param {Object} [options.logger] - default console (→ Executions log)
 * @param {string} [options.genericMessage]
 * @param {number} [options.dedupeSeconds] - event_id memory (default 3600)
 * @param {Object} [options.services] - Apps Script services (tests); default globalThis
 * @returns {{ doPost(e), client }}
 */
export function createAppsScriptApp(rawOptions = {}) {
  const services = rawOptions.services || globalThis;
  const props = services.PropertiesService?.getScriptProperties().getProperties() || {};
  const {
    verificationToken = props.SLACK_VERIFICATION_TOKEN,
    urlKey = props.SLACK_URL_KEY,
    botToken = props.SLACK_BOT_TOKEN,
    routes = [],
    context = {},
    onError,
    opsAlert,
    logger: rawLogger,
    genericMessage = 'Something went wrong. Please try again.',
    dedupeSeconds = 3600,
  } = rawOptions;

  if (!verificationToken) {
    throw new Error('createAppsScriptApp requires verificationToken (or the SLACK_VERIFICATION_TOKEN script property): '
      + 'Apps Script cannot read the x-slack-signature header, so the body token is the check that remains.');
  }
  if (!urlKey || urlKey.length < MIN_URL_KEY_LENGTH) {
    throw new Error(`createAppsScriptApp requires urlKey (or the SLACK_URL_KEY script property) of at least ${MIN_URL_KEY_LENGTH} random characters, `
      + 'appended to the Request URL as ?key=…');
  }
  if (!botToken) {
    throw new Error('createAppsScriptApp requires botToken (or the SLACK_BOT_TOKEN script property)');
  }

  const logger = normalizeLogger(rawLogger);
  const router = createRouter({ routes, logger });
  const client = createGasClient({
    token: botToken,
    UrlFetchApp: services.UrlFetchApp,
    sleep: (ms) => services.Utilities?.sleep(ms),
  });

  // ── Output ────────────────────────────────────────────────────────────────
  function output(body) {
    const { ContentService } = services;
    if (body === undefined || body === null) return ContentService.createTextOutput('');
    const text = typeof body === 'string'
      ? JSON.stringify({ response_type: 'ephemeral', text: body })
      : JSON.stringify(body);
    return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
  }

  function postToResponseUrl(responseUrl, msg) {
    services.UrlFetchApp.fetch(responseUrl, {
      method: 'post',
      contentType: 'application/json; charset=utf-8',
      payload: JSON.stringify(typeof msg === 'string' ? { response_type: 'ephemeral', text: msg } : msg),
      muteHttpExceptions: true,
    });
  }

  /** Drop Events API retries: remember each event_id for dedupeSeconds. */
  function seenBefore(eventId) {
    if (!eventId || !services.CacheService) return false;
    const cache = services.CacheService.getScriptCache();
    const key = `slackline:event:${eventId}`;
    if (cache.get(key)) return true;
    cache.put(key, '1', Math.min(dedupeSeconds, 21600)); // CacheService max TTL is 6h
    return false;
  }

  // ── Error boundary chain (sync twin of errors.js runBoundaryChain) ────────
  function runBoundaryChain(error, args, routeModule, log) {
    if (typeof routeModule?.ErrorBoundary === 'function') {
      try {
        return requireSync(routeModule.ErrorBoundary({ ...args, error }), 'ErrorBoundary');
      } catch (boundaryError) {
        log.error({ err: boundaryError }, 'Route ErrorBoundary threw; falling through');
      }
    }

    if (typeof onError === 'function') {
      try {
        const result = requireSync(onError(error, args), 'onError');
        if (result !== undefined) return result;
      } catch (onErrorError) {
        log.error({ err: onErrorError }, 'App onError threw; falling through');
      }
    }

    const isUserError = error instanceof UserError;
    if (isUserError) {
      log.warn({ err: error }, 'Handler raised user-facing error');
    } else {
      log.error({ err: error }, 'Unhandled error in Slack route');
      if (typeof opsAlert === 'function') {
        try {
          opsAlert(`Slack route error: ${args.kind} ${args.id}`.trim(), {
            error, context: { kind: args.kind, id: args.id, userId: args.userId, teamId: args.teamId },
          });
        } catch { /* alerting must never be the reason handling fails */ }
      }
    }

    const text = isUserError ? error.userMessage : genericMessage;
    if (args.kind === 'command') return { response_type: 'ephemeral', text };

    try {
      if (args.responseUrl) {
        postToResponseUrl(args.responseUrl, { response_type: 'ephemeral', text, replace_original: false });
      } else if (args.channelId && args.userId) {
        client.chat.postEphemeral({ channel: args.channelId, user: args.userId, text });
      }
    } catch (notifyError) {
      log.debug({ err: notifyError }, 'Failed to notify user about route error');
    }
    return undefined;
  }

  // ── Route execution ───────────────────────────────────────────────────────
  function runRoute(def, args, log) {
    const mod = def.module;
    if (typeof mod.loader === 'function') {
      args.data = requireSync(mod.loader(args), 'loader');
    }

    if (args.kind === 'event') {
      if (typeof mod.render === 'function' && args.id === 'app_home_opened') {
        const rendered = requireSync(mod.render(args), 'render');
        const viewObject = Array.isArray(rendered) ? { type: 'home', blocks: rendered } : rendered;
        client.views.publish({ user_id: args.userId, view: viewObject });
      }
      if (typeof mod.default === 'function') requireSync(mod.default(args), 'handler');
      return undefined; // events: return value ignored
    }

    const handler = mod.default ?? mod.render;
    const ackValue = requireSync(handler(args), 'handler');

    // block_actions/shortcut acks have no body semantics: deliver via response_url
    if ((args.kind === 'action' || args.kind === 'shortcut') && ackValue !== undefined) {
      if (args.responseUrl) postToResponseUrl(args.responseUrl, ackValue);
      else log.warn('Returned message but payload has no response_url');
      return undefined;
    }
    if (args.kind === 'options' && ackValue === undefined) return { options: [] };
    return ackValue;
  }

  function buildArgs(slackReq, requestId, log) {
    return {
      requestId,
      log,
      kind: slackReq.kind,
      id: slackReq.id,
      payload: slackReq.payload,
      teamId: slackReq.teamId,
      userId: slackReq.userId,
      channelId: slackReq.channelId,
      triggerId: slackReq.triggerId,
      responseUrl: slackReq.responseUrl,
      client,
      context,
      data: undefined,
      respond: (msg) => {
        if (!slackReq.responseUrl) {
          log.warn('respond() called without a response_url');
          return;
        }
        postToResponseUrl(slackReq.responseUrl, msg);
      },
      defer: () => {
        throw new Error('defer() is unavailable on Apps Script: nothing can run after the '
          + 'response. Do the work inline (it counts against the 3s ack window).');
      },
    };
  }

  // ── doPost ────────────────────────────────────────────────────────────────
  function handle(e, state) {
    if (!safeEqual(queryParam(e?.queryString, 'key'), urlKey)) {
      state.log.warn('Rejected request: missing or wrong ?key= on the Request URL');
      state.outcome = 'rejected';
      return output(undefined);
    }

    let slackReq;
    try {
      slackReq = parseSlackRequest({
        contentType: e?.postData?.type || '',
        rawBody: e?.postData?.contents || '',
      });
    } catch (error) {
      if (!(error instanceof ParseError || error instanceof SyntaxError)) throw error;
      state.log.warn({ err: error }, 'Unparseable Slack payload');
      state.outcome = 'bad_request';
      return output(undefined);
    }

    const bodyToken = slackReq.kind === 'url_verification' ? slackReq.token : slackReq.payload?.token;
    if (!safeEqual(bodyToken, verificationToken)) {
      state.log.warn('Rejected request: verification token mismatch');
      state.outcome = 'rejected';
      return output(undefined);
    }

    state.log = childLogger(state.log, {
      kind: slackReq.kind, id: slackReq.id, teamId: slackReq.teamId, userId: slackReq.userId,
    });

    if (slackReq.kind === 'url_verification') {
      state.outcome = 'url_verification';
      return output({ challenge: slackReq.challenge });
    }

    if (slackReq.kind === 'event' && seenBefore(slackReq.payload?.event_id)) {
      state.outcome = 'retry_dropped';
      return output(undefined);
    }

    const def = router.match(slackReq.kind, slackReq.id);
    if (!def) {
      state.outcome = 'unhandled';
      return output(unmatchedAckValue(slackReq.kind));
    }

    const args = buildArgs(slackReq, state.requestId, state.log);
    try {
      return output(runRoute(def, args, state.log));
    } catch (error) {
      state.outcome = 'error';
      let ackValue;
      try {
        ackValue = runBoundaryChain(error, args, def.module, state.log);
      } catch { /* the chain itself must never fail the ack */ }
      // Events ignore ack bodies; everything else may carry the boundary's
      return output(slackReq.kind === 'event' ? undefined : ackValue);
    }
  }

  function doPost(e) {
    const start = Date.now();
    const requestId = makeId(services);
    const state = { requestId, outcome: 'ok', log: childLogger(logger, { requestId }) };

    let result;
    try {
      result = handle(e, state);
    } catch (error) {
      // Never let Apps Script render its HTML error page at Slack
      state.outcome = 'crashed';
      state.log.error({ err: error }, 'Slack request failed outside the route boundary');
      result = output(undefined);
    }

    const ackMs = Date.now() - start;
    const summary = { outcome: state.outcome, ackMs };
    if (ackMs > SLOW_ACK_MS) {
      state.log.warn({ ...summary, limitMs: 3000 },
        'Slow Slack ack: Apps Script runs everything before the ack — Slack gives up at 3s');
    } else {
      state.log.info(summary, 'Slack request handled');
    }
    return result;
  }

  return { doPost, client };
}
