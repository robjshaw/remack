import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../lib/app.js';
import { route } from '../lib/router.js';
import { memoryStorage } from '../lib/storage.js';
import { childLogger } from '../lib/logger.js';
import { installationsFrom } from '../lib/installations.js';
import {
  fakeLogger,
  signedRequest,
  interactivityBody,
  TEST_SIGNING_SECRET,
} from './fakes.js';
import * as payloads from './fixtures/payloads.js';

function makeApp({ routes = [], ...overrides } = {}) {
  return createApp({
    signingSecret: TEST_SIGNING_SECRET,
    botToken: 'xoxb-test',
    routes,
    logger: fakeLogger(),
    ...overrides,
  });
}

const OAUTH = {
  clientId: 'id', clientSecret: 'secret', stateSecret: 'state', scopes: ['chat:write'],
};

// ── waitUntil ────────────────────────────────────────────────────────────────

test('waitUntil on a fetch platform arg (Workers ctx) receives event and defer work', async () => {
  const waited = [];
  const ctx = { waitUntil(promise) { waited.push(promise); } };
  let deferRan = false;

  const app = makeApp({
    routes: [
      route('event', 'app_mention', { default: async () => {} }),
      route('command', '/report', {
        default: async ({ defer }) => { defer(async () => { deferRan = true; }); },
      }),
    ],
  });

  // Workers calls fetch(request, env, ctx): env first, waitUntil on the third arg
  await app.fetch(signedRequest({ body: payloads.eventCallback }), { SOME_BINDING: 1 }, ctx);
  assert.equal(waited.length, 1, 'event continuation handed to waitUntil');

  await app.fetch(signedRequest({ body: payloads.slashCommandForm }), {}, ctx);
  assert.equal(waited.length, 2, 'defer() continuation handed to waitUntil');

  await Promise.all(waited);
  assert.equal(deferRan, true);
});

test('createApp({ waitUntil }) is used when the platform arg has none; per-request wins', async () => {
  const global = [];
  const perRequest = [];
  const app = makeApp({
    waitUntil: (promise) => global.push(promise),
    routes: [route('event', 'app_mention', { default: async () => {} })],
  });

  await app.fetch(signedRequest({ body: payloads.eventCallback }));
  assert.equal(global.length, 1);

  await app.fetch(signedRequest({ body: payloads.eventCallback }), { waitUntil: (p) => perRequest.push(p) });
  assert.equal(global.length, 1);
  assert.equal(perRequest.length, 1);
  await app.idle();
});

test('without waitUntil anywhere, post-ack work still runs in-process (idle)', async () => {
  let ran = false;
  const app = makeApp({
    routes: [route('event', 'app_mention', { default: async () => { ran = true; } })],
  });
  await app.fetch(signedRequest({ body: payloads.eventCallback }));
  await app.idle();
  assert.equal(ran, true);
});

// ── App isolation ────────────────────────────────────────────────────────────

test('namespace scopes storage so two apps can share one store', async () => {
  const shared = memoryStorage();
  const sales = createApp({ signingSecret: 's', oauth: OAUTH, storage: shared, namespace: 'sales', logger: fakeLogger() });
  const support = createApp({ signingSecret: 's', oauth: OAUTH, storage: shared, namespace: 'support', logger: fakeLogger() });

  await installationsFrom(sales.storage).set({ team: { id: 'T1' }, bot: { token: 'xoxb-sales' } });
  await installationsFrom(support.storage).set({ team: { id: 'T1' }, bot: { token: 'xoxb-support' } });

  assert.equal((await installationsFrom(sales.storage).get({ teamId: 'T1' })).bot.token, 'xoxb-sales');
  assert.equal((await installationsFrom(support.storage).get({ teamId: 'T1' })).bot.token, 'xoxb-support');
  assert.equal((await shared.get('sales:installations', 'T:T1')).bot.token, 'xoxb-sales');
  assert.equal(await shared.get('installations', 'T:T1'), null, 'nothing written unscoped');
});

test('namespace is validated and tags every log line with app', async () => {
  assert.throws(() => makeApp({ namespace: 'has space' }), /namespace/);

  const logger = fakeLogger();
  const app = makeApp({ namespace: 'sales', logger, routes: [route('command', '/report', { default: () => 'ok' })] });
  await app.fetch(signedRequest({ body: payloads.slashCommandForm }));
  const summary = logger.entries.find((e) => e.msg === 'Slack request handled');
  assert.equal(summary.objOrMsg.app, 'sales');
});

test('env option supplies defaults instead of process.env', async () => {
  const app = createApp({
    env: { SLACK_SIGNING_SECRET: TEST_SIGNING_SECRET, SLACK_BOT_TOKEN: 'xoxb-from-env' },
    routes: [route('command', '/report', { default: ({ client }) => client.token })],
    logger: fakeLogger(),
  });
  assert.equal(app.client.token, 'xoxb-from-env');
  const response = await app.fetch(signedRequest({ body: payloads.slashCommandForm }));
  assert.equal((await response.json()).text, 'xoxb-from-env');

  assert.throws(() => createApp({ env: {}, logger: fakeLogger() }), /signingSecret/);
});

test('explicit oauth config is not overridden by an ambient env bot token', () => {
  const app = createApp({
    env: { SLACK_SIGNING_SECRET: 's', SLACK_BOT_TOKEN: 'xoxb-someone-elses' },
    oauth: OAUTH,
    logger: fakeLogger(),
  });
  assert.equal(app.client, null, 'oauth mode: no single-token client');

  const explicit = createApp({ env: {}, signingSecret: 's', botToken: 'xoxb-explicit', oauth: OAUTH, logger: fakeLogger() });
  assert.equal(explicit.client.token, 'xoxb-explicit', 'an explicit botToken still selects single-token mode');
});

// ── Request-scoped logging ──────────────────────────────────────────────────

test('every request gets a requestId, args.log bindings, and a summary line with ackMs', async () => {
  const logger = fakeLogger();
  let seen;
  const app = makeApp({
    logger,
    routes: [route('command', '/report', {
      default: ({ requestId, log }) => { seen = requestId; log.info({ step: 1 }, 'inside handler'); },
    })],
  });

  await app.fetch(signedRequest({ body: payloads.slashCommandForm }));

  assert.match(seen, /^[0-9a-f-]{36}$/);
  const inside = logger.entries.find((e) => e.msg === 'inside handler');
  assert.equal(inside.objOrMsg.requestId, seen);
  assert.equal(inside.objOrMsg.kind, 'command');
  assert.equal(inside.objOrMsg.id, '/report');
  assert.equal(inside.objOrMsg.step, 1);

  const summary = logger.entries.find((e) => e.msg === 'Slack request handled');
  assert.equal(summary.level, 'info');
  assert.equal(summary.objOrMsg.requestId, seen);
  assert.equal(summary.objOrMsg.outcome, 'ok');
  assert.equal(summary.objOrMsg.status, 200);
  assert.equal(typeof summary.objOrMsg.ackMs, 'number');
});

test('an incoming x-request-id is reused as the requestId', async () => {
  const logger = fakeLogger();
  const app = makeApp({ logger });
  await app.fetch(signedRequest({ body: payloads.slashCommandForm, headers: { 'x-request-id': 'edge-123' } }));
  const summary = logger.entries.find((e) => e.msg === 'Slack request handled');
  assert.equal(summary.objOrMsg.requestId, 'edge-123');
});

test('summary outcome covers rejected and error paths; errors log with the requestId', async () => {
  const logger = fakeLogger();
  const app = makeApp({
    logger,
    routes: [route('command', '/report', { default: () => { throw new Error('boom'); } })],
  });

  await app.fetch(signedRequest({ body: payloads.slashCommandForm, signingSecret: 'wrong' }));
  await app.fetch(signedRequest({ body: payloads.slashCommandForm }));

  const outcomes = logger.entries.filter((e) => e.msg === 'Slack request handled').map((e) => e.objOrMsg.outcome);
  assert.deepEqual(outcomes, ['rejected', 'error']);

  const errorLine = logger.entries.find((e) => e.msg === 'Unhandled error in Slack route');
  assert.ok(errorLine.objOrMsg.requestId);
});

test('a crash outside the route boundary is logged with its requestId, then rethrown', async () => {
  const logger = fakeLogger();
  const app = createApp({
    signingSecret: TEST_SIGNING_SECRET,
    oauth: { ...OAUTH, store: { get: async () => { throw new Error('db down'); }, set: async () => {}, delete: async () => {} } },
    logger,
  });

  await assert.rejects(app.fetch(signedRequest({ body: interactivityBody(payloads.blockActions) })), /db down/);
  const line = logger.entries.find((e) => e.objOrMsg?.outcome === 'crashed');
  assert.equal(line.level, 'error');
  assert.ok(line.objOrMsg.requestId);
});

test('an oversized x-request-id is truncated', async () => {
  const logger = fakeLogger();
  const app = makeApp({ logger });
  await app.fetch(signedRequest({ body: payloads.slashCommandForm, headers: { 'x-request-id': 'x'.repeat(5000) } }));
  const summary = logger.entries.find((e) => e.msg === 'Slack request handled');
  assert.equal(summary.objOrMsg.requestId.length, 128);
});

test('slow acks log a warning with the 3s limit', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);

  const logger = fakeLogger();
  const app = makeApp({
    logger,
    routes: [route('command', '/report', { default: () => { now += 2500; } })],
  });
  await app.fetch(signedRequest({ body: payloads.slashCommandForm }));

  const warning = logger.entries.find((e) => /Slow Slack ack/.test(e.msg));
  assert.equal(warning.level, 'warn');
  assert.equal(warning.objOrMsg.ackMs, 2500);
  assert.equal(warning.objOrMsg.limitMs, 3000);
});

test('continuation completion logs once, with failure count', async () => {
  const logger = fakeLogger();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = makeApp({
    logger,
    routes: [route('command', '/report', {
      default: ({ defer }) => {
        defer(async () => { await gate; });
        defer(async () => { await gate; throw new Error('late'); });
      },
    })],
  });

  await app.fetch(signedRequest({ body: payloads.slashCommandForm }));
  assert.equal(logger.entries.filter((e) => e.msg === 'Slack continuation finished').length, 0);

  release();
  await app.idle();
  const done = logger.entries.filter((e) => e.msg === 'Slack continuation finished');
  assert.equal(done.length, 1);
  assert.equal(done[0].objOrMsg.continuations, 2);
  assert.equal(done[0].objOrMsg.failed, 1);
});

test('post-ack work logs completion exactly once; none without it', async () => {
  const logger = fakeLogger();
  const app = makeApp({
    logger,
    routes: [route('command', '/report', { default: ({ defer }) => { defer(() => {}); } })],
  });
  await app.fetch(signedRequest({ body: payloads.slashCommandForm }));
  await app.idle();

  const done = logger.entries.filter((e) => e.msg === 'Slack continuation finished');
  assert.equal(done.length, 1);
  assert.equal(done[0].objOrMsg.continuations, 1);

  // A request with no post-ack work logs no completion line
  const quiet = fakeLogger();
  const plain = makeApp({ logger: quiet, routes: [route('command', '/report', { default: () => 'ok' })] });
  await plain.fetch(signedRequest({ body: payloads.slashCommandForm }));
  await plain.idle();
  assert.equal(quiet.entries.filter((e) => e.msg === 'Slack continuation finished').length, 0);
});

test('childLogger merges bindings for loggers without child()', () => {
  const lines = [];
  const bare = {
    debug: () => {}, warn: () => {}, error: () => {},
    info: (obj, msg) => lines.push({ obj, msg }),
  };
  const log = childLogger(bare, { requestId: 'r1' });
  log.info({ a: 1 }, 'with obj');
  log.info('message only');
  log.child({ kind: 'command' }).info('nested');

  assert.deepEqual(lines, [
    { obj: { requestId: 'r1', a: 1 }, msg: 'with obj' },
    { obj: { requestId: 'r1' }, msg: 'message only' },
    { obj: { requestId: 'r1', kind: 'command' }, msg: 'nested' },
  ]);
});
