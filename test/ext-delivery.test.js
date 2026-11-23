import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deliverFileToUser } from '../ext/file-delivery.js';
import { createOpsAlert } from '../ext/ops-alert.js';
import { SlackApiError } from '../lib/client.js';
import { fakeLogger } from './fakes.js';

function fakeRemackClient(overrides = {}) {
  const calls = [];
  const record = (name, defaultResult) => async (params) => {
    calls.push({ name, params });
    const override = overrides[name];
    if (override instanceof Error) throw override;
    if (typeof override === 'function') return override(params);
    return override ?? defaultResult;
  };

  return {
    calls,
    conversations: { open: record('conversations.open', { channel: { id: 'D_FAKE' } }) },
    files: { upload: record('files.upload', { fileId: 'F1' }) },
    chat: { postMessage: record('chat.postMessage', { ok: true }) },
  };
}

test('deliverFileToUser uploads via the client upload flow', async () => {
  const client = fakeRemackClient();
  const result = await deliverFileToUser(client, {
    userId: 'U1', content: 'a,b\n1,2', filename: 'export.csv',
    title: 'Export', initialComment: 'Here', logger: fakeLogger(),
  });

  assert.deepEqual(result, { deliveredVia: 'file' });
  const upload = client.calls.find((c) => c.name === 'files.upload');
  assert.equal(upload.params.channelId, 'D_FAKE');
  assert.equal(upload.params.content, 'a,b\n1,2');
});

test('missing_scope falls back to inline chunked DM', async () => {
  const client = fakeRemackClient({
    'files.upload': new SlackApiError('files.getUploadURLExternal', { error: 'missing_scope' }),
  });

  const result = await deliverFileToUser(client, {
    userId: 'U1', content: 'line1\nline2', filename: 'export.csv',
    initialComment: 'Here', logger: fakeLogger(), chunkSize: 6,
  });

  assert.deepEqual(result, { deliveredVia: 'inline_fallback' });
  const messages = client.calls.filter((c) => c.name === 'chat.postMessage');
  assert.equal(messages.length, 3, 'intro + 2 chunks');
  assert.match(messages[0].params.text, /missing `files:write`/);
  assert.match(messages[1].params.text, /Chunk 1\/2/);
});

test('non-scope errors propagate; unopenable DM throws', async () => {
  const failing = fakeRemackClient({
    'files.upload': new SlackApiError('files.completeUploadExternal', { error: 'ratelimited' }),
  });
  await assert.rejects(
    () => deliverFileToUser(failing, { userId: 'U1', content: 'x', filename: 'f.csv', logger: fakeLogger() }),
    /ratelimited/
  );

  const noDm = fakeRemackClient({ 'conversations.open': { channel: {} } });
  await assert.rejects(
    () => deliverFileToUser(noDm, { userId: 'U1', content: 'x', filename: 'f.csv', logger: fakeLogger() }),
    /Could not open DM channel/
  );
});

test('ops alert posts to the channel and never throws', async () => {
  const client = fakeRemackClient();
  const { sendOpsAlert } = createOpsAlert({ client, channel: '#ops', logger: fakeLogger() });

  const sent = await sendOpsAlert('Job failed', {
    error: new Error('boom'),
    context: { job: 'sync' },
  });

  assert.equal(sent, true);
  const [message] = client.calls.filter((c) => c.name === 'chat.postMessage');
  assert.equal(message.params.channel, '#ops');
  assert.match(message.params.text, /:rotating_light: \*Job failed\*/);
  assert.match(message.params.text, /boom/);
  assert.match(message.params.text, /\*job\*: sync/);
});

test('ops alert degrades to false when unconfigured or Slack fails', async () => {
  const unconfigured = createOpsAlert({ token: undefined, channel: undefined, logger: fakeLogger() });
  assert.equal(await unconfigured.sendOpsAlert('x'), false);

  const failing = createOpsAlert({
    client: fakeRemackClient({ 'chat.postMessage': new Error('network down') }),
    channel: '#ops',
    logger: fakeLogger(),
  });
  assert.equal(await failing.sendOpsAlert('x'), false);
});
