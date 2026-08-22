'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createInstallationStore } = require('../lib/installation-store');
const { fakePool, fakeLogger } = require('./fakes');

const SAMPLE_INSTALLATION = {
  team: { id: 'T1', name: 'Acme' },
  enterprise: undefined,
  isEnterpriseInstall: false,
  bot: { token: 'xoxb-1', id: 'B1', userId: 'UB1', scopes: ['chat:write'] },
  user: { id: 'U1', token: undefined, scopes: [] },
  appId: 'A1',
};

test('rejects invalid table names', () => {
  assert.throws(() => createInstallationStore({ pool: fakePool(), table: 'bad; DROP TABLE x' }), /Invalid/);
});

test('storeInstallation upserts with expected params and table', async () => {
  const pool = fakePool([{ rows: [] }]);
  const store = createInstallationStore({ pool, logger: fakeLogger(), table: 'myschema.installs' });

  await store.storeInstallation(SAMPLE_INSTALLATION);

  assert.equal(pool.calls.length, 1);
  const { text, params } = pool.calls[0];
  assert.match(text, /INSERT INTO myschema\.installs/);
  assert.match(text, /ON CONFLICT \(team_id, enterprise_id, is_enterprise_install\)/);
  assert.equal(params[0], 'T1');
  assert.equal(params[6], 'xoxb-1');
  assert.deepEqual(params[9], ['chat:write']);
  assert.equal(params[13], 'A1');
});

test('fetchInstallation round-trips a row into Bolt installation shape', async () => {
  const row = {
    team_id: 'T1',
    team_name: 'Acme',
    enterprise_id: null,
    enterprise_name: null,
    is_enterprise_install: false,
    bot_token: 'xoxb-1',
    bot_id: 'B1',
    bot_user_id: 'UB1',
    bot_scopes: ['chat:write'],
    user_token: null,
    user_id: 'U1',
    user_scopes: null,
    app_id: 'A1',
  };
  const pool = fakePool([{ rows: [row] }]);
  const store = createInstallationStore({ pool, logger: fakeLogger() });

  const installation = await store.fetchInstallation({ teamId: 'T1' });

  assert.deepEqual(installation.team, { id: 'T1', name: 'Acme' });
  assert.equal(installation.enterprise, undefined);
  assert.equal(installation.bot.token, 'xoxb-1');
  assert.deepEqual(installation.bot.scopes, ['chat:write']);
  assert.equal(installation.user, undefined, 'no user token → no user object');
  assert.equal(installation.appId, 'A1');
});

test('fetchInstallation uses enterprise lookup for org-wide installs', async () => {
  const pool = fakePool([{ rows: [{ team_id: null, enterprise_id: 'E1', is_enterprise_install: true, bot_token: 'x', bot_scopes: [] }] }]);
  const store = createInstallationStore({ pool, logger: fakeLogger() });

  await store.fetchInstallation({ enterpriseId: 'E1', isEnterpriseInstall: true });
  assert.match(pool.calls[0].text, /enterprise_id = \$1 AND is_enterprise_install = TRUE/);
});

test('fetchInstallation throws when not found', async () => {
  const pool = fakePool([{ rows: [] }]);
  const store = createInstallationStore({ pool, logger: fakeLogger() });

  await assert.rejects(() => store.fetchInstallation({ teamId: 'T404' }), /Installation not found/);
});

test('methods throw without a pool, except getAllInstallations', async () => {
  const store = createInstallationStore({ logger: fakeLogger() });

  await assert.rejects(() => store.storeInstallation(SAMPLE_INSTALLATION), /Database not configured/);
  await assert.rejects(() => store.fetchInstallation({ teamId: 'T1' }), /Database not configured/);
  assert.deepEqual(await store.getAllInstallations(), []);
});

test('deleteInstallation deletes by team for workspace installs', async () => {
  const pool = fakePool([{ rows: [] }]);
  const store = createInstallationStore({ pool, logger: fakeLogger() });

  await store.deleteInstallation({ teamId: 'T1' });
  assert.match(pool.calls[0].text, /DELETE FROM public\.slack_installations\s+WHERE team_id = \$1/);
});
