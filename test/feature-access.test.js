'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createFeatureAccess, AccessEventType } = require('../lib/feature-access');
const { fakePool, fakeLogger } = require('./fakes');

const FEATURES = {
  'report': { key: 'report', name: 'Reports', status: 'live', requiresAccess: false },
  'pilot-tool': { key: 'pilot_tool', name: 'Pilot Tool', status: 'pilot', requiresAccess: true, docsUrl: 'https://docs.example.com/pilot' },
  'secret-tool': { key: 'secret_tool', name: 'Secret Tool', status: 'coming_soon', requiresAccess: true },
};

test('live features allow everyone without touching the DB', async () => {
  const pool = fakePool();
  const access = createFeatureAccess({ pool, features: FEATURES, logger: fakeLogger() });

  assert.equal(await access.hasAccess('report', 'U1'), true);
  assert.equal(pool.calls.length, 0);
});

test('unknown features are denied', async () => {
  const access = createFeatureAccess({ features: FEATURES, logger: fakeLogger() });
  assert.equal(await access.hasAccess('nope', 'U1'), false);
});

test('gated features check the access table', async () => {
  const pool = fakePool([{ rows: [{ '?column?': 1 }] }, { rows: [] }]);
  const access = createFeatureAccess({ pool, features: FEATURES, logger: fakeLogger() });

  assert.equal(await access.hasAccess('pilot-tool', 'U_IN'), true);
  assert.equal(await access.hasAccess('pilot-tool', 'U_OUT'), false);
  assert.match(pool.calls[0].text, /FROM public\.feature_access WHERE feature_key = \$1/);
  assert.deepEqual(pool.calls[0].params, ['pilot_tool', 'U_IN']);
});

test('failOpen governs behavior with no DB and on DB errors', async () => {
  const open = createFeatureAccess({ features: FEATURES, failOpen: true, logger: fakeLogger() });
  assert.equal(await open.hasAccess('pilot-tool', 'U1'), true);

  const closed = createFeatureAccess({ features: FEATURES, failOpen: false, logger: fakeLogger() });
  assert.equal(await closed.hasAccess('pilot-tool', 'U1'), false);

  const erroringPool = fakePool(() => { throw new Error('conn refused'); });
  const closedErr = createFeatureAccess({ pool: erroringPool, features: FEATURES, failOpen: false, logger: fakeLogger() });
  assert.equal(await closedErr.hasAccess('pilot-tool', 'U1'), false);
});

test('grantAccess inserts and logs; repeat grant reports alreadyHadAccess', async () => {
  const pool = fakePool([
    { rows: [] },          // existing check → none
    { rows: [] },          // insert
    { rows: [] },          // log event
    { rows: [{ x: 1 }] },  // existing check → present
  ]);
  const access = createFeatureAccess({ pool, features: FEATURES, logger: fakeLogger() });

  const first = await access.grantAccess('pilot-tool', 'U_T', 'Target', 'U_G', 'Granter');
  assert.deepEqual(first, { success: true, alreadyHadAccess: false });
  assert.match(pool.calls[1].text, /INSERT INTO public\.feature_access/);
  assert.match(pool.calls[2].text, /INSERT INTO public\.feature_access_log/);
  assert.equal(pool.calls[2].params[0], AccessEventType.ACCESS_GRANTED);

  const second = await access.grantAccess('pilot-tool', 'U_T', 'Target', 'U_G', 'Granter');
  assert.deepEqual(second, { success: true, alreadyHadAccess: true });
});

test('revokeAccess reports whether the user had access', async () => {
  const pool = fakePool([
    { rows: [{ id: 7 }] }, // delete returning id
    { rows: [] },          // log event
    { rows: [] },          // second delete → nothing
  ]);
  const access = createFeatureAccess({ pool, features: FEATURES, logger: fakeLogger() });

  assert.deepEqual(await access.revokeAccess('pilot-tool', 'U_T', 'U_R', 'Revoker'), { success: true, hadAccess: true });
  assert.deepEqual(await access.revokeAccess('pilot-tool', 'U_T', 'U_R', 'Revoker'), { success: true, hadAccess: false });
});

test('buildNoAccessMessage includes docs link only when configured', () => {
  const access = createFeatureAccess({ features: FEATURES, logger: fakeLogger() });

  const withDocs = access.buildNoAccessMessage('pilot-tool');
  assert.ok(JSON.stringify(withDocs.blocks).includes('https://docs.example.com/pilot'));

  const withoutDocs = access.buildNoAccessMessage('secret-tool');
  assert.ok(!JSON.stringify(withoutDocs.blocks).includes('Learn more'));
  assert.ok(JSON.stringify(withoutDocs.blocks).includes('coming soon'));

  const unknown = access.buildNoAccessMessage('nope');
  assert.equal(unknown.text, 'This feature is not available.');
});

test('custom buildNoAccessMessage override is used', () => {
  const access = createFeatureAccess({
    features: FEATURES,
    logger: fakeLogger(),
    buildNoAccessMessage: (cmd, config) => ({ text: `no ${cmd} for you (${config?.name})` }),
  });

  assert.equal(access.buildNoAccessMessage('pilot-tool').text, 'no pilot-tool for you (Pilot Tool)');
});

test('rejects invalid table names', () => {
  assert.throws(
    () => createFeatureAccess({ features: FEATURES, tables: { access: 'x; DROP' } }),
    /Invalid/
  );
});

test('custom table names are used in queries', async () => {
  const pool = fakePool([{ rows: [] }]);
  const access = createFeatureAccess({
    pool,
    features: FEATURES,
    logger: fakeLogger(),
    tables: { access: 'app.gates', log: 'app.gates_log' },
  });

  await access.hasAccess('pilot-tool', 'U1');
  assert.match(pool.calls[0].text, /FROM app\.gates WHERE/);
});
