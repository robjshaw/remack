import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createClient, SlackApiError, isSlackError } from '../lib/client.js';
import { fakeFetch, fakeLogger } from './fakes.js';

test('call POSTs JSON with bearer token by default', async () => {
  const fetch = fakeFetch([{ ok: true, ts: '1.2' }]);
  const client = createClient({ token: 'xoxb-1', fetch, logger: fakeLogger() });

  const result = await client.call('chat.postMessage', { channel: 'C1', text: 'hi' });

  assert.equal(result.ts, '1.2');
  const [call] = fetch.calls;
  assert.equal(call.url, 'https://slack.com/api/chat.postMessage');
  assert.equal(call.init.headers.authorization, 'Bearer xoxb-1');
  assert.match(call.init.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(call.body), { channel: 'C1', text: 'hi' });
});

test('proxy dot-access is equivalent to call()', async () => {
  const fetch = fakeFetch([{ ok: true, user: { id: 'U1' } }]);
  const client = createClient({ token: 'xoxb-1', fetch, logger: fakeLogger() });

  const result = await client.users.info({ user: 'U1' });
  assert.equal(result.user.id, 'U1');
  assert.equal(fetch.calls[0].url, 'https://slack.com/api/users.info');
});

test('ok:false throws SlackApiError with the Slack error code', async () => {
  const fetch = fakeFetch([{ ok: false, error: 'channel_not_found' }]);
  const client = createClient({ token: 'xoxb-1', fetch, logger: fakeLogger() });

  await assert.rejects(
    () => client.chat.postMessage({ channel: 'C_BAD' }),
    (err) => {
      assert.ok(err instanceof SlackApiError);
      assert.equal(err.error, 'channel_not_found');
      assert.equal(err.method, 'chat.postMessage');
      assert.ok(isSlackError(err, 'channel_not_found'));
      assert.ok(isSlackError(err));
      assert.ok(!isSlackError(err, 'missing_scope'));
      assert.ok(!isSlackError(new Error('x')));
      return true;
    }
  );
});

test('429 honors Retry-After and retries within bounds', async () => {
  const rateLimited = new Response('{"ok":false,"error":"ratelimited"}', {
    status: 429,
    headers: { 'retry-after': '0' },
  });
  const fetch = fakeFetch([rateLimited, { ok: true, done: true }]);
  const client = createClient({ token: 'xoxb-1', fetch, logger: fakeLogger() });

  const result = await client.call('conversations.list', {});
  assert.equal(result.done, true);
  assert.equal(fetch.calls.length, 2);
});

test('429 beyond maxRetries surfaces the error body', async () => {
  const limited = () => new Response('{"ok":false,"error":"ratelimited"}', {
    status: 429,
    headers: { 'retry-after': '0' },
  });
  const fetch = fakeFetch(() => limited());
  const client = createClient({ token: 'xoxb-1', fetch, maxRetries: 1, logger: fakeLogger() });

  await assert.rejects(() => client.call('conversations.list', {}), (err) => {
    assert.ok(isSlackError(err, 'ratelimited'));
    return true;
  });
  assert.equal(fetch.calls.length, 2); // initial + 1 retry
});

test('form-only methods are form-encoded automatically', async () => {
  const fetch = fakeFetch([{ ok: true, access_token: 'xoxb-2' }]);
  const client = createClient({ fetch, logger: fakeLogger() });

  await client.call('oauth.v2.access', { code: 'c0de', client_id: 'id', client_secret: 'sec' });

  const [call] = fetch.calls;
  assert.match(call.init.headers['content-type'], /application\/x-www-form-urlencoded/);
  const form = new URLSearchParams(call.body);
  assert.equal(form.get('code'), 'c0de');
  assert.equal(call.init.headers.authorization, undefined, 'no bearer without token');
});

test('explicit encoding option overrides the default', async () => {
  const fetch = fakeFetch([{ ok: true }]);
  const client = createClient({ token: 'xoxb-1', fetch, logger: fakeLogger() });

  await client.call('chat.postMessage', { channel: 'C1', text: 'hi' }, { encoding: 'form' });
  assert.match(fetch.calls[0].init.headers['content-type'], /urlencoded/);
});

test('files.upload runs the 3-step flow with byte-accurate length', async () => {
  const csv = 'name,emoji\nrocket,🚀\n'; // multibyte: length ≠ byte length
  const expectedBytes = new TextEncoder().encode(csv).byteLength;
  assert.notEqual(expectedBytes, csv.length, 'fixture must be multibyte');

  const fetch = fakeFetch([
    { ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F1' },
    new Response('OK', { status: 200 }),
    { ok: true, files: [{ id: 'F1' }] },
  ]);
  const client = createClient({ token: 'xoxb-1', fetch, logger: fakeLogger() });

  const result = await client.files.upload({
    channelId: 'C1',
    filename: 'report.csv',
    content: csv,
    title: 'Report',
    initialComment: 'Here you go',
  });

  assert.equal(result.fileId, 'F1');
  assert.equal(fetch.calls.length, 3);

  const [getUrl, postBytes, complete] = fetch.calls;
  assert.equal(getUrl.url, 'https://slack.com/api/files.getUploadURLExternal');
  assert.match(getUrl.init.headers['content-type'], /urlencoded/);
  assert.equal(new URLSearchParams(getUrl.body).get('length'), String(expectedBytes));

  assert.equal(postBytes.url, 'https://files.slack.com/upload/v1/abc');
  assert.equal(postBytes.body.byteLength, expectedBytes);

  assert.equal(complete.url, 'https://slack.com/api/files.completeUploadExternal');
  const completeBody = JSON.parse(complete.body);
  assert.deepEqual(completeBody.files, [{ id: 'F1', title: 'Report' }]);
  assert.equal(completeBody.channel_id, 'C1');
  assert.equal(completeBody.initial_comment, 'Here you go');
});

test('files.upload surfaces byte-POST failures as SlackApiError', async () => {
  const fetch = fakeFetch([
    { ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F1' },
    new Response('nope', { status: 500 }),
  ]);
  const client = createClient({ token: 'xoxb-1', fetch, logger: fakeLogger() });

  await assert.rejects(
    () => client.files.upload({ channelId: 'C1', filename: 'f.csv', content: 'x' }),
    (err) => isSlackError(err, 'upload_post_failed_500')
  );
});
