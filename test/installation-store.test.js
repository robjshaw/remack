import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInstallationStore } from '../ext/installation-store.js';
import { fakePool, fakeLogger } from './fakes.js';

const SAMPLE = {
  team: { id: 'T1', name: 'Acme' },
  enterprise: null,
  isEnterpriseInstall: false,
  appId: 'A1',
  bot: { token: 'xoxb-1', id: null, userId: 'UB1', scopes: ['chat:write'] },
  user: { id: 'U1', token: null, scopes: [] },
};

test('requires pool and validates table name', () => {
  assert.throws(() => createInstallationStore({ pool: null }), /pool/);
  assert.throws(() => createInstallationStore({ pool: fakePool(), table: 'bad; DROP' }), /Invalid/);
});

test('set upserts with expected params and injected table', async () => {
  const pool = fakePool([{ rows: [] }]);
  const store = createInstallationStore({ pool, logger: fakeLogger(), table: 'myschema.installs' });

  await store.set(SAMPLE);

  const { text, params } = pool.calls[0];
  assert.match(text, /INSERT INTO myschema\.installs/);
  assert.match(text, /ON CONFLICT \(team_id, enterprise_id, is_enterprise_install\)/);
  assert.equal(params[0], 'T1');
  assert.equal(params[6], 'xoxb-1');
  assert.deepEqual(params[9], ['chat:write']);
  assert.equal(params[13], 'A1');
});

test('get round-trips a row and returns null when missing', async () => {
  const row = {
    team_id: 'T1', team_name: 'Acme',
    enterprise_id: null, enterprise_name: null,
    is_enterprise_install: false,
    bot_token: 'xoxb-1', bot_id: null, bot_user_id: 'UB1', bot_scopes: ['chat:write'],
    user_token: null, user_id: 'U1', user_scopes: null,
    app_id: 'A1',
  };
  const pool = fakePool([{ rows: [row] }, { rows: [] }]);
  const store = createInstallationStore({ pool, logger: fakeLogger() });

  const installation = await store.get({ teamId: 'T1' });
  assert.deepEqual(installation.team, { id: 'T1', name: 'Acme' });
  assert.equal(installation.bot.token, 'xoxb-1');
  assert.equal(installation.user, null, 'no user token → no user object');

  assert.equal(await store.get({ teamId: 'T404' }), null);
});

test('get uses enterprise lookup for org-wide installs and validates input', async () => {
  const pool = fakePool([{ rows: [{ team_id: null, enterprise_id: 'E1', is_enterprise_install: true, bot_token: 'x', bot_scopes: [] }] }]);
  const store = createInstallationStore({ pool, logger: fakeLogger() });

  await store.get({ enterpriseId: 'E1', isEnterpriseInstall: true });
  assert.match(pool.calls[0].text, /enterprise_id = \$1 AND is_enterprise_install = TRUE/);

  await assert.rejects(() => store.get({}), /teamId or enterpriseId/);
});

test('delete removes by team or enterprise', async () => {
  const pool = fakePool([{ rows: [] }, { rows: [] }]);
  const store = createInstallationStore({ pool, logger: fakeLogger() });

  await store.delete({ teamId: 'T1' });
  assert.match(pool.calls[0].text, /WHERE team_id = \$1/);

  await store.delete({ enterpriseId: 'E1', isEnterpriseInstall: true });
  assert.match(pool.calls[1].text, /WHERE enterprise_id = \$1 AND is_enterprise_install = TRUE/);
});
