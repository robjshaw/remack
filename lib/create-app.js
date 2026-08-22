'use strict';

/**
 * Slack app bootstrap with dual-mode authentication.
 *
 * Modes (auto-detected, same precedence as explicit options):
 * 1. Single-token: `botToken` set → static token, no OAuth.
 * 2. OAuth: no botToken but `clientId` set → OAuth flow with an
 *    installationStore (see createInstallationStore) and directInstall.
 *
 * Mounting: the returned `receiver.router` is an Express router. Standalone,
 * call `await app.start(port)`. Inside an existing Express app, mount it —
 * `expressApp.use('/slack', receiver.router)` — and CRITICALLY make sure no
 * body-parser touches the mount path first: Bolt must see the raw body to
 * verify request signatures. Skip json/urlencoded middleware for the mount
 * path or signature verification fails on every request.
 */

const { App, ExpressReceiver } = require('@slack/bolt');
const { normalizeLogger } = require('./logger');
const { createRegistrar } = require('./registrar');

/**
 * A reasonable starting scope set for an interactive bot. Your app's OAuth
 * scopes MUST match its manifest — treat this as a template, not a default.
 */
const DEFAULT_SCOPES = [
  'app_mentions:read',
  'channels:read',
  'chat:write',
  'commands',
  'im:history',
  'im:read',
  'im:write',
  'users:read',
  'users:read.email',
];

/**
 * Create a Bolt app with dual-mode auth, an optional error handler, and an
 * optional set of handler modules.
 *
 * @param {Object} [options]
 * @param {string} [options.botToken] - Single-token mode (default: SLACK_BOT_TOKEN env)
 * @param {string} [options.signingSecret] - Required (default: SLACK_SIGNING_SECRET env)
 * @param {string} [options.endpoints] - Events path on the receiver (default '/events')
 * @param {Object} [options.logger] - pino-like logger
 * @param {string} [options.clientId] - OAuth mode (default: SLACK_CLIENT_ID env)
 * @param {string} [options.clientSecret] - (default: SLACK_CLIENT_SECRET env)
 * @param {string} [options.stateSecret] - Required in OAuth mode (default: SLACK_STATE_SECRET env)
 * @param {string[]} [options.scopes] - Required in OAuth mode; must match your app manifest
 * @param {Object} [options.installationStore] - Required in OAuth mode; e.g. createInstallationStore({pool})
 * @param {boolean} [options.directInstall] - Skip the "Add to Slack" page (default true)
 * @param {Object} [options.receiverOptions] - Merged last into ExpressReceiver options
 * @param {Object} [options.appOptions] - Merged last into App options
 * @param {{wrap: Function, globalHandler: Function}} [options.errorHandler] - From createErrorHandler
 * @param {Array<{name: string, register: Function}>} [options.modules] - Handler
 *   modules; auto-registered and finalized when provided
 * @param {Object} [options.deps] - Dependencies passed to each module's register()
 * @returns {{ app: Object, receiver: Object, registrar: Object, mode: 'oauth'|'single-token' }}
 */
function createSlackApp({
  botToken = process.env.SLACK_BOT_TOKEN,
  signingSecret = process.env.SLACK_SIGNING_SECRET,
  endpoints = '/events',
  logger: rawLogger,
  clientId = process.env.SLACK_CLIENT_ID,
  clientSecret = process.env.SLACK_CLIENT_SECRET,
  stateSecret = process.env.SLACK_STATE_SECRET,
  scopes,
  installationStore,
  directInstall = true,
  receiverOptions: extraReceiverOptions = {},
  appOptions: extraAppOptions = {},
  errorHandler,
  modules,
  deps = {},
} = {}) {
  const logger = normalizeLogger(rawLogger);
  const useOAuth = !botToken && !!clientId;

  if (!signingSecret) {
    throw new Error('createSlackApp requires signingSecret (or SLACK_SIGNING_SECRET)');
  }
  if (!botToken && !clientId) {
    throw new Error('createSlackApp requires botToken (single-token mode) or clientId (OAuth mode)');
  }
  if (useOAuth) {
    if (!clientSecret) throw new Error('OAuth mode requires clientSecret');
    if (!stateSecret) throw new Error('OAuth mode requires stateSecret');
    if (!scopes || scopes.length === 0) {
      throw new Error('OAuth mode requires scopes matching your app manifest (see DEFAULT_SCOPES for a starting point)');
    }
    if (!installationStore) throw new Error('OAuth mode requires an installationStore (see createInstallationStore)');
  }

  logger.info({
    mode: useOAuth ? 'oauth' : 'single-token',
    hasClientId: !!clientId,
    hasBotToken: !!botToken,
  }, 'Initializing Slack app');

  const receiverOptions = {
    signingSecret,
    endpoints,
  };

  if (useOAuth) {
    receiverOptions.clientId = clientId;
    receiverOptions.clientSecret = clientSecret;
    receiverOptions.stateSecret = stateSecret;
    receiverOptions.scopes = scopes;
    receiverOptions.installationStore = installationStore;
    receiverOptions.installerOptions = {
      directInstall, // Skip the "Add to Slack" page
    };

    logger.info('OAuth mode enabled - install at <mount-path>/install');
  }

  const receiver = new ExpressReceiver({ ...receiverOptions, ...extraReceiverOptions });

  const appConfig = { receiver };

  if (useOAuth) {
    // OAuth mode - Bolt fetches tokens from the installationStore.
    // installerOptions intentionally set on BOTH receiver and App.
    appConfig.installerOptions = {
      directInstall,
    };
  } else {
    // Single-token mode - use static token
    appConfig.token = botToken;
  }

  const app = new App({ ...appConfig, ...extraAppOptions });

  if (errorHandler?.globalHandler) {
    app.error(errorHandler.globalHandler);
  }

  const registrar = createRegistrar(app, { logger, deps, errorHandler });

  if (Array.isArray(modules) && modules.length > 0) {
    for (const module of modules) {
      registrar.use(module);
    }
    registrar.finalize();
  }

  return {
    app,
    receiver,
    registrar,
    mode: useOAuth ? 'oauth' : 'single-token',
  };
}

module.exports = { createSlackApp, DEFAULT_SCOPES };
