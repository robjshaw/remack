'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { deliverFileToUser, deliverCsvExportToUser } = require('../lib/file-delivery');
const { fakeWebClient, fakeLogger } = require('./fakes');

test('delivers via file upload when scope is available', async () => {
  const client = fakeWebClient();
  const result = await deliverFileToUser(client, {
    userId: 'U1',
    content: 'a,b\n1,2',
    filename: 'export.csv',
    title: 'Export',
    initialComment: 'Here you go',
    logger: fakeLogger(),
  });

  assert.deepEqual(result, { deliveredVia: 'file' });
  const upload = client.calls.find((c) => c.method === 'files.uploadV2');
  assert.equal(upload.params.channel_id, 'D_FAKE');
  assert.equal(upload.params.content, 'a,b\n1,2');
});

test('falls back to inline chunks on missing_scope', async () => {
  const scopeError = new Error('missing scope');
  scopeError.data = { error: 'missing_scope' };
  const client = fakeWebClient({ 'files.uploadV2': scopeError });

  const result = await deliverFileToUser(client, {
    userId: 'U1',
    content: 'line1\nline2',
    filename: 'export.csv',
    initialComment: 'Here you go',
    logger: fakeLogger(),
    chunkSize: 6,
  });

  assert.deepEqual(result, { deliveredVia: 'inline_fallback' });
  const messages = client.calls.filter((c) => c.method === 'chat.postMessage');
  assert.equal(messages.length, 3, 'intro + 2 chunks');
  assert.match(messages[0].params.text, /missing `files:write`/);
  assert.match(messages[1].params.text, /Chunk 1\/2/);
});

test('non-scope upload errors propagate', async () => {
  const otherError = new Error('rate_limited');
  otherError.data = { error: 'rate_limited' };
  const client = fakeWebClient({ 'files.uploadV2': otherError });

  await assert.rejects(
    () => deliverFileToUser(client, { userId: 'U1', content: 'x', filename: 'f.csv', logger: fakeLogger() }),
    /rate_limited/
  );
});

test('throws when DM channel cannot be opened', async () => {
  const client = fakeWebClient({ 'conversations.open': { channel: {} } });
  await assert.rejects(
    () => deliverFileToUser(client, { userId: 'U1', content: 'x', filename: 'f.csv', logger: fakeLogger() }),
    /Could not open DM channel/
  );
});

test('deliverCsvExportToUser alias accepts csv param', async () => {
  const client = fakeWebClient();
  const result = await deliverCsvExportToUser(client, {
    userId: 'U1',
    csv: 'a,b',
    filename: 'export.csv',
    logger: fakeLogger(),
  });

  assert.deepEqual(result, { deliveredVia: 'file' });
  const upload = client.calls.find((c) => c.method === 'files.uploadV2');
  assert.equal(upload.params.content, 'a,b');
});
