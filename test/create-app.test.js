'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSlackApp, DEFAULT_SCOPES } = require('../lib/create-app');
const { createErrorHandler } = require('../lib/errors');
const { fakeLogger } = require('./fakes');

const FAKE_TOKEN = 'xoxb-test-token';
const FAKE_SECRET = 'test-signing-secret';
// Bolt's App fires a background auth.test to resolve the bot ID unless one is
// supplied; provide it so tests never hit the network.
const OFFLINE_APP_OPTIONS = { botId: 'B_TEST', botUserId: 'UB_TEST' };

test('single-token mode boots with token + signing secret', () => {
  const { app, receiver, registrar, mode } = createSlackApp({
    botToken: FAKE_TOKEN,
    signingSecret: FAKE_SECRET,
    appOptions: OFFLINE_APP_OPTIONS,
    logger: fakeLogger(),
  });

  assert.equal(mode, 'single-token');
  assert.ok(app);
  assert.ok(receiver.router, 'receiver exposes an Express router for mounting');
  assert.ok(registrar.use);
});

test('missing signing secret throws', () => {
  assert.throws(
    () => createSlackApp({ botToken: FAKE_TOKEN, signingSecret: undefined, logger: fakeLogger() }),
    /signingSecret/
  );
});

test('no token and no clientId throws', () => {
  assert.throws(
    () => createSlackApp({ botToken: undefined, clientId: undefined, signingSecret: FAKE_SECRET, logger: fakeLogger() }),
    /botToken.*clientId/
  );
});

test('OAuth mode validates its required options', () => {
  const base = {
    botToken: undefined,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    stateSecret: 'state-secret',
    signingSecret: FAKE_SECRET,
    scopes: DEFAULT_SCOPES,
    installationStore: { storeInstallation: async () => {}, fetchInstallation: async () => {}, deleteInstallation: async () => {} },
    logger: fakeLogger(),
  };

  assert.equal(createSlackApp(base).mode, 'oauth');
  assert.throws(() => createSlackApp({ ...base, clientSecret: undefined }), /clientSecret/);
  assert.throws(() => createSlackApp({ ...base, stateSecret: undefined }), /stateSecret/);
  assert.throws(() => createSlackApp({ ...base, scopes: [] }), /scopes/);
  assert.throws(() => createSlackApp({ ...base, installationStore: undefined }), /installationStore/);
});

test('modules are registered and finalized automatically', () => {
  let registered = false;
  const { registrar } = createSlackApp({
    botToken: FAKE_TOKEN,
    signingSecret: FAKE_SECRET,
    appOptions: OFFLINE_APP_OPTIONS,
    logger: fakeLogger(),
    errorHandler: createErrorHandler({ logger: fakeLogger() }),
    modules: [{
      name: 'ping',
      register(r) {
        registered = true;
        r.command('/ping', async ({ ack }) => { await ack('pong'); });
      },
    }],
  });

  assert.equal(registered, true);
  assert.ok(registrar.registered.command.ids.has('/ping'));
  assert.throws(
    () => registrar.use({ name: 'late', register: (r) => r.action('x', async () => {}) }),
    /after finalize/
  );
});
