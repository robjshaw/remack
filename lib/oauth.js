/**
 * Slack OAuth v2 install flow.
 *
 * Two endpoints, mounted by createApp in oauth mode:
 *   GET {paths.install}  → 302 to Slack's authorize URL with a signed state
 *   GET {paths.redirect} → verify state (+ cookie echo), exchange the code
 *                          via oauth.v2.access (form-encoded), store the
 *                          installation, show a success page
 *
 * State is HMAC-signed with stateSecret and expires after 10 minutes; it is
 * also echoed in a slack_oauth_state cookie and compared on callback (CSRF).
 */

import { createClient } from './client.js';
import { normalizeLogger } from './logger.js';

const AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const STATE_TTL_MS = 10 * 60 * 1000;
const COOKIE_NAME = 'slack_oauth_state';

const encoder = new TextEncoder();

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(text));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64url(text) {
  return Buffer.from(text).toString('base64url');
}

function fromBase64url(text) {
  return Buffer.from(text, 'base64url').toString();
}

export async function createState(stateSecret, now = Date.now()) {
  const body = base64url(JSON.stringify({ ts: now, nonce: crypto.randomUUID() }));
  const signature = await hmacHex(stateSecret, body);
  return `${body}.${signature}`;
}

export async function verifyState(stateSecret, state, now = Date.now()) {
  if (typeof state !== 'string' || !state.includes('.')) return false;
  const [body, signature] = state.split('.');

  const expected = await hmacHex(stateSecret, body);
  if (signature !== expected) return false;

  try {
    const { ts } = JSON.parse(fromBase64url(body));
    return Number.isFinite(ts) && now - ts >= 0 && now - ts <= STATE_TTL_MS;
  } catch {
    return false;
  }
}

function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function htmlPage(title, body, status = 200) {
  return new Response(
    `<!doctype html><html><head><title>${title}</title></head><body style="font-family:sans-serif;max-width:32rem;margin:4rem auto"><h1>${title}</h1><p>${body}</p></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

/** Map an oauth.v2.access response onto the installation-store shape. */
export function toInstallation(data) {
  return {
    team: data.team ? { id: data.team.id, name: data.team.name } : null,
    enterprise: data.enterprise ? { id: data.enterprise.id, name: data.enterprise.name } : null,
    isEnterpriseInstall: !!data.is_enterprise_install,
    appId: data.app_id || null,
    bot: {
      token: data.access_token,
      userId: data.bot_user_id || null,
      id: null,
      scopes: data.scope ? data.scope.split(',') : [],
    },
    user: data.authed_user
      ? {
        id: data.authed_user.id,
        token: data.authed_user.access_token || null,
        scopes: data.authed_user.scope ? data.authed_user.scope.split(',') : [],
      }
      : null,
  };
}

/**
 * Build the install/callback handlers.
 *
 * @param {Object} options
 * @param {string} options.clientId
 * @param {string} options.clientSecret
 * @param {string} options.stateSecret
 * @param {string[]} options.scopes - Bot scopes; MUST match your app manifest
 * @param {string[]} [options.userScopes]
 * @param {{get, set, delete}} options.store - Installation store
 * @param {string} [options.redirectUri] - Explicit redirect_uri if your app
 *   configures one on api.slack.com
 * @param {Function} [options.fetch] - fetch implementation (tests)
 * @param {Object} [options.logger]
 */
export function createOAuthRoutes({
  clientId,
  clientSecret,
  stateSecret,
  scopes = [],
  userScopes = [],
  store,
  redirectUri,
  fetch = globalThis.fetch,
  logger: rawLogger,
}) {
  const logger = normalizeLogger(rawLogger);
  const exchangeClient = createClient({ fetch, logger });

  async function install() {
    const state = await createState(stateSecret);

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('scope', scopes.join(','));
    if (userScopes.length) url.searchParams.set('user_scope', userScopes.join(','));
    url.searchParams.set('state', state);
    if (redirectUri) url.searchParams.set('redirect_uri', redirectUri);

    return new Response(null, {
      status: 302,
      headers: {
        location: url.toString(),
        'set-cookie': `${COOKIE_NAME}=${state}; Max-Age=600; HttpOnly; Secure; Path=/; SameSite=Lax`,
      },
    });
  }

  async function callback(request) {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');

    if (oauthError) {
      logger.warn({ oauthError }, 'Slack OAuth was denied');
      return htmlPage('Installation cancelled', `Slack reported: ${oauthError}`, 400);
    }

    if (!code || !state) {
      return htmlPage('Invalid request', 'Missing code or state parameter.', 400);
    }

    const cookieState = getCookie(request, COOKIE_NAME);
    if (cookieState !== state || !(await verifyState(stateSecret, state))) {
      logger.warn('OAuth state verification failed');
      return htmlPage('Invalid state', 'The install link expired or was tampered with. Start over from /install.', 400);
    }

    try {
      const data = await exchangeClient.call('oauth.v2.access', {
        code,
        client_id: clientId,
        client_secret: clientSecret,
        ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      });

      const installation = toInstallation(data);
      await store.set(installation);

      logger.info({ teamId: installation.team?.id, enterpriseId: installation.enterprise?.id }, 'Installation stored');
      return htmlPage('App installed', 'You can close this tab and head back to Slack.');
    } catch (error) {
      logger.error({ err: error }, 'OAuth code exchange failed');
      return htmlPage('Installation failed', 'The code exchange with Slack failed. Check the app logs.', 500);
    }
  }

  return { install, callback };
}
