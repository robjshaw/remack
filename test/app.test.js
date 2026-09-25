import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../lib/app.js';
import { route } from '../lib/router.js';
import { UserError } from '../lib/errors.js';
import { view } from '../lib/respond.js';
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

test('rejects bad signatures with 401 and unknown paths with 404', async () => {
  const app = makeApp();

  const badSig = await app.fetch(signedRequest({
    body: payloads.slashCommandForm,
    signingSecret: 'wrong-secret',
  }));
  assert.equal(badSig.status, 401);

  const notFound = await app.fetch(new Request('https://bot.test/nope', { method: 'POST', body: 'x' }));
  assert.equal(notFound.status, 404);
});

test('url_verification echoes the challenge (after signature check)', async () => {
  const app = makeApp();
  const response = await app.fetch(signedRequest({ body: payloads.urlVerification }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { challenge: payloads.urlVerification.challenge });
});

test('command route: string return becomes ephemeral message ack', async () => {
  const app = makeApp({
    routes: [route('command', '/report', { default: async ({ payload }) => `Running ${payload.text}` })],
  });

  const response = await app.fetch(signedRequest({ body: payloads.slashCommandForm }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { response_type: 'ephemeral', text: 'Running weekly' });
});

test('command route: undefined return acks empty 200', async () => {
  const app = makeApp({
    routes: [route('command', '/report', { default: async () => {} })],
  });

  const response = await app.fetch(signedRequest({ body: payloads.slashCommandForm }));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});

test('loader result is available to the handler at args.data', async () => {
  const app = makeApp({
    routes: [route('command', '/report', {
      loader: async () => ({ count: 9 }),
      default: async ({ data }) => `count=${data.count}`,
    })],
  });

  const response = await app.fetch(signedRequest({ body: payloads.slashCommandForm }));
  assert.equal((await response.json()).text, 'count=9');
});

test('view_submission: response_action JSON round-trips exactly', async () => {
  const app = makeApp({
    routes: [route('view', 'settings', {
      default: async () => view.errors({ b1: 'Required field' }),
    })],
  });

  const response = await app.fetch(signedRequest({ body: interactivityBody(payloads.viewSubmission) }));
  assert.deepEqual(await response.json(), {
    response_action: 'errors',
    errors: { b1: 'Required field' },
  });
});

test('action: ack is empty; returned message goes to response_url post-ack', async () => {
  const posted = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    posted.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('ok');
  };

  try {
    const app = makeApp({
      routes: [route('action', 'open_settings', { default: async () => 'Settings opened' })],
    });

    const response = await app.fetch(signedRequest({ body: interactivityBody(payloads.blockActions) }));
    assert.equal(await response.text(), '', 'ack body must be empty for block_actions');

    await app.idle();
    assert.equal(posted.length, 1);
    assert.equal(posted[0].url, payloads.blockActions.response_url);
    assert.deepEqual(posted[0].body, { response_type: 'ephemeral', text: 'Settings opened' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('event: acks 200 immediately, handler runs as continuation', async () => {
  let handled = false;
  let resolveGate;
  const gate = new Promise((resolve) => { resolveGate = resolve; });

  const app = makeApp({
    routes: [route('event', 'app_mention', {
      default: async ({ payload }) => {
        await gate;
        handled = payload.event.type === 'app_mention';
      },
    })],
  });

  const response = await app.fetch(signedRequest({ body: payloads.eventCallback }));
  assert.equal(response.status, 200);
  assert.equal(handled, false, 'ack must not wait for the handler');

  resolveGate();
  await app.idle();
  assert.equal(handled, true);
});

test('event retries are dropped by default and processed when disabled', async () => {
  let runs = 0;
  const routes = [route('event', 'app_mention', { default: async () => { runs += 1; } })];

  const dropApp = makeApp({ routes });
  await dropApp.fetch(signedRequest({
    body: payloads.eventCallback,
    headers: { 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_timeout' },
  }));
  await dropApp.idle();
  assert.equal(runs, 0);

  const keepApp = makeApp({ routes, ignoreEventRetries: false });
  await keepApp.fetch(signedRequest({
    body: payloads.eventCallback,
    headers: { 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_timeout' },
  }));
  await keepApp.idle();
  assert.equal(runs, 1);
});

test('unmatched anything still acks 200 (the catch-all lesson)', async () => {
  const logger = fakeLogger();
  const app = makeApp({ logger });

  const action = await app.fetch(signedRequest({ body: interactivityBody(payloads.blockActions) }));
  assert.equal(action.status, 200);
  assert.equal(await action.text(), '');

  const options = await app.fetch(signedRequest({ body: interactivityBody(payloads.blockSuggestion) }));
  assert.deepEqual(await options.json(), { options: [] });

  const event = await app.fetch(signedRequest({ body: payloads.eventCallback }));
  assert.equal(event.status, 200);

  const command = await app.fetch(signedRequest({ body: payloads.slashCommandForm }));
  assert.equal(command.status, 200);

  const acked = logger.entries.filter((e) => e.msg === 'Slack request handled' && e.objOrMsg.outcome === 'unhandled');
  assert.equal(acked.length, 4);
});

test('pre-ack throw runs boundary chain and still returns 200', async () => {
  const alerts = [];
  const app = makeApp({
    routes: [route('command', '/report', { default: async () => { throw new Error('kaboom'); } })],
    opsAlert: async (title, opts) => alerts.push({ title, opts }),
    genericMessage: 'Oops.',
  });

  const response = await app.fetch(signedRequest({ body: payloads.slashCommandForm }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { response_type: 'ephemeral', text: 'Oops.' });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(alerts.length, 1);
});

test('UserError shows its message and skips the ops alert', async () => {
  const alerts = [];
  const app = makeApp({
    routes: [route('command', '/report', { default: async () => { throw new UserError('Pick a client first.'); } })],
    opsAlert: async (title) => alerts.push(title),
  });

  const response = await app.fetch(signedRequest({ body: payloads.slashCommandForm }));
  assert.deepEqual(await response.json(), { response_type: 'ephemeral', text: 'Pick a client first.' });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(alerts.length, 0);
});

test('route ErrorBoundary takes precedence over app onError', async () => {
  const order = [];
  const app = makeApp({
    routes: [route('command', '/report', {
      default: async () => { throw new Error('x'); },
      ErrorBoundary: async () => { order.push('route'); return 'route boundary'; },
    })],
    onError: () => { order.push('app'); return 'app boundary'; },
  });

  const response = await app.fetch(signedRequest({ body: payloads.slashCommandForm }));
  assert.deepEqual(order, ['route']);
  assert.equal((await response.json()).text, 'route boundary');
});

test('defer() runs after the ack; continuation errors hit the boundary chain', async () => {
  const events = [];
  const app = makeApp({
    routes: [route('command', '/report', {
      default: async ({ defer }) => {
        defer(async () => { events.push('deferred'); throw new Error('post-ack failure'); });
        return 'acked';
      },
    })],
    onError: (error) => { events.push(`boundary:${error.message}`); return null; },
  });

  const response = await app.fetch(signedRequest({ body: payloads.slashCommandForm }));
  assert.equal((await response.json()).text, 'acked');

  await app.idle();
  assert.deepEqual(events, ['deferred', 'boundary:post-ack failure']);
});

test('home tab: loader + render publish a view via views.publish', async () => {
  const published = [];
  const fakeClient = {
    views: { publish: async (params) => published.push(params) },
  };

  const app = makeApp({
    routes: [route('event', 'app_home_opened', {
      loader: async () => ({ name: 'Rob' }),
      render: ({ data }) => [
        { type: 'section', text: { type: 'mrkdwn', text: `Hello ${data.name}` } },
      ],
    })],
    context: {},
  });

  // Swap the client the app hands to routes by intercepting via context is not
  // possible; instead exercise runEventRoute through a custom route that uses
  // the injected client — here we monkey-patch the app-level client.
  app.client.views = fakeClient.views;

  const response = await app.fetch(signedRequest({ body: payloads.homeOpenedEvent }));
  assert.equal(response.status, 200);
  await app.idle();

  assert.equal(published.length, 1);
  assert.equal(published[0].user_id, 'U333');
  assert.equal(published[0].view.type, 'home', 'blocks array is wrapped into a home view');
  assert.match(published[0].view.blocks[0].text.text, /Hello Rob/);
});

test('oauth mode: unknown workspace acks 200; uninstall event deletes installation', async () => {
  const deleted = [];
  const store = {
    get: async () => null,
    set: async () => {},
    delete: async (query) => deleted.push(query),
  };

  const app = createApp({
    signingSecret: TEST_SIGNING_SECRET,
    oauth: {
      clientId: 'id', clientSecret: 'secret', stateSecret: 'state',
      scopes: ['chat:write'], store,
    },
    routes: [],
    logger: fakeLogger(),
  });

  const unknown = await app.fetch(signedRequest({ body: interactivityBody(payloads.blockActions) }));
  assert.equal(unknown.status, 200);

  const uninstall = await app.fetch(signedRequest({
    body: { ...payloads.eventCallback, event: { type: 'app_uninstalled' } },
  }));
  assert.equal(uninstall.status, 200);
  await app.idle();
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].teamId, 'T111');
});

test('oauth mode works without a store: installations live in app storage', async () => {
  const handled = [];
  const app = createApp({
    signingSecret: TEST_SIGNING_SECRET,
    oauth: {
      clientId: 'id', clientSecret: 'secret', stateSecret: 'state',
      scopes: ['chat:write'],
    },
    routes: [route('action', 'open_settings', {
      default: async ({ client, teamId }) => { handled.push({ token: client.token, teamId }); },
    })],
    logger: fakeLogger(),
  });

  // Unknown workspace → acked, handler not run
  const before = await app.fetch(signedRequest({ body: interactivityBody(payloads.blockActions) }));
  assert.equal(before.status, 200);
  assert.equal(handled.length, 0);

  // Simulate a completed install by writing to the default storage
  const { installationsFrom } = await import('../lib/installations.js');
  await installationsFrom(app.storage).set({
    team: { id: 'T111' }, enterprise: null, isEnterpriseInstall: false,
    bot: { token: 'xoxb-installed' },
  });

  const after = await app.fetch(signedRequest({ body: interactivityBody(payloads.blockActions) }));
  assert.equal(after.status, 200);
  assert.equal(handled.length, 1);
  assert.equal(handled[0].token, 'xoxb-installed');
  assert.equal(handled[0].teamId, 'T111');
});

test('createApp validates configuration early', () => {
  assert.throws(() => createApp({ botToken: 'x', signingSecret: undefined }), /signingSecret/);
  assert.throws(() => createApp({ signingSecret: 's', botToken: undefined, oauth: undefined }), /botToken.*oauth/);
  assert.throws(
    () => createApp({ signingSecret: 's', oauth: { clientId: 'i', clientSecret: 'c', stateSecret: 's', store: {} } }),
    /scopes/
  );
});
