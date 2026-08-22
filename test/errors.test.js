'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createErrorHandler, SlackUserError } = require('../lib/errors');
const { fakeLogger } = require('./fakes');

test('wrap acks first and notifies user with generic message on unexpected error', async () => {
  const logger = fakeLogger();
  const order = [];
  const { wrap } = createErrorHandler({ logger, genericMessage: 'Oops.' });

  const handler = wrap(async () => { throw new Error('db down'); }, { module: 'm', kind: 'action', id: 'x' });

  let respondPayload;
  await handler({
    ack: async () => order.push('ack'),
    respond: async (payload) => { order.push('respond'); respondPayload = payload; },
    body: { user: { id: 'U1' }, team: { id: 'T1' } },
  });

  assert.deepEqual(order, ['ack', 'respond']);
  assert.equal(respondPayload.text, 'Oops.');
  assert.equal(respondPayload.response_type, 'ephemeral');
  const logged = logger.entries.find((e) => e.level === 'error');
  assert.equal(logged.objOrMsg.userId, 'U1');
  assert.equal(logged.objOrMsg.module, 'm');
});

test('SlackUserError message reaches the user and skips ops alert', async () => {
  const alerts = [];
  const { wrap } = createErrorHandler({
    logger: fakeLogger(),
    opsAlert: async (title) => alerts.push(title),
  });

  const handler = wrap(async () => { throw new SlackUserError('Pick a client first.'); });

  let respondPayload;
  await handler({
    ack: async () => {},
    respond: async (payload) => { respondPayload = payload; },
    body: {},
  });

  assert.equal(respondPayload.text, 'Pick a client first.');
  assert.equal(alerts.length, 0, 'user errors must not fire ops alerts');
});

test('unexpected errors fire ops alert with context', async () => {
  const alerts = [];
  const { wrap } = createErrorHandler({
    logger: fakeLogger(),
    notifyUser: false,
    opsAlert: async (title, opts) => alerts.push({ title, opts }),
  });

  const handler = wrap(async () => { throw new Error('kaboom'); }, { kind: 'command', id: '/wip' });
  await handler({ ack: async () => {}, body: { user: { id: 'U9' } } });

  // opsAlert is fire-and-forget; give the microtask queue a beat
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /command \/wip/);
  assert.equal(alerts[0].opts.context.userId, 'U9');
});

test('falls back to postEphemeral when respond is unavailable', async () => {
  const ephemerals = [];
  const { wrap } = createErrorHandler({ logger: fakeLogger() });

  const handler = wrap(async () => { throw new Error('x'); });
  await handler({
    ack: async () => {},
    client: { chat: { postEphemeral: async (payload) => ephemerals.push(payload) } },
    body: { user: { id: 'U2' }, channel: { id: 'C2' } },
  });

  assert.equal(ephemerals.length, 1);
  assert.equal(ephemerals[0].user, 'U2');
  assert.equal(ephemerals[0].channel, 'C2');
});

test('notify failures are swallowed', async () => {
  const { wrap } = createErrorHandler({ logger: fakeLogger() });
  const handler = wrap(async () => { throw new Error('x'); });

  // respond throws — wrap must not propagate
  await handler({
    ack: async () => {},
    respond: async () => { throw new Error('respond failed'); },
    body: {},
  });
});

test('onError hook is called and its own throws are contained', async () => {
  const seen = [];
  const { wrap } = createErrorHandler({
    logger: fakeLogger(),
    notifyUser: false,
    onError: (error, context) => { seen.push({ error, context }); throw new Error('hook bug'); },
  });

  await wrap(async () => { throw new Error('original'); }, { id: 'z' })({ ack: async () => {}, body: {} });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].error.message, 'original');
});

test('globalHandler logs and alerts', async () => {
  const logger = fakeLogger();
  const alerts = [];
  const { globalHandler } = createErrorHandler({ logger, opsAlert: async (title) => alerts.push(title) });

  await globalHandler(new Error('receiver blew up'));
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(logger.entries.some((e) => e.level === 'error'));
  assert.equal(alerts.length, 1);
});
