import { test } from 'node:test';
import assert from 'node:assert/strict';

import { postgresStorage } from '../ext/postgres-storage.js';
import { fakePool, fakeLogger } from './fakes.js';

test('requires pool and validates table name', () => {
  assert.throws(() => postgresStorage({ pool: null }), /pool/);
  assert.throws(() => postgresStorage({ pool: fakePool(), table: 'bad; DROP' }), /Invalid/);
});

test('get returns the JSONB value or null', async () => {
  const pool = fakePool([{ rows: [{ value: { a: 1 } }] }, { rows: [] }]);
  const storage = postgresStorage({ pool, logger: fakeLogger() });

  assert.deepEqual(await storage.get('installations', 'T:T1'), { a: 1 });
  assert.equal(await storage.get('installations', 'T:missing'), null);
  assert.deepEqual(pool.calls[0].params, ['installations', 'T:T1']);
  assert.match(pool.calls[0].text, /FROM remack_kv WHERE ns = \$1 AND key = \$2/);
});

test('put upserts with stringified value into the injected table', async () => {
  const pool = fakePool([{ rows: [] }]);
  const storage = postgresStorage({ pool, table: 'myapp.kv', logger: fakeLogger() });

  await storage.put('ns', 'k', { nested: true });

  assert.match(pool.calls[0].text, /INSERT INTO myapp\.kv/);
  assert.match(pool.calls[0].text, /ON CONFLICT \(ns, key\)/);
  assert.deepEqual(pool.calls[0].params, ['ns', 'k', '{"nested":true}']);
});

test('delete removes by ns and key', async () => {
  const pool = fakePool([{ rows: [] }]);
  const storage = postgresStorage({ pool, logger: fakeLogger() });

  await storage.delete('ns', 'k');
  assert.match(pool.calls[0].text, /DELETE FROM remack_kv WHERE ns = \$1 AND key = \$2/);
});

test('list orders by key and applies escaped prefix and limit', async () => {
  const pool = fakePool([{ rows: [{ key: 'a', value: 1 }, { key: 'b', value: 2 }] }]);
  const storage = postgresStorage({ pool, logger: fakeLogger() });

  const entries = await storage.list('ns', { prefix: 'pilot_100%:', limit: 10 });
  assert.deepEqual(entries, [{ key: 'a', value: 1 }, { key: 'b', value: 2 }]);

  const { text, params } = pool.calls[0];
  assert.match(text, /ORDER BY key/);
  assert.match(text, /LIMIT \$3/);
  assert.equal(params[1], 'pilot\\_100\\%:%', 'LIKE wildcards in the prefix are escaped');
  assert.equal(params[2], 10);
});
