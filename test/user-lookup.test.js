'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createUserLookup } = require('../lib/user-lookup');
const { fakeWebClient, fakeLogger } = require('./fakes');

test('requires emailDomain', () => {
  assert.throws(() => createUserLookup({ logger: fakeLogger() }), /emailDomain/);
});

test('nameToEmail applies first.last convention, special mappings, single names', () => {
  const lookup = createUserLookup({
    emailDomain: 'example.com',
    specialMappings: { 'Bobby Tables': 'bob.tables@example.com' },
    logger: fakeLogger(),
  });

  assert.equal(lookup.nameToEmail('Adil Khan'), 'adil.khan@example.com');
  assert.equal(lookup.nameToEmail('Anna Maria Rossi'), 'anna.rossi@example.com');
  assert.equal(lookup.nameToEmail('Madonna'), 'madonna@example.com');
  assert.equal(lookup.nameToEmail('Bobby Tables'), 'bob.tables@example.com');
  assert.equal(lookup.nameToEmail('bobby tables'), 'bob.tables@example.com', 'special mappings are case-insensitive');
  assert.equal(lookup.nameToEmail(''), null);
});

test('nameToFallbackEmail uses first name only', () => {
  const lookup = createUserLookup({ emailDomain: 'example.com', logger: fakeLogger() });
  assert.equal(lookup.nameToFallbackEmail('Adil Khan'), 'adil@example.com');
  assert.equal(lookup.nameToFallbackEmail('  '), null);
});

test('lookupUserByName finds user by derived email and caches', async () => {
  const client = fakeWebClient({
    'users.lookupByEmail': ({ email }) => ({
      ok: true,
      user: { id: 'U_ADIL', real_name: 'Adil Khan', profile: { email } },
    }),
  });
  const lookup = createUserLookup({ emailDomain: 'example.com', logger: fakeLogger() });

  const user = await lookup.lookupUserByName(client, 'Adil Khan');
  assert.equal(user.id, 'U_ADIL');

  await lookup.lookupUserByName(client, 'adil khan');
  assert.equal(client.calls.length, 1, 'second lookup served from cache');
});

test('falls back to first-name email when full email not found', async () => {
  let attempt = 0;
  const client = fakeWebClient({
    'users.lookupByEmail': ({ email }) => {
      attempt += 1;
      if (email === 'adil.khan@example.com') {
        const err = new Error('users_not_found');
        err.data = { error: 'users_not_found' };
        throw err;
      }
      return { ok: true, user: { id: 'U_ADIL', real_name: 'Adil', profile: { email } } };
    },
  });
  const lookup = createUserLookup({ emailDomain: 'example.com', logger: fakeLogger() });

  const user = await lookup.lookupUserByName(client, 'Adil Khan');
  assert.equal(user.id, 'U_ADIL');
  assert.equal(attempt, 2);
});

test('caches misses as null', async () => {
  const client = fakeWebClient({
    'users.lookupByEmail': () => {
      const err = new Error('users_not_found');
      err.data = { error: 'users_not_found' };
      throw err;
    },
  });
  const lookup = createUserLookup({ emailDomain: 'example.com', logger: fakeLogger() });

  assert.equal(await lookup.lookupUserByName(client, 'Ghost Person'), null);
  const callsAfterFirst = client.calls.length;
  assert.equal(await lookup.lookupUserByName(client, 'Ghost Person'), null);
  assert.equal(client.calls.length, callsAfterFirst, 'miss served from cache');
});

test('overrides route to configured ID before email derivation', async () => {
  const client = fakeWebClient({
    'users.info': ({ user }) => ({ ok: true, user: { id: user, real_name: 'Override', profile: {} } }),
  });
  const lookup = createUserLookup({
    emailDomain: 'example.com',
    overrides: { 'Adil Khan': 'U_OVERRIDE' },
    logger: fakeLogger(),
  });

  const user = await lookup.lookupUserByName(client, 'Adil Khan');
  assert.equal(user.id, 'U_OVERRIDE');
  assert.equal(client.calls[0].method, 'users.info');
});

test('testRecipient redirects all lookups and tags the result', async () => {
  const client = fakeWebClient({
    'users.info': () => ({ ok: true, user: { id: 'U_TEST', real_name: 'Test Rig', profile: {} } }),
  });
  const lookup = createUserLookup({
    emailDomain: 'example.com',
    testRecipient: 'U_TEST',
    logger: fakeLogger(),
  });

  const user = await lookup.lookupUserByName(client, 'Adil Khan');
  assert.equal(user.id, 'U_TEST');
  assert.equal(user._testMode, true);
  assert.equal(user._originalName, 'Adil Khan');
});

test('caches are isolated between instances', async () => {
  const clientA = fakeWebClient({
    'users.lookupByEmail': () => ({ ok: true, user: { id: 'U_A', real_name: 'A', profile: {} } }),
  });
  const clientB = fakeWebClient({
    'users.lookupByEmail': () => ({ ok: true, user: { id: 'U_B', real_name: 'B', profile: {} } }),
  });

  const lookupA = createUserLookup({ emailDomain: 'a.com', logger: fakeLogger() });
  const lookupB = createUserLookup({ emailDomain: 'b.com', logger: fakeLogger() });

  const a = await lookupA.lookupUserByName(clientA, 'Same Name');
  const b = await lookupB.lookupUserByName(clientB, 'Same Name');
  assert.equal(a.id, 'U_A');
  assert.equal(b.id, 'U_B', 'instance B must not see instance A cache');
});

test('lookupUsers returns a map of found users', async () => {
  const client = fakeWebClient({
    'users.lookupByEmail': ({ email }) => {
      if (email.startsWith('found.')) {
        return { ok: true, user: { id: 'U_F', real_name: 'Found', profile: { email } } };
      }
      const err = new Error('users_not_found');
      err.data = { error: 'users_not_found' };
      throw err;
    },
  });
  const lookup = createUserLookup({ emailDomain: 'example.com', logger: fakeLogger() });

  const results = await lookup.lookupUsers(client, ['Found Person', 'Missing Person']);
  assert.equal(results.size, 1);
  assert.equal(results.get('Found Person').id, 'U_F');
});
