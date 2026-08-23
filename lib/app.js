/**
 * createApp — the composition root and request lifecycle.
 *
 * The app IS a fetch handler: `app.fetch(request) → Response`, portable to
 * any runtime with web fetch primitives. Adapters (lib/node.js) exist only
 * to move raw bytes in and out.
 *
 * Lifecycle:
 *   path route (install/redirect/events) → read rawBody ONCE → verify
 *   signature (fail: 401) → url_verification echo → parse → drop event
 *   retries → authorize (single token or installation store) → match route
 *   (miss: ack anyway — Slack must always get a timely 200) → events: ack
 *   now, run handler as continuation; else loader → handler → ack value →
 *   Response → run deferred work → errors: boundary chain, still 200.
 */

import { verifySlackSignature } from './verify.js';
import { parseSlackRequest, ParseError } from './parse.js';
import { createRouter, unmatchedAckValue, route as declareRoute } from './router.js';
import { createClient } from './client.js';
import { runBoundaryChain } from './errors.js';
import { normalizeLogger } from './logger.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function toResponse(ackValue) {
  if (ackValue instanceof Response) return ackValue;
  if (ackValue === undefined || ackValue === null) return new Response('', { status: 200 });
  if (typeof ackValue === 'string') {
    return new Response(
      JSON.stringify({ response_type: 'ephemeral', text: ackValue }),
      { status: 200, headers: JSON_HEADERS }
    );
  }
  return new Response(JSON.stringify(ackValue), { status: 200, headers: JSON_HEADERS });
}

/**
 * Create a slackline app.
 *
 * @param {Object} options
 * @param {string} [options.signingSecret] - Required (default: SLACK_SIGNING_SECRET env)
 * @param {string} [options.botToken] - Single-token mode (default: SLACK_BOT_TOKEN env)
 * @param {Object} [options.oauth] - Multi-workspace mode:
 *   { clientId, clientSecret, stateSecret, scopes, userScopes?, store, directInstall? }
 * @param {string|URL|Array} [options.routes] - routes/ dir (fs discovery) or
 *   RouteDef array from route(), or a mixed array of dirs and defs
 * @param {Object} [options.context] - App deps injected into every args object
 * @param {Function} [options.onError] - App-level error boundary (error, args) → ackValue|void
 * @param {Function} [options.opsAlert] - sendOpsAlert(title, {error, context})
 * @param {Object} [options.logger] - pino-like logger
 * @param {Object} [options.paths] - { events, install, redirect }
 * @param {boolean} [options.ignoreEventRetries] - Drop x-slack-retry events (default true)
 * @param {string} [options.genericMessage] - Default user-facing error text
 * @returns {{ fetch, client, ready, idle }}
 */
export function createApp({
  signingSecret = process.env.SLACK_SIGNING_SECRET,
  botToken = process.env.SLACK_BOT_TOKEN,
  oauth,
  routes = [],
  context = {},
  onError,
  opsAlert,
  logger: rawLogger,
  paths = {},
  ignoreEventRetries = true,
  genericMessage,
} = {}) {
  const logger = normalizeLogger(rawLogger);
  const resolvedPaths = {
    events: paths.events || '/events',
    install: paths.install || '/install',
    redirect: paths.redirect || '/oauth_redirect',
  };

  if (!signingSecret) {
    throw new Error('createApp requires signingSecret (or SLACK_SIGNING_SECRET)');
  }

  const useOAuth = !botToken && !!oauth;
  if (!botToken && !oauth) {
    throw new Error('createApp requires botToken (single-token mode) or oauth config');
  }
  if (useOAuth) {
    for (const key of ['clientId', 'clientSecret', 'stateSecret', 'store']) {
      if (!oauth[key]) throw new Error(`oauth mode requires oauth.${key}`);
    }
    if (!oauth.scopes || oauth.scopes.length === 0) {
      throw new Error('oauth mode requires oauth.scopes matching your app manifest');
    }
  }

  logger.info({ mode: useOAuth ? 'oauth' : 'single-token' }, 'Initializing Slack app');

  const appClient = botToken ? createClient({ token: botToken, logger }) : null;

  // ── Routes: defs now, fs dirs resolved lazily behind `ready` ─────────────
  const routeList = Array.isArray(routes) ? routes : [routes];
  const staticDefs = routeList.filter((entry) => typeof entry === 'object' && entry?.kind);
  const dirs = routeList.filter((entry) => typeof entry === 'string' || entry instanceof URL);

  let router = createRouter({ routes: staticDefs, logger });
  const ready = (async () => {
    if (dirs.length === 0) return;
    const { loadRoutes } = await import('./routes-fs.js');
    const discovered = [];
    for (const dir of dirs) {
      discovered.push(...await loadRoutes(dir, { logger }));
    }
    router = createRouter({ routes: [...staticDefs, ...discovered], logger });
  })();

  // ── Continuations (post-ack work) ────────────────────────────────────────
  const pending = new Set();

  function track(promiseLike) {
    const promise = Promise.resolve(promiseLike);
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
    return promise;
  }

  async function idle() {
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
    }
  }

  // ── OAuth sub-app (lazy) ─────────────────────────────────────────────────
  let oauthRoutesPromise = null;
  function getOAuthRoutes() {
    oauthRoutesPromise ||= import('./oauth.js').then(({ createOAuthRoutes }) =>
      createOAuthRoutes({ ...oauth, logger })
    );
    return oauthRoutesPromise;
  }

  async function authorize(slackReq) {
    if (!useOAuth) return appClient;

    const installation = await oauth.store.get({
      teamId: slackReq.teamId,
      enterpriseId: slackReq.enterpriseId,
      isEnterpriseInstall: slackReq.isEnterpriseInstall,
    });

    const token = installation?.bot?.token;
    if (!token) {
      logger.warn({ teamId: slackReq.teamId }, 'No installation found for workspace');
      return null;
    }
    return createClient({ token, logger });
  }

  function buildArgs(slackReq, client, deferred) {
    const args = {
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

      /** POST a message to response_url (post-ack). */
      respond: async (msg) => {
        if (!slackReq.responseUrl) {
          logger.warn({ kind: slackReq.kind, id: slackReq.id }, 'respond() called without a response_url');
          return;
        }
        const body = typeof msg === 'string' ? { response_type: 'ephemeral', text: msg } : msg;
        await fetch(slackReq.responseUrl, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(body),
        });
      },

      /** Queue work to run after the ack is sent. */
      defer: (fn) => {
        if (deferred.flushed) {
          runContinuation(fn, args, null);
        } else {
          deferred.queue.push(fn);
        }
      },
    };
    return args;
  }

  function runContinuation(fn, args, routeModule) {
    track(
      Promise.resolve()
        .then(() => fn(args))
        .catch((error) => runBoundaryChain({
          error, args, routeModule, onError, opsAlert,
          phase: 'deferred', genericMessage, logger,
        }).catch(() => {}))
    );
  }

  function flushDeferred(deferred, args, routeModule) {
    deferred.flushed = true;
    for (const fn of deferred.queue) {
      runContinuation(fn, args, routeModule);
    }
    deferred.queue.length = 0;
  }

  // ── Per-kind ack-value handling ──────────────────────────────────────────
  function ackResponseFor(slackReq, ackValue, args) {
    // block_actions/shortcut acks have no body semantics on Slack's side —
    // a returned message is delivered via response_url instead.
    if ((slackReq.kind === 'action' || slackReq.kind === 'shortcut')
        && ackValue !== undefined && !(ackValue instanceof Response)) {
      if (slackReq.responseUrl) {
        args.defer(() => args.respond(ackValue));
      } else {
        logger.warn({ kind: slackReq.kind, id: slackReq.id }, 'Returned message but payload has no response_url');
      }
      return toResponse(undefined);
    }

    if (slackReq.kind === 'options' && ackValue === undefined) {
      return toResponse({ options: [] });
    }

    return toResponse(ackValue);
  }

  /**
   * Run an event route: loader → render (published to the home tab) or
   * default handler. Called as a continuation — the 200 already went out.
   */
  async function runEventRoute(def, args) {
    if (typeof def.module.loader === 'function') {
      args.data = await def.module.loader(args);
    }

    if (typeof def.module.render === 'function' && args.id === 'app_home_opened') {
      const rendered = await def.module.render(args);
      const viewObject = Array.isArray(rendered) ? { type: 'home', blocks: rendered } : rendered;
      await args.client.views.publish({ user_id: args.userId, view: viewObject });
      if (typeof def.module.default !== 'function') return;
    }

    if (typeof def.module.default === 'function') {
      await def.module.default(args);
    }
  }

  // ── The app ──────────────────────────────────────────────────────────────
  async function handleEvents(request) {
    const rawBody = await request.text();

    const verdict = await verifySlackSignature({
      signingSecret,
      timestamp: request.headers.get('x-slack-request-timestamp'),
      signature: request.headers.get('x-slack-signature'),
      rawBody,
    });
    if (!verdict.ok) {
      logger.warn({ reason: verdict.reason }, 'Rejected Slack request with invalid signature');
      return new Response('invalid signature', { status: 401 });
    }

    let slackReq;
    try {
      slackReq = parseSlackRequest({
        contentType: request.headers.get('content-type') || '',
        rawBody,
        headers: {
          'x-slack-retry-num': request.headers.get('x-slack-retry-num') || undefined,
          'x-slack-retry-reason': request.headers.get('x-slack-retry-reason') || undefined,
        },
      });
    } catch (error) {
      if (error instanceof ParseError || error instanceof SyntaxError) {
        logger.warn({ err: error }, 'Unparseable Slack payload');
        return new Response('bad request', { status: 400 });
      }
      throw error;
    }

    if (slackReq.kind === 'url_verification') {
      return new Response(JSON.stringify({ challenge: slackReq.challenge }), {
        status: 200, headers: JSON_HEADERS,
      });
    }

    if (slackReq.kind === 'event' && slackReq.retry && ignoreEventRetries) {
      logger.debug({ id: slackReq.id, retry: slackReq.retry }, 'Dropping Slack event retry');
      return new Response('', { status: 200 });
    }

    await ready;

    // Housekeeping in oauth mode: forget uninstalled workspaces
    if (useOAuth && slackReq.kind === 'event'
        && (slackReq.id === 'app_uninstalled' || slackReq.id === 'tokens_revoked')) {
      track(
        Promise.resolve(oauth.store.delete({
          teamId: slackReq.teamId,
          enterpriseId: slackReq.enterpriseId,
          isEnterpriseInstall: slackReq.isEnterpriseInstall,
        })).catch((error) => logger.error({ err: error }, 'Failed to delete installation on uninstall'))
      );
    }

    const client = await authorize(slackReq);
    if (useOAuth && !client) {
      return new Response('', { status: 200 }); // unknown workspace: ack, never 500
    }

    const def = router.match(slackReq.kind, slackReq.id);
    if (!def) {
      // The catch-all lesson: always ack what you don't handle
      logger.info({ kind: slackReq.kind, id: slackReq.id }, 'Unhandled Slack request acknowledged');
      return toResponse(unmatchedAckValue(slackReq.kind));
    }

    const deferred = { queue: [], flushed: false };
    const args = buildArgs(slackReq, client, deferred);

    // Events: ack first structurally; the handler is a continuation
    if (slackReq.kind === 'event') {
      runContinuation(() => runEventRoute(def, args), args, def.module);
      flushDeferred(deferred, args, def.module);
      return new Response('', { status: 200 });
    }

    // Interactive kinds: loader → handler → ack value, within Slack's 3s window
    try {
      if (typeof def.module.loader === 'function') {
        args.data = await def.module.loader(args);
      }
      const handler = def.module.default ?? def.module.render;
      const ackValue = await handler(args);
      const response = ackResponseFor(slackReq, ackValue, args);
      flushDeferred(deferred, args, def.module);
      return response;
    } catch (error) {
      const ackValue = await runBoundaryChain({
        error, args, routeModule: def.module, onError, opsAlert,
        phase: 'ack', genericMessage, logger,
      }).catch(() => undefined);
      flushDeferred(deferred, args, def.module);
      return toResponse(ackValue);
    }
  }

  async function appFetch(request) {
    const url = new URL(request.url);

    if (url.pathname === resolvedPaths.events && request.method === 'POST') {
      return handleEvents(request);
    }

    if (useOAuth && url.pathname === resolvedPaths.install) {
      const oauthRoutes = await getOAuthRoutes();
      return oauthRoutes.install(request);
    }

    if (useOAuth && url.pathname === resolvedPaths.redirect) {
      const oauthRoutes = await getOAuthRoutes();
      return oauthRoutes.callback(request);
    }

    return new Response('not found', { status: 404 });
  }

  return {
    fetch: appFetch,
    client: appClient,
    ready,
    idle,
  };
}

export { declareRoute as route };
