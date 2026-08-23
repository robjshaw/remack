import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFeatureAccess, AccessEventType } from '../ext/feature-access.js';
import { fakePool, fakeLogger } from './fakes.js';

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
  assert.equal(await access.hasAccess('nope', 'U1'), false, 'unknown features denied');
});

test('gated features check the access table; failOpen governs degrade', async () => {
  const pool = fakePool([{ rows: [{ x: 1 }] }, { rows: [] }]);
  const access = createFeatureAccess({ pool, features: FEATURES, logger: fakeLogger() });

  assert.equal(await access.hasAccess('pilot-tool', 'U_IN'), true);
  assert.equal(await access.hasAccess('pilot-tool', 'U_OUT'), false);
  assert.deepEqual(pool.calls[0].params, ['pilot_tool', 'U_IN']);

  const open = createFeatureAccess({ features: FEATURES, failOpen: true, logger: fakeLogger() });
  assert.equal(await open.hasAccess('pilot-tool', 'U1'), true);

  const closed = createFeatureAccess({ features: FEATURES, failOpen: false, logger: fakeLogger() });
  assert.equal(await closed.hasAccess('pilot-tool', 'U1'), false);

  const erroring = createFeatureAccess({
    pool: fakePool(() => { throw new Error('down'); }),
    features: FEATURES, failOpen: false, logger: fakeLogger(),
  });
  assert.equal(await erroring.hasAccess('pilot-tool', 'U1'), false);
});

test('grantAccess inserts and logs; repeat grant reports alreadyHadAccess', async () => {
  const pool = fakePool([
    { rows: [] }, { rows: [] }, { rows: [] },
    { rows: [{ x: 1 }] },
  ]);
  const access = createFeatureAccess({ pool, features: FEATURES, logger: fakeLogger() });

  const first = await access.grantAccess('pilot-tool', 'U_T', 'Target', 'U_G', 'Granter');
  assert.deepEqual(first, { success: true, alreadyHadAccess: false });
  assert.match(pool.calls[2].text, /INSERT INTO public\.feature_access_log/);
  assert.equal(pool.calls[2].params[0], AccessEventType.ACCESS_GRANTED);

  const second = await access.grantAccess('pilot-tool', 'U_T', 'Target', 'U_G', 'Granter');
  assert.deepEqual(second, { success: true, alreadyHadAccess: true });
});

test('revokeAccess reports whether the user had access', async () => {
  const pool = fakePool([{ rows: [{ id: 7 }] }, { rows: [] }, { rows: [] }]);
  const access = createFeatureAccess({ pool, features: FEATURES, logger: fakeLogger() });

  assert.deepEqual(await access.revokeAccess('pilot-tool', 'U_T', 'U_R', 'R'), { success: true, hadAccess: true });
  assert.deepEqual(await access.revokeAccess('pilot-tool', 'U_T', 'U_R', 'R'), { success: true, hadAccess: false });
});

test('buildNoAccessMessage includes docs link only when configured; override wins', () => {
  const access = createFeatureAccess({ features: FEATURES, logger: fakeLogger() });

  assert.ok(JSON.stringify(access.buildNoAccessMessage('pilot-tool')).includes('docs.example.com'));
  assert.ok(!JSON.stringify(access.buildNoAccessMessage('secret-tool')).includes('Learn more'));
  assert.equal(access.buildNoAccessMessage('nope').text, 'This feature is not available.');

  const custom = createFeatureAccess({
    features: FEATURES,
    logger: fakeLogger(),
    buildNoAccessMessage: (cmd, config) => ({ text: `no ${cmd} (${config?.name})` }),
  });
  assert.equal(custom.buildNoAccessMessage('pilot-tool').text, 'no pilot-tool (Pilot Tool)');
});

test('table names are injectable and validated', async () => {
  assert.throws(() => createFeatureAccess({ features: FEATURES, tables: { access: 'x; DROP' } }), /Invalid/);

  const pool = fakePool([{ rows: [] }]);
  const access = createFeatureAccess({
    pool, features: FEATURES, logger: fakeLogger(),
    tables: { access: 'app.gates', log: 'app.gates_log' },
  });
  await access.hasAccess('pilot-tool', 'U1');
  assert.match(pool.calls[0].text, /FROM app\.gates WHERE/);
});
