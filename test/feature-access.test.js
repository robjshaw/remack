import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFeatureAccess, AccessEventType } from '../ext/feature-access.js';
import { memoryStorage } from '../lib/storage.js';
import { fakeLogger } from './fakes.js';

const FEATURES = {
  'report': { key: 'report', name: 'Reports', status: 'live', requiresAccess: false },
  'pilot-tool': { key: 'pilot_tool', name: 'Pilot Tool', status: 'pilot', requiresAccess: true, docsUrl: 'https://docs.example.com/pilot' },
  'secret-tool': { key: 'secret_tool', name: 'Secret Tool', status: 'coming_soon', requiresAccess: true },
};

function makeAccess(overrides = {}) {
  return createFeatureAccess({ storage: memoryStorage(), features: FEATURES, logger: fakeLogger(), ...overrides });
}

function failingStorage() {
  const fail = async () => { throw new Error('storage down'); };
  return { get: fail, put: fail, delete: fail, list: fail };
}

test('requires storage', () => {
  assert.throws(() => createFeatureAccess({ features: FEATURES }), /storage/);
});

test('live features allow everyone; unknown features denied', async () => {
  const access = makeAccess();
  assert.equal(await access.hasAccess('report', 'U1'), true);
  assert.equal(await access.hasAccess('nope', 'U1'), false);
});

test('grant → hasAccess → revoke lifecycle', async () => {
  const access = makeAccess();

  assert.equal(await access.hasAccess('pilot-tool', 'U1'), false);

  const first = await access.grantAccess('pilot-tool', 'U1', 'Target', 'U_G', 'Granter');
  assert.deepEqual(first, { success: true, alreadyHadAccess: false });
  assert.equal(await access.hasAccess('pilot-tool', 'U1'), true);

  const second = await access.grantAccess('pilot-tool', 'U1', 'Target', 'U_G', 'Granter');
  assert.deepEqual(second, { success: true, alreadyHadAccess: true });

  const revoked = await access.revokeAccess('pilot-tool', 'U1', 'U_R', 'Revoker');
  assert.deepEqual(revoked, { success: true, hadAccess: true });
  assert.equal(await access.hasAccess('pilot-tool', 'U1'), false);

  const again = await access.revokeAccess('pilot-tool', 'U1', 'U_R', 'Revoker');
  assert.deepEqual(again, { success: true, hadAccess: false });
});

test('getAccessList returns grants for one feature only', async () => {
  const access = makeAccess();
  await access.grantAccess('pilot-tool', 'U1', 'One', 'U_G', 'Granter');
  await access.grantAccess('pilot-tool', 'U2', 'Two', 'U_G', 'Granter');
  await access.grantAccess('secret-tool', 'U3', 'Three', 'U_G', 'Granter');

  const list = await access.getAccessList('pilot-tool');
  assert.deepEqual(list.map((entry) => entry.userId).sort(), ['U1', 'U2']);
  assert.equal(list[0].grantedBy, 'Granter');
  assert.ok(list[0].grantedAt);
});

test('failOpen governs behavior when storage errors', async () => {
  const open = makeAccess({ storage: failingStorage(), failOpen: true });
  assert.equal(await open.hasAccess('pilot-tool', 'U1'), true);

  const closed = makeAccess({ storage: failingStorage(), failOpen: false });
  assert.equal(await closed.hasAccess('pilot-tool', 'U1'), false);
});

test('access log feeds getAccessAnalytics with grouped counts', async () => {
  const access = makeAccess();
  await access.grantAccess('pilot-tool', 'U1', 'One', 'U_G', 'Granter');
  await access.logAccessDenied('pilot-tool', 'U2', 'Two', 'C1');
  await access.logAccessDenied('pilot-tool', 'U3', 'Three', 'C1');
  await access.logAccessDenied('secret-tool', 'U2', 'Two', 'C1');

  const analytics = await access.getAccessAnalytics(30);
  const denied = analytics.find((row) => row.featureKey === 'pilot_tool' && row.eventType === AccessEventType.ACCESS_DENIED);
  assert.equal(denied.eventCount, 2);
  assert.equal(denied.uniqueUsers, 2);

  const granted = analytics.find((row) => row.eventType === AccessEventType.ACCESS_GRANTED);
  assert.equal(granted.featureKey, 'pilot_tool');
});

test('buildNoAccessMessage includes docs link only when configured; override wins', () => {
  const access = makeAccess();

  assert.ok(JSON.stringify(access.buildNoAccessMessage('pilot-tool')).includes('docs.example.com'));
  assert.ok(!JSON.stringify(access.buildNoAccessMessage('secret-tool')).includes('Learn more'));
  assert.ok(JSON.stringify(access.buildNoAccessMessage('secret-tool')).includes('coming soon'));
  assert.equal(access.buildNoAccessMessage('nope').text, 'This feature is not available.');

  const custom = makeAccess({ buildNoAccessMessage: (cmd, config) => ({ text: `no ${cmd} (${config?.name})` }) });
  assert.equal(custom.buildNoAccessMessage('pilot-tool').text, 'no pilot-tool (Pilot Tool)');
});

test('buildAccessGrantedMessage covers both branches', () => {
  const access = makeAccess();
  assert.match(access.buildAccessGrantedMessage('pilot-tool', 'U1', true).text, /already has access/);
  assert.match(JSON.stringify(access.buildAccessGrantedMessage('pilot-tool', 'U1', false)), /Added <@U1>/);
});
