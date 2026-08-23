import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { verifySlackSignature } from '../lib/verify.js';

// Slack's documented example from https://api.slack.com/authentication/verifying-requests-from-slack
const DOC_SECRET = '8f742231b10e8888abcd99yyyzzz85a5';
const DOC_TIMESTAMP = '1531420618';
const DOC_BODY = 'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c';
const DOC_SIGNATURE = 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503';

function sign(secret, timestamp, body) {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
}

test("verifies Slack's documented example vector", async () => {
  const result = await verifySlackSignature({
    signingSecret: DOC_SECRET,
    timestamp: DOC_TIMESTAMP,
    signature: DOC_SIGNATURE,
    rawBody: DOC_BODY,
    now: Number(DOC_TIMESTAMP) * 1000, // freeze time to the vector's timestamp
  });
  assert.deepEqual(result, { ok: true });
});

test('cross-checks WebCrypto against node:crypto-generated signatures', async () => {
  const secret = 'another-secret';
  const timestamp = '1700000000';
  const body = JSON.stringify({ type: 'event_callback', event: { type: 'app_mention' } });

  const result = await verifySlackSignature({
    signingSecret: secret,
    timestamp,
    signature: sign(secret, timestamp, body),
    rawBody: body,
    now: 1700000000 * 1000,
  });
  assert.deepEqual(result, { ok: true });
});

test('rejects tampered body', async () => {
  const result = await verifySlackSignature({
    signingSecret: DOC_SECRET,
    timestamp: DOC_TIMESTAMP,
    signature: DOC_SIGNATURE,
    rawBody: DOC_BODY + 'x',
    now: Number(DOC_TIMESTAMP) * 1000,
  });
  assert.deepEqual(result, { ok: false, reason: 'bad_signature' });
});

test('rejects wrong secret', async () => {
  const result = await verifySlackSignature({
    signingSecret: 'wrong-secret',
    timestamp: DOC_TIMESTAMP,
    signature: DOC_SIGNATURE,
    rawBody: DOC_BODY,
    now: Number(DOC_TIMESTAMP) * 1000,
  });
  assert.deepEqual(result, { ok: false, reason: 'bad_signature' });
});

test('rejects stale timestamps in both directions', async () => {
  const timestamp = '1700000000';
  const body = 'x=y';
  const signature = sign('s', timestamp, body);

  const past = await verifySlackSignature({
    signingSecret: 's', timestamp, signature, rawBody: body,
    now: (1700000000 + 301) * 1000,
  });
  assert.deepEqual(past, { ok: false, reason: 'stale_timestamp' });

  const future = await verifySlackSignature({
    signingSecret: 's', timestamp, signature, rawBody: body,
    now: (1700000000 - 301) * 1000,
  });
  assert.deepEqual(future, { ok: false, reason: 'stale_timestamp' });

  const within = await verifySlackSignature({
    signingSecret: 's', timestamp, signature, rawBody: body,
    now: (1700000000 + 299) * 1000,
  });
  assert.deepEqual(within, { ok: true });
});

test('rejects missing or malformed headers', async () => {
  const base = { signingSecret: 's', rawBody: 'x', now: 0 };

  assert.deepEqual(
    await verifySlackSignature({ ...base, timestamp: undefined, signature: 'v0=abc' }),
    { ok: false, reason: 'missing_headers' }
  );
  assert.deepEqual(
    await verifySlackSignature({ ...base, timestamp: '0', signature: undefined }),
    { ok: false, reason: 'missing_headers' }
  );
  assert.deepEqual(
    await verifySlackSignature({ ...base, timestamp: '0', signature: 'sha256=deadbeef' }),
    { ok: false, reason: 'missing_headers' }
  );
  assert.deepEqual(
    await verifySlackSignature({ ...base, timestamp: '0', signature: 'v0=nothex' }),
    { ok: false, reason: 'bad_signature' }
  );
});

test('throws without a signing secret', async () => {
  await assert.rejects(
    () => verifySlackSignature({ timestamp: '0', signature: 'v0=00', rawBody: '' }),
    /signingSecret/
  );
});
