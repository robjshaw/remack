import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UserError, runBoundaryChain } from '../lib/errors.js';
import { fakeLogger } from './fakes.js';

const baseArgs = { kind: 'command', id: '/x', userId: 'U1', teamId: 'T1' };

test('route ErrorBoundary wins and receives the error in args', async () => {
  let seen;
  const result = await runBoundaryChain({
    error: new Error('boom'),
    args: baseArgs,
    routeModule: {
      ErrorBoundary: async (args) => { seen = args.error; return { text: 'route boundary' }; },
    },
    phase: 'ack',
    logger: fakeLogger(),
  });

  assert.equal(seen.message, 'boom');
  assert.deepEqual(result, { text: 'route boundary' });
});

test('throwing route boundary falls through to onError', async () => {
  const logger = fakeLogger();
  const result = await runBoundaryChain({
    error: new Error('boom'),
    args: baseArgs,
    routeModule: { ErrorBoundary: () => { throw new Error('boundary bug'); } },
    onError: () => ({ text: 'app boundary' }),
    phase: 'ack',
    logger,
  });

  assert.deepEqual(result, { text: 'app boundary' });
  assert.ok(logger.entries.some((e) => e.level === 'error' && /ErrorBoundary threw/.test(e.msg)));
});

test('default boundary: command ack phase returns ephemeral message', async () => {
  const logger = fakeLogger();
  const result = await runBoundaryChain({
    error: new Error('db down'),
    args: baseArgs,
    phase: 'ack',
    genericMessage: 'Oops.',
    logger,
  });

  assert.deepEqual(result, { response_type: 'ephemeral', text: 'Oops.' });
  assert.ok(logger.entries.some((e) => e.level === 'error'));
});

test('UserError message reaches the user and skips ops alert', async () => {
  const alerts = [];
  const result = await runBoundaryChain({
    error: new UserError('Pick a client first.'),
    args: baseArgs,
    opsAlert: async (title) => alerts.push(title),
    phase: 'ack',
    logger: fakeLogger(),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(result, { response_type: 'ephemeral', text: 'Pick a client first.' });
  assert.equal(alerts.length, 0, 'user errors must not fire ops alerts');
});

test('unexpected errors fire ops alert with context', async () => {
  const alerts = [];
  await runBoundaryChain({
    error: new Error('kaboom'),
    args: { ...baseArgs, kind: 'action', id: 'btn' },
    opsAlert: async (title, opts) => alerts.push({ title, opts }),
    phase: 'deferred',
    logger: fakeLogger(),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /action btn/);
  assert.equal(alerts[0].opts.context.userId, 'U1');
});

test('non-command errors notify via client.chat.postEphemeral', async () => {
  const ephemerals = [];
  const client = { chat: { postEphemeral: async (p) => ephemerals.push(p) } };

  const result = await runBoundaryChain({
    error: new Error('x'),
    args: { kind: 'action', id: 'btn', userId: 'U1', channelId: 'C1', client },
    phase: 'ack',
    genericMessage: 'Generic.',
    logger: fakeLogger(),
  });

  assert.equal(result, undefined, 'ack stays empty');
  assert.deepEqual(ephemerals, [{ channel: 'C1', user: 'U1', text: 'Generic.' }]);
});

test('notify failures are swallowed', async () => {
  const client = { chat: { postEphemeral: async () => { throw new Error('notify failed'); } } };
  const result = await runBoundaryChain({
    error: new Error('x'),
    args: { kind: 'action', id: 'btn', userId: 'U1', channelId: 'C1', client },
    phase: 'deferred',
    logger: fakeLogger(),
  });
  assert.equal(result, undefined);
});

test('onError returning undefined falls through to default', async () => {
  let called = false;
  const result = await runBoundaryChain({
    error: new Error('x'),
    args: baseArgs,
    onError: () => { called = true; },
    phase: 'ack',
    genericMessage: 'Fell through.',
    logger: fakeLogger(),
  });

  assert.equal(called, true);
  assert.deepEqual(result, { response_type: 'ephemeral', text: 'Fell through.' });
});
