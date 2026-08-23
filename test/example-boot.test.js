import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../lib/index.js';
import { fakeLogger, signedRequest, TEST_SIGNING_SECRET } from './fakes.js';
import { slashCommandForm } from './fixtures/payloads.js';

// Boots the actual example routes/ dir against a fake env — proves the
// example stays valid without needing Slack.
test('example route-bot boots and serves /ping', async () => {
  const app = createApp({
    signingSecret: TEST_SIGNING_SECRET,
    botToken: 'xoxb-test',
    routes: new URL('../examples/route-bot/routes/', import.meta.url),
    context: { startedAt: new Date(0) },
    logger: fakeLogger(),
  });
  await app.ready;

  const body = new URLSearchParams(slashCommandForm);
  body.set('command', '/ping');
  const response = await app.fetch(signedRequest({ body }));

  assert.equal(response.status, 200);
  assert.match((await response.json()).text, /pong/);
});
