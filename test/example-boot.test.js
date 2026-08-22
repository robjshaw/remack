'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSlackApp, createErrorHandler } = require('../lib');
const { fakeLogger } = require('./fakes');

// Smoke check mirroring examples/minimal-bot/app.js: constructing the app
// with the example's module shape must not throw or hit the network.
test('example bot module shape boots', () => {
  const errorHandler = createErrorHandler({ logger: fakeLogger() });

  const { app, registrar, mode } = createSlackApp({
    botToken: 'xoxb-test',
    signingSecret: 'secret',
    appOptions: { botId: 'B_TEST', botUserId: 'UB_TEST' },
    logger: fakeLogger(),
    errorHandler,
    modules: [{
      name: 'ping',
      register(r) {
        r.command('/ping', async ({ ack }) => { await ack('pong'); });
        r.command('/boom', async () => { throw new Error('x'); });
        r.action('demo_button', async ({ ack }) => { await ack(); });
        r.event('app_home_opened', async () => {});
      },
    }],
  });

  assert.ok(app);
  assert.equal(mode, 'single-token');
  assert.ok(registrar.registered.command.ids.has('/ping'));
  assert.ok(registrar.registered.command.ids.has('/boom'));
  assert.ok(registrar.registered.action.ids.has('demo_button'));
  assert.ok(registrar.registered.event.ids.has('app_home_opened'));
});
