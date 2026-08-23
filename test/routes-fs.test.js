import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadRoutes, parseRouteFilename } from '../lib/routes-fs.js';
import { createRouter } from '../lib/router.js';
import { createApp } from '../lib/app.js';
import { fakeLogger, signedRequest, TEST_SIGNING_SECRET } from './fakes.js';
import { slashCommandForm } from './fixtures/payloads.js';

const GOOD_DIR = new URL('./fixtures/routes-good/', import.meta.url);
const BAD_DIR = new URL('./fixtures/routes-bad/', import.meta.url);

test('parseRouteFilename maps the convention table', () => {
  assert.deepEqual(parseRouteFilename('command.report.js'), { kind: 'command', id: '/report' });
  assert.deepEqual(parseRouteFilename('action.open_settings.js'), { kind: 'action', id: 'open_settings' });
  assert.deepEqual(parseRouteFilename('view.settings.js'), { kind: 'view', id: 'settings' });
  assert.deepEqual(parseRouteFilename('view_closed.settings.js'), { kind: 'view_closed', id: 'settings' });
  assert.deepEqual(parseRouteFilename('shortcut.new_task.js'), { kind: 'shortcut', id: 'new_task' });
  assert.deepEqual(parseRouteFilename('options.project_picker.js'), { kind: 'options', id: 'project_picker' });
  assert.deepEqual(parseRouteFilename('event.app_home_opened.js'), { kind: 'event', id: 'app_home_opened' });

  // Dots in the id are preserved
  assert.deepEqual(parseRouteFilename('event.message.im.js'), { kind: 'event', id: 'message.im' });

  // Wildcards
  const wildcard = parseRouteFilename('action.row_$.js');
  assert.equal(wildcard.kind, 'action');
  assert.ok(wildcard.id instanceof RegExp);
  assert.ok(wildcard.id.test('row_123'));
  assert.ok(!wildcard.id.test('other'));

  // Non-routes
  assert.equal(parseRouteFilename('README.md'), null);
  assert.equal(parseRouteFilename('helpers.js'), null);
  assert.equal(parseRouteFilename('command.js'), null, 'kind with no id is not a route');
});

test('loadRoutes discovers and validates modules', async () => {
  const defs = await loadRoutes(GOOD_DIR, { logger: fakeLogger() });

  const summary = defs.map((def) => `${def.kind}:${String(def.id)}`).sort();
  assert.deepEqual(summary, [
    'action:/^row_.*$/',
    'command:/ping',
    'event:app_home_opened',
    'view_closed:wizard',
  ]);

  const router = createRouter({ routes: defs, logger: fakeLogger() });
  assert.ok(router.match('command', '/ping'));
  assert.ok(router.match('action', 'row_42'));
});

test('loadRoutes rejects invalid modules with the filename in the message', async () => {
  await assert.rejects(
    () => loadRoutes(BAD_DIR, { logger: fakeLogger() }),
    /action\.broken\.js.*default handler or render/
  );
});

test('loadRoutes rejects missing directories descriptively', async () => {
  await assert.rejects(
    () => loadRoutes('/nonexistent/routes', { logger: fakeLogger() }),
    /Cannot read routes directory/
  );
});

test('createApp accepts a routes directory and serves discovered routes', async () => {
  const app = createApp({
    signingSecret: TEST_SIGNING_SECRET,
    botToken: 'xoxb-test',
    routes: GOOD_DIR,
    logger: fakeLogger(),
  });
  await app.ready;

  const body = new URLSearchParams(slashCommandForm);
  body.set('command', '/ping');
  const response = await app.fetch(signedRequest({ body }));

  assert.deepEqual(await response.json(), { response_type: 'ephemeral', text: 'pong' });
});
