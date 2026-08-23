import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { createApp } from '../lib/app.js';
import { route } from '../lib/router.js';
import { serve, toNodeHandler } from '../lib/node.js';
import { fakeLogger, TEST_SIGNING_SECRET } from './fakes.js';
import { slashCommandForm } from './fixtures/payloads.js';

test('end-to-end over real node:http with a real signature', async () => {
  const app = createApp({
    signingSecret: TEST_SIGNING_SECRET,
    botToken: 'xoxb-test',
    routes: [route('command', '/report', { default: async ({ payload }) => `got ${payload.text}` })],
    logger: fakeLogger(),
  });

  const { url, close } = await serve({ fetch: app.fetch, port: 0, onIdle: app.idle });

  try {
    const rawBody = slashCommandForm.toString();
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = 'v0=' + createHmac('sha256', TEST_SIGNING_SECRET)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest('hex');

    const response = await fetch(`${url}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': String(timestamp),
        'x-slack-signature': signature,
      },
      body: rawBody,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { response_type: 'ephemeral', text: 'got weekly' });

    // Tampered byte → 401 proves the adapter preserved raw bytes for signing
    const tampered = await fetch(`${url}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': String(timestamp),
        'x-slack-signature': signature,
      },
      body: rawBody + 'x',
    });
    assert.equal(tampered.status, 401);

    const notFound = await fetch(`${url}/other`, { method: 'POST', body: 'x' });
    assert.equal(notFound.status, 404);
  } finally {
    await close();
  }
});

test('toNodeHandler raises a descriptive error for pre-consumed streams', async () => {
  const handler = toNodeHandler(async () => new Response('ok'));

  const req = new EventEmitter();
  req.readableEnded = true; // simulates express.json() having drained the stream
  req.method = 'POST';
  req.url = '/events';
  req.headers = { host: 'x' };

  let statusCode;
  let body = '';
  const res = {
    headersSent: false,
    writeHead: (code) => { statusCode = code; },
    end: (chunk) => { body += chunk || ''; },
  };

  const originalError = console.error;
  const errors = [];
  console.error = (...parts) => errors.push(parts.join(' '));
  try {
    await handler(req, res);
  } finally {
    console.error = originalError;
  }

  assert.equal(statusCode, 500);
  assert.ok(errors.some((entry) => /already consumed/.test(entry)), 'expected the descriptive middleware error');
});
