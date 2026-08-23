import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOAuthRoutes, createState, verifyState, toInstallation } from '../lib/oauth.js';
import { fakeFetch, fakeLogger } from './fakes.js';

const OAUTH_OPTS = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  stateSecret: 'state-secret',
  scopes: ['chat:write', 'commands'],
};

const ACCESS_RESPONSE = {
  ok: true,
  app_id: 'A777',
  authed_user: { id: 'U333' },
  scope: 'chat:write,commands',
  token_type: 'bot',
  access_token: 'xoxb-new',
  bot_user_id: 'UBOT',
  team: { id: 'T111', name: 'Acme' },
  enterprise: null,
  is_enterprise_install: false,
};

test('state roundtrip: valid within window, expired after, tamper-proof', async () => {
  const state = await createState('secret', 1000);
  assert.equal(await verifyState('secret', state, 1000 + 60_000), true);
  assert.equal(await verifyState('secret', state, 1000 + 11 * 60_000), false, 'expired');
  assert.equal(await verifyState('other-secret', state, 1000), false, 'wrong secret');
  assert.equal(await verifyState('secret', state.slice(0, -2) + 'ff', 1000), false, 'tampered');
  assert.equal(await verifyState('secret', 'garbage', 1000), false);
});

test('install redirects to authorize URL with state cookie', async () => {
  const { install } = createOAuthRoutes({ ...OAUTH_OPTS, store: {}, fetch: fakeFetch(), logger: fakeLogger() });

  const response = await install(new Request('https://bot.test/install'));
  assert.equal(response.status, 302);

  const location = new URL(response.headers.get('location'));
  assert.equal(location.origin + location.pathname, 'https://slack.com/oauth/v2/authorize');
  assert.equal(location.searchParams.get('client_id'), 'client-id');
  assert.equal(location.searchParams.get('scope'), 'chat:write,commands');

  const state = location.searchParams.get('state');
  assert.ok(await verifyState('state-secret', state));
  assert.match(response.headers.get('set-cookie'), new RegExp(`slack_oauth_state=${state.replaceAll('$', '\\$')}`));
});

test('callback exchanges the code form-encoded and stores the installation', async () => {
  const stored = [];
  const fetch = fakeFetch([ACCESS_RESPONSE]);
  const { callback } = createOAuthRoutes({
    ...OAUTH_OPTS,
    store: { set: async (installation) => stored.push(installation) },
    fetch,
    logger: fakeLogger(),
  });

  const state = await createState('state-secret');
  const response = await callback(new Request(`https://bot.test/oauth_redirect?code=c0de&state=${encodeURIComponent(state)}`, {
    headers: { cookie: `slack_oauth_state=${state}` },
  }));

  assert.equal(response.status, 200);
  assert.match(await response.text(), /App installed/);

  const [exchange] = fetch.calls;
  assert.equal(exchange.url, 'https://slack.com/api/oauth.v2.access');
  assert.match(exchange.init.headers['content-type'], /urlencoded/, 'oauth exchange must be form-encoded');
  const form = new URLSearchParams(exchange.body);
  assert.equal(form.get('code'), 'c0de');
  assert.equal(form.get('client_id'), 'client-id');
  assert.equal(form.get('client_secret'), 'client-secret');

  assert.equal(stored.length, 1);
  assert.equal(stored[0].team.id, 'T111');
  assert.equal(stored[0].bot.token, 'xoxb-new');
  assert.deepEqual(stored[0].bot.scopes, ['chat:write', 'commands']);
});

test('callback rejects cookie mismatch and bad state', async () => {
  const { callback } = createOAuthRoutes({ ...OAUTH_OPTS, store: {}, fetch: fakeFetch(), logger: fakeLogger() });

  const state = await createState('state-secret');
  const otherState = await createState('state-secret');

  const mismatch = await callback(new Request(`https://x/cb?code=c&state=${encodeURIComponent(state)}`, {
    headers: { cookie: `slack_oauth_state=${otherState}` },
  }));
  assert.equal(mismatch.status, 400);

  const missing = await callback(new Request('https://x/cb?code=c'));
  assert.equal(missing.status, 400);

  const denied = await callback(new Request('https://x/cb?error=access_denied'));
  assert.equal(denied.status, 400);
  assert.match(await denied.text(), /access_denied/);
});

test('callback surfaces exchange failures as 500', async () => {
  const fetch = fakeFetch([{ ok: false, error: 'invalid_code' }]);
  const { callback } = createOAuthRoutes({ ...OAUTH_OPTS, store: { set: async () => {} }, fetch, logger: fakeLogger() });

  const state = await createState('state-secret');
  const response = await callback(new Request(`https://x/cb?code=bad&state=${encodeURIComponent(state)}`, {
    headers: { cookie: `slack_oauth_state=${state}` },
  }));
  assert.equal(response.status, 500);
});

test('toInstallation maps enterprise and user-token variants', () => {
  const enterprise = toInstallation({
    ...ACCESS_RESPONSE,
    enterprise: { id: 'E1', name: 'Big Org' },
    is_enterprise_install: true,
    authed_user: { id: 'U333', access_token: 'xoxp-user', scope: 'search:read' },
  });

  assert.deepEqual(enterprise.enterprise, { id: 'E1', name: 'Big Org' });
  assert.equal(enterprise.isEnterpriseInstall, true);
  assert.equal(enterprise.user.token, 'xoxp-user');
  assert.deepEqual(enterprise.user.scopes, ['search:read']);
});
