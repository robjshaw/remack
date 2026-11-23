import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { memoryStorage, fileStorage } from '../lib/storage.js';
import { installationsFrom } from '../lib/installations.js';

function contractTests(name, makeStorage, cleanup = async () => {}) {
  test(`${name}: get/put/delete roundtrip with JSON values`, async () => {
    const storage = await makeStorage();
    try {
      assert.equal(await storage.get('ns', 'missing'), null);

      await storage.put('ns', 'a', { nested: { list: [1, 2] }, text: 'hi' });
      assert.deepEqual(await storage.get('ns', 'a'), { nested: { list: [1, 2] }, text: 'hi' });

      await storage.put('ns', 'a', 'overwritten');
      assert.equal(await storage.get('ns', 'a'), 'overwritten');

      await storage.delete('ns', 'a');
      assert.equal(await storage.get('ns', 'a'), null);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: namespaces are isolated; list sorts, filters by prefix, limits`, async () => {
    const storage = await makeStorage();
    try {
      await storage.put('one', 'k', 1);
      assert.equal(await storage.get('two', 'k'), null);

      await storage.put('list', 'b:2', 'v2');
      await storage.put('list', 'a:1', 'v1');
      await storage.put('list', 'b:1', 'v3');

      const all = await storage.list('list');
      assert.deepEqual(all.map((e) => e.key), ['a:1', 'b:1', 'b:2']);

      const prefixed = await storage.list('list', { prefix: 'b:' });
      assert.deepEqual(prefixed.map((e) => e.key), ['b:1', 'b:2']);

      const limited = await storage.list('list', { limit: 1 });
      assert.deepEqual(limited.map((e) => e.key), ['a:1']);
    } finally {
      await cleanup();
    }
  });
}

contractTests('memoryStorage', async () => memoryStorage());

let fileDir;
contractTests(
  'fileStorage',
  async () => {
    fileDir = await mkdtemp(join(tmpdir(), 'remack-'));
    return fileStorage(join(fileDir, 'data.json'));
  },
  async () => rm(fileDir, { recursive: true, force: true })
);

test('memoryStorage returns copies, not live references', async () => {
  const storage = memoryStorage();
  const original = { count: 1 };
  await storage.put('ns', 'k', original);
  original.count = 99;

  const fetched = await storage.get('ns', 'k');
  assert.equal(fetched.count, 1);
  fetched.count = 50;
  assert.equal((await storage.get('ns', 'k')).count, 1);
});

test('fileStorage persists across instances (restart survival)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'remack-'));
  const path = join(dir, 'nested', 'data.json');

  try {
    const first = fileStorage(path);
    await first.put('installations', 'T:T1', { team: 'T1' });
    await first.put('other', 'k', [1, 2, 3]);

    const second = fileStorage(path);
    assert.deepEqual(await second.get('installations', 'T:T1'), { team: 'T1' });
    assert.deepEqual(await second.get('other', 'k'), [1, 2, 3]);

    const raw = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(raw.installations['T:T1'], 'file is plain readable JSON');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('installationsFrom keys workspace vs enterprise installs correctly', async () => {
  const store = installationsFrom(memoryStorage());

  const workspace = { team: { id: 'T1' }, enterprise: null, isEnterpriseInstall: false, bot: { token: 'xoxb-t1' } };
  const orgWide = { team: null, enterprise: { id: 'E1' }, isEnterpriseInstall: true, bot: { token: 'xoxb-e1' } };

  await store.set(workspace);
  await store.set(orgWide);

  assert.equal((await store.get({ teamId: 'T1' })).bot.token, 'xoxb-t1');
  assert.equal((await store.get({ enterpriseId: 'E1', isEnterpriseInstall: true })).bot.token, 'xoxb-e1');

  // Grid workspace with no direct install falls back to the org-wide record
  assert.equal((await store.get({ teamId: 'T_OTHER', enterpriseId: 'E1' })).bot.token, 'xoxb-e1');
  assert.equal(await store.get({ teamId: 'T_UNKNOWN' }), null);
  await assert.rejects(() => store.get({}), /teamId or enterpriseId/);

  assert.equal((await store.list()).length, 2);

  await store.delete({ teamId: 'T1' });
  assert.equal(await store.get({ teamId: 'T1' }), null);

  await store.delete({ enterpriseId: 'E1', isEnterpriseInstall: true });
  assert.equal(await store.get({ enterpriseId: 'E1', isEnterpriseInstall: true }), null);
});
