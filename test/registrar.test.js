'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRegistrar } = require('../lib/registrar');
const { createErrorHandler } = require('../lib/errors');
const { fakeBoltApp, fakeLogger } = require('./fakes');

function pingModule(calls) {
  return {
    name: 'ping',
    register(r, deps) {
      calls.deps = deps;
      r.command('/ping', async ({ ack }) => { calls.command = true; await ack(); });
      r.action('ping_button', async ({ ack }) => { calls.action = true; await ack(); });
      r.action(/^overflow_/, async ({ ack }) => { calls.patternAction = true; await ack(); });
      r.view('ping_modal', async ({ ack }) => { calls.view = true; await ack(); });
    },
  };
}

test('use() registers handlers on the app and records ids', async () => {
  const { app, dispatch } = fakeBoltApp();
  const calls = {};
  const registrar = createRegistrar(app, { logger: fakeLogger(), deps: { db: 'fake' } });

  registrar.use(pingModule(calls));

  assert.deepEqual(calls.deps, { db: 'fake' });
  assert.ok(registrar.registered.command.ids.has('/ping'));
  assert.ok(registrar.registered.action.ids.has('ping_button'));
  assert.equal(registrar.registered.action.patterns.length, 1);
  assert.ok(registrar.registered.view.ids.has('ping_modal'));

  await dispatch('command', '/ping', { ack: async () => {}, body: {} });
  assert.equal(calls.command, true);
});

test('duplicate string-id registration logs a warning', () => {
  const { app } = fakeBoltApp();
  const logger = fakeLogger();
  const registrar = createRegistrar(app, { logger });

  registrar.use({ name: 'a', register: (r) => r.action('dup', async () => {}) });
  registrar.use({ name: 'b', register: (r) => r.action('dup', async () => {}) });

  const warning = logger.entries.find((e) => e.level === 'warn');
  assert.ok(warning, 'expected a duplicate-registration warning');
  assert.equal(warning.objOrMsg.id, 'dup');
});

test('finalize() catch-all acks unknown actions but defers known ones', async () => {
  const { app, dispatch } = fakeBoltApp();
  const calls = {};
  const registrar = createRegistrar(app, { logger: fakeLogger() });

  registrar.use(pingModule(calls));
  registrar.finalize();

  // Unknown action → fallback acks it
  let acked = 0;
  await dispatch('action', 'mystery_button', {
    ack: async () => { acked += 1; },
    body: { type: 'block_actions', actions: [{ action_id: 'mystery_button' }] },
  });
  assert.equal(acked, 1);

  // Known string id → dedicated handler acks; fallback defers via next()
  acked = 0;
  calls.action = false;
  await dispatch('action', 'ping_button', {
    ack: async () => { acked += 1; },
    body: { type: 'block_actions', actions: [{ action_id: 'ping_button' }] },
  });
  assert.equal(calls.action, true);
  assert.equal(acked, 1);

  // Known pattern id → dedicated handler acks; fallback defers
  calls.patternAction = false;
  acked = 0;
  await dispatch('action', 'overflow_menu_1', {
    ack: async () => { acked += 1; },
    body: { type: 'block_actions', actions: [{ action_id: 'overflow_menu_1' }] },
  });
  assert.equal(calls.patternAction, true);
  assert.equal(acked, 1);
});

test('finalize() catch-all acks unknown views but defers known ones', async () => {
  const { app, dispatch } = fakeBoltApp();
  const calls = {};
  const registrar = createRegistrar(app, { logger: fakeLogger() });

  registrar.use(pingModule(calls));
  registrar.finalize();

  let acked = 0;
  await dispatch('view', 'unknown_modal', {
    ack: async () => { acked += 1; },
    body: {},
    view: { callback_id: 'unknown_modal' },
  });
  assert.equal(acked, 1);

  acked = 0;
  await dispatch('view', 'ping_modal', {
    ack: async () => { acked += 1; },
    body: {},
    view: { callback_id: 'ping_modal' },
  });
  assert.equal(calls.view, true);
  assert.equal(acked, 1);
});

test('finalize() event catch-all acks when ack exists, tolerates when absent', async () => {
  const { app, dispatch } = fakeBoltApp();
  const registrar = createRegistrar(app, { logger: fakeLogger() });
  registrar.finalize();

  let acked = 0;
  await dispatch('event', 'reaction_added', { ack: async () => { acked += 1; }, event: { type: 'reaction_added' } });
  assert.equal(acked, 1);

  // No ack function (e.g. app_home_opened) — must not throw
  await dispatch('event', 'app_home_opened', { event: { type: 'app_home_opened' } });
});

test('registering after finalize() throws', () => {
  const { app } = fakeBoltApp();
  const registrar = createRegistrar(app, { logger: fakeLogger() });
  registrar.finalize();

  assert.throws(
    () => registrar.use({ name: 'late', register: (r) => r.action('late', async () => {}) }),
    /after finalize/
  );
});

test('handlers are wrapped by the error handler when provided', async () => {
  const { app, dispatch } = fakeBoltApp();
  const logger = fakeLogger();
  const errorHandler = createErrorHandler({ logger, notifyUser: false });
  const registrar = createRegistrar(app, { logger: fakeLogger(), errorHandler });

  registrar.use({
    name: 'boom',
    register: (r) => r.action('boom', async () => { throw new Error('kaboom'); }),
  });

  let acked = 0;
  // Must not throw; error handler acks and logs
  await dispatch('action', 'boom', {
    ack: async () => { acked += 1; },
    body: { user: { id: 'U1' }, actions: [{ action_id: 'boom' }] },
  });
  assert.equal(acked, 1);
  const logged = logger.entries.find((e) => e.level === 'error');
  assert.ok(logged, 'expected the error to be logged');
  assert.equal(logged.objOrMsg.module, 'boom');
});
